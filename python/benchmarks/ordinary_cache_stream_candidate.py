"""Benchmark-only ordinary cache streaming with combined key/value sharing."""
import json
import types
from pathlib import Path

from django_orm_intellisense.cache import store
from django_orm_intellisense.cache.json_stream import JsonStreamReader


class MetadataStreamReader(JsonStreamReader):
    def hook(self, value):
        # The supplied callback interns keys and metadata values in one pass.
        return self.original_hook(value)


def decode_metadata_stream(stream, string_fields):
    keys, strings = {}, {}
    key = keys.setdefault
    share = strings.setdefault

    def metadata(value):
        if 'filePath' in value:
            return {key(name, name): share(item, item)
                    if name in string_fields and type(item) is str else item
                    for name, item in value.items()}
        return {key(name, name): item for name, item in value.items()}

    return MetadataStreamReader(stream, metadata, object_depth=3).read()


def candidate_module(*, fused=True):
    source = Path(store.__file__).read_text()
    if 'decode_metadata_stream(raw_payload, _CACHE_STRING_FIELDS)' in source:
        module = types.ModuleType('django_orm_intellisense.cache._ordinary_stream_variant')
        module.__package__ = store.__package__
        if not fused:
            source = source.replace('decode_metadata_stream(raw_payload, _CACHE_STRING_FIELDS)',
                'decode_json_stream(raw_payload, metadata_strings, object_depth=3)')
        source = source.replace('elif cache_path.name == MODEL_GRAPH_CACHE_NAME:', 'else:')
        source = source.replace("        else:\n            payload = _decode_cache_payload(cache_path.read_text(encoding='utf-8'))", '')
        exec(compile(source, str(store.__file__) + ':ordinary_stream_variant', 'exec'), module.__dict__)
        return module
    old = 'return json.loads(raw_payload, object_hook=metadata_strings)'
    assert source.count(old) == 1
    if fused:
        source = source.replace(old, '''return (json.loads(raw_payload, object_hook=metadata_strings)
            if isinstance(raw_payload, (str, bytes, bytearray))
            else decode_metadata_stream(raw_payload, _CACHE_STRING_FIELDS))''')
    else:
        source = source.replace(old, '''return (json.loads(raw_payload, object_hook=metadata_strings)
            if isinstance(raw_payload, (str, bytes, bytearray))
            else decode_json_stream(raw_payload, metadata_strings, object_depth=3))''')
    old = "            payload = _decode_cache_payload(cache_path.read_text(encoding='utf-8'))"
    assert source.count(old) == 1
    source = source.replace(old, "            with cache_path.open('r', encoding='utf-8') as stream:\n"
        '                payload = _decode_cache_payload(stream)')
    module = types.ModuleType('django_orm_intellisense.cache._ordinary_stream_candidate')
    module.__package__ = store.__package__
    module.decode_metadata_stream = decode_metadata_stream
    exec(compile(source, str(store.__file__) + ':ordinary_stream_candidate', 'exec'), module.__dict__)
    return module


def previous_module():
    source = Path(store.__file__).read_text()
    if 'elif cache_path.name == MODEL_GRAPH_CACHE_NAME:' in source:
        source = source.replace("        elif cache_path.name == MODEL_GRAPH_CACHE_NAME:\n"
            "            with cache_path.open('r', encoding='utf-8') as stream:\n"
            '                payload = _decode_cache_payload(stream)\n', '')
    else:
        old = "            with cache_path.open('r', encoding='utf-8') as stream:\n                payload = _decode_cache_payload(stream)"
        assert source.count(old) == 1
        source = source.replace(old, "            payload = _decode_cache_payload(cache_path.read_text(encoding='utf-8'))")
    module = types.ModuleType('django_orm_intellisense.cache._ordinary_stream_previous')
    module.__package__ = store.__package__
    exec(compile(source, str(store.__file__) + ':ordinary_stream_previous', 'exec'), module.__dict__)
    return module


def graph_only_module():
    source = Path(store.__file__).read_text()
    if 'elif cache_path.name == MODEL_GRAPH_CACHE_NAME:' in source:
        module = types.ModuleType('django_orm_intellisense.cache._graph_only_stream_candidate')
        module.__package__ = store.__package__
        exec(compile(source, str(store.__file__) + ':graph_only_stream_candidate', 'exec'), module.__dict__)
        return module
    old = "            with cache_path.open('r', encoding='utf-8') as stream:\n                payload = _decode_cache_payload(stream)"
    assert source.count(old) == 1
    source = source.replace(old, "            if cache_path.name == MODEL_GRAPH_CACHE_NAME:\n"
        "                with cache_path.open('r', encoding='utf-8') as stream:\n"
        '                    payload = _decode_cache_payload(stream)\n'
        '            else:\n'
        "                payload = _decode_cache_payload(cache_path.read_text(encoding='utf-8'))")
    module = types.ModuleType('django_orm_intellisense.cache._graph_only_stream_candidate')
    module.__package__ = store.__package__
    exec(compile(source, str(store.__file__) + ':graph_only_stream_candidate', 'exec'), module.__dict__)
    return module
