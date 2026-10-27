"""Benchmark-only graph reader that reuses exact frozen static field values."""
import types
from pathlib import Path

from django_orm_intellisense.cache import store


HELPER = '''def _restore_graph_field(payload, static_index):
    if static_index is not None:
        label = payload.get('modelLabel')
        name = payload.get('name')
        if type(label) is str and type(name) is str:
            existing = static_index.find_field(label, name)
            if existing is not None and _field_candidate_to_cache_dict(existing) == payload:
                return existing
    return _field_candidate_from_cache_dict(payload)


'''


def candidate_module():
    source = Path(store.__file__).read_text()
    old = '''    runtime_fingerprint: str,
) -> ModelGraph | None:'''
    assert source.count(old) == 1
    source = source.replace(old, '''    runtime_fingerprint: str,
    *,
    static_index: StaticIndex | None = None,
) -> ModelGraph | None:''')
    old = 'return _model_graph_from_cache_dict(cached_payload)'
    assert source.count(old) == 1
    source = source.replace(old, 'return _model_graph_from_cache_dict(cached_payload, static_index=static_index)')
    old = 'def _model_graph_from_cache_dict(payload: dict[str, object]) -> ModelGraph:'
    assert source.count(old) == 1
    source = source.replace(old, HELPER + '''def _model_graph_from_cache_dict(payload: dict[str, object], *,
        static_index: StaticIndex | None = None) -> ModelGraph:''')
    old = 'str(field_name): _field_candidate_from_cache_dict(dict(field))'
    assert source.count(old) == 1
    source = source.replace(old, 'str(field_name): _restore_graph_field(dict(field), static_index)')
    module = types.ModuleType('django_orm_intellisense.cache._graph_reuse_candidate')
    module.__package__ = store.__package__
    exec(compile(source, str(store.__file__) + ':graph_reuse_candidate', 'exec'), module.__dict__)
    return module


def previous_module():
    source = Path(store.__file__).read_text()
    old = 'str(field_name): _restore_graph_field(dict(field), static_index)'
    assert source.count(old) == 1
    source = source.replace(old, 'str(field_name): _field_candidate_from_cache_dict(dict(field))')
    module = types.ModuleType('django_orm_intellisense.cache._graph_reuse_previous')
    module.__package__ = store.__package__
    exec(compile(source, str(store.__file__) + ':graph_reuse_previous', 'exec'), module.__dict__)
    return module
