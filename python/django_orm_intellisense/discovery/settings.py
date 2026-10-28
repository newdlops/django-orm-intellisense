"""Discover Django settings and retain their project/import ownership."""
from __future__ import annotations

import ast
import hashlib
from dataclasses import dataclass, replace
from pathlib import Path


@dataclass(frozen=True, slots=True)
class SettingsSource:
    selector: str
    module: str
    project_root: str
    file_path: str | None
    entrypoints: tuple[str, ...] = ()
    import_root: str | None = None

    def to_dict(self) -> dict[str, object]:
        return {
            'selector': self.selector,
            'module': self.module,
            'projectRoot': self.project_root,
            'filePath': self.file_path,
            'entrypoints': list(self.entrypoints),
            'importRoot': self.import_root or self.project_root,
        }


@dataclass(frozen=True, slots=True)
class SettingsProject:
    root: str
    import_root: str
    settings_module: str | None
    selector: str | None
    namespace: str
    candidates: tuple[str, ...]
    group_namespace: str | None = None

    def to_dict(self) -> dict[str, object]:
        return {
            'root': self.root, 'importRoot': self.import_root,
            'settingsModule': self.settings_module, 'selector': self.selector,
            'namespace': self.namespace, 'candidates': list(self.candidates),
            'groupNamespace': self.group_namespace or self.namespace,
        }


def _settings_profiles(candidates, selected):
    """Find complete Django settings, retaining inherited fragments as sources.

    Plain settings.py files from unrelated services are not Django registries.
    Imported common/base modules are covered by their concrete consumers; they
    are not configured independently unless explicitly declared/selected.
    """
    by_module = {source.module: source for source in candidates}
    apps, imports, malformed = set(), {}, set()
    for source in candidates:
        references = set()
        try:
            tree = ast.parse(Path(source.file_path).read_text(encoding='utf-8-sig')) if source.file_path else None
        except (OSError, UnicodeError, SyntaxError, RecursionError):
            tree = None
            malformed.add(source.module)
        for node in ast.walk(tree) if tree else ():
            targets = node.targets if isinstance(node, ast.Assign) else [node.target] if isinstance(node, (ast.AnnAssign, ast.AugAssign)) else ()
            if any(isinstance(target, ast.Name) and target.id == 'INSTALLED_APPS' for target in targets):
                apps.add(source.module)
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and isinstance(node.func.value, ast.Name) and node.func.value.id == 'INSTALLED_APPS'):
                apps.add(source.module)
            if isinstance(node, ast.ImportFrom) and any(alias.name in ('*', 'INSTALLED_APPS') for alias in node.names):
                module = node.module or ''
                if node.level:
                    package = source.module if source.file_path and Path(source.file_path).name == '__init__.py' else source.module.rpartition('.')[0]
                    parts = package.split('.')
                    prefix = parts[:len(parts) - node.level + 1]
                    module = '.'.join((*prefix, *((node.module or '').split('.') if node.module else ())))
                if module in by_module:
                    references.add(module)
        imports[source.module] = references
    while True:
        expanded = apps | {module for module, references in imports.items() if references & apps}
        if expanded == apps:
            break
        apps = expanded
    inherited = {reference for module, references in imports.items() if module in apps for reference in references}
    profiles = [source for source in candidates if source.entrypoints or source is selected
                or source.module in apps and source.module not in inherited
                or source.module in malformed and source.file_path and Path(source.file_path).name == 'settings.py']
    return tuple(dict.fromkeys(profiles or [source for source in candidates if source.module in apps]))


def settings_projects(root: Path, sources: tuple[SettingsSource, ...],
                      override: str | None = None) -> tuple[SettingsProject, ...]:
    """Collect every concrete settings registry; a declared default only orders it."""
    grouped: dict[str, list[SettingsSource]] = {}
    for source in sources:
        grouped.setdefault(source.project_root, []).append(source)
    projects = []
    for project_root, candidates in sorted(grouped.items()):
        explicit = next((source for source in candidates if override in (source.selector, source.module)), None) if override else None
        declared = [source for source in candidates if source.entrypoints]
        if declared:
            declared.sort(key=lambda source: min(
                (0 if Path(entry).name == 'manage.py' else 1 if Path(entry).name == 'wsgi.py' else 2,
                 len(Path(entry).parts), entry) for entry in source.entrypoints))
        selected = explicit or (declared[0] if declared else candidates[0] if len(candidates) == 1 else None)
        relative = Path(project_root).relative_to(root).as_posix()
        namespace = 'project_' + hashlib.sha256(relative.encode('utf-8')).hexdigest()[:16]
        profiles = _settings_profiles(candidates, selected)
        if selected in profiles:
            profiles = (selected, *(source for source in profiles if source is not selected))
        if not profiles:
            projects.append(SettingsProject(project_root, project_root, None, None, namespace,
                tuple(source.selector for source in candidates), namespace))
        for index, source in enumerate(profiles):
            profile_namespace = namespace if index == 0 else namespace + '_settings_' + hashlib.sha256(
                source.selector.encode('utf-8')).hexdigest()[:12]
            projects.append(SettingsProject(project_root, source.import_root or project_root,
                source.module, source.selector, profile_namespace,
                tuple(candidate.selector for candidate in candidates), namespace))
    return tuple(projects)


def _module_name(root: Path, path: Path) -> str:
    relative = path.relative_to(root)
    parts = relative.parent.parts if path.name == '__init__.py' else relative.with_suffix('').parts
    return '.'.join(parts)


def read_declared_settings(path: Path) -> tuple[str, ...]:
    """Read declarations without importing settings or executing an entrypoint."""
    try:
        tree = ast.parse(path.read_text(encoding='utf-8-sig'), filename=str(path))
    except (OSError, UnicodeError, SyntaxError, RecursionError):
        return ()
    os_names, environ_names, constants = {'os'}, set(), {}
    for node in tree.body:
        if isinstance(node, ast.Import):
            os_names.update(alias.asname or alias.name for alias in node.names if alias.name == 'os')
        elif isinstance(node, ast.ImportFrom) and node.module == 'os':
            environ_names.update(alias.asname or alias.name for alias in node.names if alias.name == 'environ')
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                for target in targets:
                    if isinstance(target, ast.Name):
                        constants[target.id] = node.value.value

    def is_environment(node):
        return (isinstance(node, ast.Name) and node.id in environ_names) or (
            isinstance(node, ast.Attribute) and node.attr == 'environ'
            and isinstance(node.value, ast.Name) and node.value.id in os_names)

    def literal(node):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        if isinstance(node, ast.Name):
            return constants.get(node.id)
        return None

    values = []
    for node in ast.walk(tree):
        value = None
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == 'setdefault' and is_environment(node.func.value)
                and len(node.args) >= 2 and literal(node.args[0]) == 'DJANGO_SETTINGS_MODULE'):
            value = literal(node.args[1])
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            if any(isinstance(target, ast.Subscript) and is_environment(target.value)
                   and literal(target.slice) == 'DJANGO_SETTINGS_MODULE' for target in targets):
                value = literal(node.value)
        if value and all(part.isidentifier() for part in value.split('.')):
            values.append(value)
    return tuple(dict.fromkeys(values))


def discover_settings_sources(root: Path, python_files) -> tuple[SettingsSource, ...]:
    # Editable dependencies can be included in the source snapshot. Their
    # settings do not belong to this repository's project inventory.
    files = tuple(dict.fromkeys(path for path in python_files if path.is_relative_to(root)))
    file_set = set(files)
    manage_roots = {path.parent for path in files if path.name == 'manage.py'}
    project_roots = set(manage_roots)
    sources: dict[str, SettingsSource] = {}

    def project_root(path):
        managed = next((parent for parent in path.parents if parent in manage_roots), None)
        if managed is not None:
            return managed
        settings_directory = next((parent for parent in path.parents if parent.name == 'settings'
                                   and parent.is_relative_to(root)), None)
        package = settings_directory.parent if settings_directory is not None else path.parent
        inferred = package.parent
        return inferred if inferred.is_relative_to(root) else root

    for path in files:
        parts = path.relative_to(root).parts
        if path.name != 'settings.py' and 'settings' not in parts[:-1]:
            continue
        owner = project_root(path)
        selector = _module_name(root, path)
        sources[selector] = SettingsSource(selector, _module_name(owner, path), str(owner), str(path),
                                           import_root=str(owner))

    entries = sorted((path for path in files if path.name in ('manage.py', 'wsgi.py', 'asgi.py')),
        key=lambda path: (len(path.relative_to(root).parts),
                          ('manage.py', 'wsgi.py', 'asgi.py').index(path.name), str(path)))
    for entry in entries:
        for module in read_declared_settings(entry):
            owner = project_root(entry)
            import_root = owner
            found = None
            # A nested manage/wsgi/asgi often uses an unqualified local module.
            # Resolve it against its own source tree before repository ancestors.
            for parent in entry.parents:
                if not parent.is_relative_to(root):
                    break
                for search_root in (parent, parent / 'src'):
                    base = search_root.joinpath(*module.split('.'))
                    found = next((candidate for candidate in (base.with_suffix('.py'), base / '__init__.py')
                                  if candidate in file_set), None)
                    if found is not None:
                        import_root = search_root
                        break
                if found is not None:
                    if owner == root and not any(ancestor in manage_roots for ancestor in entry.parents):
                        owner = parent
                    break
            if found is None:
                # Preserve declared nonstandard modules even when their source
                # is generated or supplied by the selected interpreter.
                if entry.name == 'manage.py':
                    owner = entry.parent
                import_root = owner
                prefix = '.'.join(owner.relative_to(root).parts)
                selector = '.'.join(part for part in (prefix, module) if part)
            else:
                selector = _module_name(root, found)
                if not found.is_relative_to(owner):
                    prefix = '.'.join(owner.relative_to(root).parts)
                    selector = '.'.join(part for part in (prefix, module) if part)
            project_roots.add(owner)
            previous = sources.get(selector)
            declarations = (*previous.entrypoints, str(entry)) if previous else (str(entry),)
            sources[selector] = SettingsSource(selector, module, str(owner),
                str(found) if found is not None else previous.file_path if previous else None,
                tuple(dict.fromkeys(declarations)), str(import_root))
    # ASGI/WSGI-only projects have no manage.py. Once their entrypoint resolved
    # an import root, retain that ownership for all neighbouring variants too.
    for selector, source in tuple(sources.items()):
        if source.entrypoints or source.file_path is None:
            continue
        path = Path(source.file_path)
        owner = next((parent for parent in path.parents if parent in project_roots), Path(source.project_root))
        declared_roots = {Path(candidate.import_root or candidate.project_root)
            for candidate in sources.values() if candidate.entrypoints and candidate.project_root == str(owner)}
        import_root = next((parent for parent in path.parents if parent in declared_roots), owner)
        sources[selector] = replace(source, project_root=str(owner), import_root=str(import_root),
                                    module=_module_name(import_root, path))
    return tuple(sources.values())
