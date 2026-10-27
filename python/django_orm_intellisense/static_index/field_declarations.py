"""Bounded, non-executing snapshots of local field constructor dependencies."""
from __future__ import annotations

import ast
import copy
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from .source_cache import latest_source_cache

_DYNAMIC_STATEMENTS = tuple(getattr(ast, name) for name in (
    'If', 'Try', 'TryStar', 'For', 'AsyncFor', 'While', 'With', 'AsyncWith', 'Match')
    if hasattr(ast, name))


class UnresolvedName(ast.expr):
    _fields = ('name',)

    def __init__(self, name: str = ''):
        self.name = name


class ImportedReference(ast.expr):
    _fields = ('qualified',)

    def __init__(self, qualified: str = ''):
        self.qualified = qualified


@dataclass(frozen=True)
class DeclarationContext:
    bindings: dict[str, ast.expr]
    aliases: dict[str, str]


def _mutable_origins(value: ast.AST) -> set[object]:
    origins = set()
    def visit(child: ast.AST) -> None:
        if isinstance(child, (ast.List, ast.Dict, ast.Set)):
            origins.add(getattr(child, '_mutable_origin', child))
        if isinstance(child, ImportedReference):
            origins.add(('import', child.qualified))
            return
        if isinstance(child, ast.Attribute):
            parts = []
            root = child
            while isinstance(root, ast.Attribute):
                parts.append(root.attr)
                root = root.value
            if isinstance(root, ImportedReference):
                origins.add(('import', root.qualified + '.' + '.'.join(reversed(parts))))
                return
        for nested in ast.iter_child_nodes(child):
            visit(nested)
    try:
        visit(value)
        return origins
    finally:
        visit = None


def _capture_mutable_origins(value: ast.AST) -> None:
    for child in ast.walk(value):
        if isinstance(child, (ast.List, ast.Dict, ast.Set)) and not hasattr(child, '_mutable_origin'):
            child._mutable_origin = object()


def _mutated_bindings(bindings: dict[str, ast.expr], target: ast.AST,
                      aliases: dict[str, str]) -> set[str]:
    names = {child.id for child in ast.walk(target) if isinstance(child, ast.Name)}
    origins = set()
    for name in names:
        if name in bindings:
            origins.update(_mutable_origins(bindings[name]))
    origins.update(_mutable_origins(normalize_declaration(target, DeclarationContext(bindings, aliases), capture=True)))
    return (names | {name for name, value in bindings.items() if _mutable_origins(value) & origins}
            | {name for name, qualified in aliases.items() if ('import', qualified) in origins})


def normalize_declaration(node: ast.expr, context: DeclarationContext, *, capture: bool = False) -> ast.expr:
    """Inline earlier bindings without executing calls or reading imported objects.

    Assignment snapshots freeze names at assignment time. A later assignment or
    import cannot turn an unresolved earlier expression into a supported value.
    """
    if not context.bindings and not capture:
        return node
    remaining = 4096

    def visit(value: ast.AST, depth: int = 0, *, frozen: bool = False) -> ast.AST:
        nonlocal remaining
        remaining -= 1
        if remaining < 0 or depth > 64:
            raise ValueError('Field constant expansion limit')
        if isinstance(value, ast.Name) and not frozen:
            if value.id in context.bindings:
                return visit(context.bindings[value.id], depth + 1, frozen=True)
            if capture:
                qualified = context.aliases.get(value.id)
                if qualified:
                    return ImportedReference(qualified)
                return UnresolvedName(value.id)
        updated = copy.copy(value)
        for name, child in ast.iter_fields(value):
            if isinstance(child, ast.AST):
                setattr(updated, name, visit(child, depth + 1, frozen=frozen))
            elif isinstance(child, list):
                setattr(updated, name, [visit(item, depth + 1, frozen=frozen)
                    if isinstance(item, ast.AST) else item for item in child])
        return updated

    try:
        return visit(node)
    except ValueError:
        return UnresolvedName('expansion_limit')
    finally:
        visit = None


def class_field_contexts(node: ast.ClassDef, outer: DeclarationContext) -> Iterator[tuple[ast.stmt, DeclarationContext]]:
    """Do not substitute a module constant hidden by an earlier class member."""
    context = outer
    for statement in node.body:
        yield statement, context
        targets: list[ast.AST] = []
        value = None
        if isinstance(statement, (ast.Assign, ast.AnnAssign)) and statement.value is not None:
            targets = statement.targets if isinstance(statement, ast.Assign) else [statement.target]
            if not isinstance(statement.value, ast.Call):
                value = normalize_declaration(statement.value, context, capture=True)
                _capture_mutable_origins(value)
        elif isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            targets = [ast.Name(id=statement.name)]
        elif isinstance(statement, (ast.AugAssign, ast.Delete)):
            targets = statement.targets if isinstance(statement, ast.Delete) else [statement.target]
        mutation_targets = []
        if isinstance(statement, (ast.Assign, ast.AnnAssign)):
            mutation_targets = [target for target in targets if isinstance(target, (ast.Subscript, ast.Attribute))]
        elif isinstance(statement, ast.AugAssign):
            mutation_targets = targets
        elif isinstance(statement, ast.Delete):
            mutation_targets = [target for target in targets if not isinstance(target, ast.Name)]
        elif (isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Call)
              and isinstance(statement.value.func, ast.Attribute)):
            mutation_targets = [statement.value.func.value]
        elif isinstance(statement, _DYNAMIC_STATEMENTS):
            def dynamic_targets(node: ast.AST) -> None:
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    return
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                    mutation_targets.append(node.func.value)
                elif isinstance(node, ast.AugAssign):
                    mutation_targets.append(node.target)
                elif isinstance(node, (ast.Assign, ast.AnnAssign, ast.Delete)):
                    targets = node.targets if isinstance(node, (ast.Assign, ast.Delete)) else [node.target]
                    mutation_targets.extend(targets)
                for nested in ast.iter_child_nodes(node):
                    dynamic_targets(nested)
            try:
                dynamic_targets(statement)
            finally:
                dynamic_targets = None
        if mutation_targets:
            bindings, aliases = dict(context.bindings), dict(context.aliases)
            for target in mutation_targets:
                for name in _mutated_bindings(bindings, target, aliases):
                    bindings[name] = UnresolvedName(name)
                    aliases.pop(name, None)
            context = DeclarationContext(bindings, aliases)
        for target in targets:
            for name in (child.id for child in ast.walk(target) if isinstance(child, ast.Name)):
                if value is None and name not in context.bindings and name not in context.aliases:
                    continue
                bindings, aliases = dict(context.bindings), dict(context.aliases)
                bindings[name] = value if isinstance(target, ast.Name) and value is not None else UnresolvedName(name)
                aliases.pop(name, None)
                context = DeclarationContext(bindings, aliases)


def class_declaration_contexts(tree: ast.Module, *, module_name: str = '',
                               is_package_init: bool = False,
                               final_context: list[DeclarationContext] | None = None) -> dict[ast.ClassDef, DeclarationContext]:
    """Snapshot top-level assignments and resolved imports before each class."""
    bindings: dict[str, ast.expr] = {}
    aliases: dict[str, str] = {}
    contexts: dict[ast.ClassDef, DeclarationContext] = {}

    def invalidate_mutation(target: ast.AST) -> None:
        # Captured assignment snapshots copy AST nodes but retain their origin
        # tokens. Rebinding an alias has a new origin and cannot poison the old
        # object; container views share the old origin and must become unknown.
        for name in _mutated_bindings(bindings, target, aliases):
            bindings[name] = UnresolvedName(name)
        invalidate_targets([target])

    def invalidate_targets(targets: list[ast.AST]) -> None:
        for target in targets:
            for child in ast.walk(target):
                if isinstance(child, ast.Name):
                    bindings[child.id] = UnresolvedName(child.id)
                    aliases.pop(child.id, None)

    def invalidate_dynamic(node: ast.AST) -> None:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            invalidate_targets([ast.Name(id=node.name)])
            return
        if isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign, ast.Delete, ast.NamedExpr)):
            targets = node.targets if isinstance(node, (ast.Assign, ast.Delete)) else [node.target]
            for target in targets:
                if isinstance(target, (ast.Subscript, ast.Attribute)) or isinstance(node, ast.AugAssign):
                    invalidate_mutation(target)
                else:
                    invalidate_targets([target])
        elif (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
            invalidate_mutation(node.func.value)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            invalidate_targets([ast.Name(id=item.asname or item.name.split('.')[0]) for item in node.names])
        for child in ast.iter_child_nodes(node):
            invalidate_dynamic(child)

    try:
        for node in tree.body:
            if isinstance(node, ast.ClassDef):
                contexts[node] = DeclarationContext(dict(bindings), dict(aliases))
                if node.name in bindings or node.name in aliases:
                    bindings[node.name] = UnresolvedName(node.name)
                aliases.pop(node.name, None)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if node.name in bindings or node.name in aliases:
                    bindings[node.name] = UnresolvedName(node.name)
                aliases.pop(node.name, None)
            elif isinstance(node, (ast.Assign, ast.AnnAssign)) and node.value is not None:
                value = normalize_declaration(node.value, DeclarationContext(bindings, aliases), capture=True)
                _capture_mutable_origins(value)
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                for target in targets:
                    if isinstance(target, ast.Name):
                        bindings[target.id] = value
                        aliases.pop(target.id, None)
                    else:
                        invalidate_mutation(target)
            elif isinstance(node, (ast.Import, ast.ImportFrom)):
                for item in node.names:
                    name = item.asname or item.name.split('.')[0]
                    if item.name == '*':
                        continue
                    bindings.pop(name, None)
                    if isinstance(node, ast.Import):
                        aliases[name] = item.name if item.asname else item.name.split('.')[0]
                    elif node.module or node.level:
                        imported_module = node.module or ''
                        if node.level:
                            package = module_name if is_package_init else module_name.rpartition('.')[0]
                            parts = package.split('.') if package else []
                            if node.level > len(parts):
                                aliases.pop(name, None)
                                bindings[name] = UnresolvedName(name)
                                continue
                            imported_module = '.'.join(parts[:len(parts) - node.level + 1]
                                                       + ([imported_module] if imported_module else []))
                        aliases[name] = f'{imported_module}.{item.name}'
                    else:
                        aliases.pop(name, None)
                        bindings[name] = UnresolvedName(name)
            elif isinstance(node, (ast.AugAssign, ast.Delete)):
                for target in (node.targets if isinstance(node, ast.Delete) else [node.target]):
                    if isinstance(node, ast.AugAssign) or isinstance(target, (ast.Subscript, ast.Attribute)):
                        invalidate_mutation(target)
                    else:
                        invalidate_targets([target])
            elif (isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)
                  and isinstance(node.value.func, ast.Attribute)):
                # Mutable containers can be changed without rebinding their name.
                # Conservatively invalidate the receiver of an arbitrary method.
                invalidate_mutation(node.value.func.value)
            elif isinstance(node, _DYNAMIC_STATEMENTS):
                invalidate_dynamic(node)
        if final_context is not None:
            final_context.append(DeclarationContext(dict(bindings), dict(aliases)))
        return contexts
    finally:
        invalidate_dynamic = None


def imported_references(node: ast.expr, context: DeclarationContext) -> tuple[str, ...]:
    """Capture source imports, including aliases frozen by earlier assignments."""
    if (not any(not qualified.startswith('django.') for qualified in context.aliases.values())
            and not any(isinstance(child, ImportedReference) and not child.qualified.startswith('django.')
                        for value in (*context.bindings.values(), node) for child in ast.walk(value))):
        return ()
    captured = normalize_declaration(node, context, capture=True)
    result = set()
    def walk(value: ast.AST) -> None:
        if isinstance(value, ImportedReference):
            result.add(value.qualified)
            return
        if isinstance(value, ast.Attribute):
            parts = []
            root = value
            while isinstance(root, ast.Attribute):
                parts.append(root.attr)
                root = root.value
            if isinstance(root, ImportedReference):
                result.add(root.qualified + '.' + '.'.join(reversed(parts)))
                return
        for child in ast.iter_child_nodes(value):
            walk(child)
    try:
        walk(captured)
        return tuple(sorted(result))
    finally:
        walk = None


def source_stat_key(source_stat) -> tuple[int, int, int, int, int]:
    """Detect rewrites and replacements even when source mtime is restored."""
    return (source_stat.st_mtime_ns, source_stat.st_size, source_stat.st_ctime_ns,
            source_stat.st_dev, source_stat.st_ino)


@latest_source_cache(maxsize=256, stamp_index=1)
def _module_constants(file_path: str, source_stamp: tuple[int, ...], module_name: str, is_package: bool) -> DeclarationContext:
    tree = ast.parse(Path(file_path).read_text(encoding='utf-8'))
    final = []
    class_declaration_contexts(tree, module_name=module_name, is_package_init=is_package, final_context=final)
    return final[0]


def resolve_imported_constant(qualified: str, module_files: dict[str, tuple[str, bool]],
                              visited: tuple[str, ...] = (), budget: list[int] | None = None) -> ast.expr | None:
    """Resolve bounded workspace declarations without importing or executing them."""
    if qualified in visited or len(visited) >= 16:
        return None
    if budget is None:
        budget = [4096]
    budget[0] -= 1
    if budget[0] < 0:
        return None
    module_name, _, symbol = qualified.rpartition('.')
    location = module_files.get(module_name)
    if location is None:
        return None
    visit = None
    try:
        path = Path(location[0])
        stat = path.stat()
        context = _module_constants(str(path), source_stat_key(stat), module_name, location[1])
        if symbol in context.bindings:
            value = context.bindings[symbol]
        elif symbol in context.aliases:
            value = ImportedReference(context.aliases[symbol])
        else:
            return None
        def visit(value: ast.AST, depth: int = 0) -> ast.AST:
            budget[0] -= 1
            if budget[0] < 0 or depth > 64:
                raise ValueError('Imported constant expansion limit')
            if isinstance(value, ImportedReference):
                return resolve_imported_constant(value.qualified, module_files, visited + (qualified,), budget) or value
            if isinstance(value, ast.Attribute):
                references = imported_references(value, DeclarationContext({}, {}))
                if references:
                    resolved = resolve_imported_constant(references[0], module_files, visited + (qualified,), budget)
                    if resolved is not None:
                        return resolved
            updated = copy.copy(value)
            for name, child in ast.iter_fields(value):
                if isinstance(child, ast.AST):
                    setattr(updated, name, visit(child, depth + 1))
                elif isinstance(child, list):
                    setattr(updated, name, [visit(item, depth + 1) if isinstance(item, ast.AST) else item for item in child])
            return updated
        return visit(value)
    except (OSError, SyntaxError, UnicodeError, ValueError):
        return None
    finally:
        visit = None
