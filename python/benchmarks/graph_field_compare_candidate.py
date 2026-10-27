"""Candidate-only complete field equality without constructing its wire dict."""
import types
import sys
from pathlib import Path

from django_orm_intellisense.cache import store


def field_matches(field, payload):
    return (len(payload) == 16
        and payload.get('modelLabel', ...) == field.model_label
        and payload.get('name', ...) == field.name
        and payload.get('filePath', ...) == field.file_path
        and payload.get('line', ...) == field.line
        and payload.get('column', ...) == field.column
        and payload.get('fieldKind', ...) == field.field_kind
        and payload.get('isRelation', ...) == field.is_relation
        and payload.get('relationDirection', ...) == field.relation_direction
        and payload.get('relatedModelLabel', ...) == field.related_model_label
        and payload.get('source', ...) == field.source
        and payload.get('constructorFingerprint', ...) == field.constructor_fingerprint
        and payload.get('declarationModule', ...) == field.declaration_module
        and payload.get('declaredModelLabel', ...) == field.declared_model_label
        and payload.get('relatedName', ...) == field.related_name
        and payload.get('relatedQueryName', ...) == field.related_query_name
        and type(payload.get('importedConstants')) is list
        and len(payload['importedConstants']) == len(field.imported_constants)
        and all(type(pair) is list and len(pair) == 2 and pair[0] == expected[0] and pair[1] == expected[1]
                for pair, expected in zip(payload['importedConstants'], field.imported_constants)))


def candidate_module():
    source = Path(store.__file__).read_text()
    old = '_field_candidate_to_cache_dict(existing) == payload'
    assert source.count(old) == 1
    source = source.replace(old, '_graph_field_matches(existing, payload)')
    module = types.ModuleType('django_orm_intellisense.cache._graph_compare_candidate')
    module.__package__ = store.__package__
    module._graph_field_matches = field_matches
    sys.modules[module.__name__] = module
    try:
        exec(compile(source, str(store.__file__) + ':graph_compare_candidate', 'exec'), module.__dict__)
    finally:
        sys.modules.pop(module.__name__, None)
    return module
