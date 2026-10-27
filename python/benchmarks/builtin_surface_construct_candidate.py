"""Candidate cache builds feed existing shared builtin templates directly."""
import ast
import importlib.util
import inspect
import sys
from pathlib import Path

from django_orm_intellisense.features import orm_members


def previous_source():
    source = Path(orm_members.__file__).read_text()
    old = '                surface = _compact_member_surface('
    assert source.count(old) == 1
    source = source.replace(old, '                surface = _member_surface(')
    lines = source.splitlines(keepends=True)
    removals = []
    for node in ast.parse(source).body:
        if isinstance(node, ast.FunctionDef) and node.name in (
                '_builtin_method_items', '_builtin_instance_method_items'):
            branches = [child for child in node.body if isinstance(child, ast.If)
                        and ast.unparse(child.test) == '_compact_builtin_items.get()']
            assert len(branches) == 1
            branch = branches[0]
            removals.append((branch.lineno - 1, branch.end_lineno))
    assert len(removals) == 2
    for start, end in sorted(removals, reverse=True):
        del lines[start:end]
    return ''.join(lines)


def candidate_module(previous=False):
    source = Path(orm_members.__file__).read_text()
    if 'def _compact_member_surface(' in source:
        if not previous:
            return orm_members
        name = 'django_orm_intellisense.features._builtin_surface_construct_previous'
        spec = importlib.util.spec_from_file_location(name, orm_members.__file__)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        exec(compile(previous_source(), str(orm_members.__file__) + ':previous_builtin_construct', 'exec'), module.__dict__)
        return module
    assert not previous
    old = '                surface = _member_surface('
    assert source.count(old) == 1
    source = source.replace(old, '                surface = _compact_member_surface(')
    old = '    has_manager: bool\n\n\n@lru_cache(maxsize=512)'
    assert source.count(old) == 1
    source = source.replace(old, '    has_manager: bool\n\n'
        '    @property\n    def name(self):\n        return self.item.name\n\n\n@lru_cache(maxsize=512)')
    marker = 'class _CachedMemberSurface(Sequence[OrmMemberItem]):'
    assert source.count(marker) == 1
    source = source.replace(marker, '''_compact_builtin_items = ContextVar('compact_builtin_items', default=False)


def _compact_member_surface(**kwargs):
    token = _compact_builtin_items.set(True)
    try:
        return _member_surface(**kwargs)
    finally:
        _compact_builtin_items.reset(token)


''' + marker)
    old = inspect.getsource(orm_members._builtin_method_items)
    marker = '    return [\n'
    assert old.count(marker) == 1
    new = old.replace(marker, '''    if _compact_builtin_items.get():
        return [_builtin_member_template(
            name, 'method', receiver_kind, detail, return_kind, None, None, None,
            None, False, _all_builtins[name].signature if name in _all_builtins else None,
            return_kind in {'instance', 'manager', 'queryset'}, manager_name is not None)
            for name, (detail, return_kind) in sorted(definitions.items())
            if django_builtin_available(name, runtime.django_version)]
''' + marker)
    assert source.count(old) == 1
    source = source.replace(old, new)
    old = inspect.getsource(orm_members._builtin_instance_method_items)
    assert old.count(marker) == 1
    new = old.replace(marker, '''    if _compact_builtin_items.get():
        return [_builtin_member_template(
            name, 'method', 'instance', detail, return_kind, None, None, None,
            None, False, _INSTANCE_BUILTINS[name].signature if name in _INSTANCE_BUILTINS else None,
            return_kind == 'instance', False)
            for name, (detail, return_kind) in sorted(BUILTIN_INSTANCE_METHODS.items())]
''' + marker)
    assert source.count(old) == 1
    source = source.replace(old, new)
    name = 'django_orm_intellisense.features._builtin_surface_construct_candidate'
    spec = importlib.util.spec_from_file_location(name, orm_members.__file__)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    exec(compile(source, str(orm_members.__file__) + ':builtin_construct', 'exec'), module.__dict__)
    return module
