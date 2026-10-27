"""Source-controlled previous/candidate model lookup without production mutation."""
import ast
import importlib.util
import sys
from pathlib import Path

from django_orm_intellisense.features import orm_members


def candidate_source():
    source = Path(orm_members.__file__).read_text()
    if hasattr(orm_members, '_runtime_model_catalogs'):
        return source
    marker = '\ndef _with_runtime_source_paths(function):\n'
    assert source.count(marker) == 1
    source = source.replace(marker, '''
_runtime_model_catalogs: ContextVar[dict | None] = ContextVar(
    'orm_member_runtime_model_catalogs', default=None)

''' + marker)
    old = '        candidates_token = _runtime_callable_candidates.set({})\n'
    assert source.count(old) == 1
    source = source.replace(old, old + '        catalogs_token = _runtime_model_catalogs.set({})\n')
    old = '            _runtime_callable_candidates.reset(candidates_token)\n'
    assert source.count(old) == 1
    source = source.replace(old, '            _runtime_model_catalogs.reset(catalogs_token)\n' + old)
    old = '''    runtime_model = next(
        (candidate for candidate in runtime.model_catalog if candidate.label == model_label),
        None,
    )
'''
    assert source.count(old) == 1
    source = source.replace(old, '''    catalogs = _runtime_model_catalogs.get()
    if catalogs is None:
        runtime_model = next(
            (candidate for candidate in runtime.model_catalog if candidate.label == model_label),
            None,
        )
    else:
        catalog = runtime.model_catalog
        cached = catalogs.get(id(catalog))
        if cached is None:
            models = {}
            for candidate in catalog:
                models.setdefault(candidate.label, candidate)
            # Keep the tuple alive with its map, including nested builds for
            # other runtimes. The first matching summary retains precedence.
            cached = (catalog, models)
            catalogs[id(catalog)] = cached
        runtime_model = cached[1].get(model_label)
''')
    return source


def previous_source():
    source = Path(orm_members.__file__).read_text()
    nodes = [node for node in ast.parse(source).body
             if isinstance(node, ast.FunctionDef) and node.name == '_manager_names']
    assert len(nodes) == 1
    node = nodes[0]
    assert ast.unparse(node.body[0]) == 'catalogs = _runtime_model_catalogs.get()'
    assert isinstance(node.body[1], ast.If)
    assert ast.unparse(node.body[1].test) == 'catalogs is None'
    lines = source.splitlines(keepends=True)
    lines[node.body[0].lineno - 1:node.body[1].end_lineno] = ['''    runtime_model = next(
        (candidate for candidate in runtime.model_catalog if candidate.label == model_label),
        None,
    )
''']
    source = ''.join(lines)
    for old in ('        catalogs_token = _runtime_model_catalogs.set({})\n',
                '            _runtime_model_catalogs.reset(catalogs_token)\n'):
        assert source.count(old) == 1
        source = source.replace(old, '')
    return source


def candidate_module(previous=False):
    if hasattr(orm_members, '_runtime_model_catalogs') and not previous:
        return orm_members
    name = 'django_orm_intellisense.features._runtime_manager_map_' + ('previous' if previous else 'candidate')
    spec = importlib.util.spec_from_file_location(name, orm_members.__file__)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    source = previous_source() if previous else candidate_source()
    exec(compile(source, str(orm_members.__file__) + ':manager_map', 'exec'), module.__dict__)
    return module
