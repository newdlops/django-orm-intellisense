"""Candidate-only path-aware static module hydration during JSON reading."""
import importlib.util
import json
import sys
import types
from pathlib import Path

from django_orm_intellisense.cache import store
from django_orm_intellisense.cache.json_stream import JsonStreamReader
from django_orm_intellisense.static_index import indexer


def candidate_module():
    source = Path(indexer.__file__).read_text()
    if '_restored_modules: bool = False' in source:
        return types.SimpleNamespace(StaticIndex=indexer.StaticIndex, ModuleIndex=indexer.ModuleIndex)
    old = 'str(module_name): ModuleIndex.from_dict(dict(module_payload))'
    new = ('str(module_name): (module_payload if type(module_payload) is ModuleIndex '
           'else ModuleIndex.from_dict(dict(module_payload)))')
    assert source.count(old) == 1
    source = source.replace(old, new)
    old = 'if isinstance(module_payload, dict)'
    assert source.count(old) == 1
    source = source.replace(old, old + ' or type(module_payload) is ModuleIndex')
    name = 'django_orm_intellisense.static_index._stream_restore_candidate'
    spec = importlib.util.spec_from_file_location(name, indexer.__file__)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    exec(compile(source, str(indexer.__file__) + ':stream_restore', 'exec'), module.__dict__)
    return module


class StaticStreamReader(JsonStreamReader):
    def __init__(self, stream, module_type, chunk_size=262144):
        self.strings = {}
        self.module_type = module_type
        super().__init__(stream, lambda value: value, chunk_size=chunk_size)

    def hook(self, value):
        key, share = self.keys.setdefault, self.strings.setdefault
        if 'filePath' in value:
            return {key(name, name): share(item, item)
                    if name in store._CACHE_STRING_FIELDS and type(item) is str else item
                    for name, item in value.items()}
        return {key(name, name): item for name, item in value.items()}

    def hydrate(self, value):
        return self.module_type.from_dict(dict(value))

    def value(self, path=()):
        if path not in ((), ('payload',), ('payload', 'modules')) or self.peek() != '{':
            return self.raw_value()
        self.take('{')
        result = {}
        if self.peek() == '}':
            self.position += 1
            return self.hook(result)
        while True:
            if self.peek() != '"':
                self.error('Expecting property name enclosed in double quotes')
            key = self.raw_value(key=True)
            self.take(':')
            value = self.value(path + (key,))
            if path == ('payload', 'modules') and isinstance(value, dict):
                try:
                    value = self.hydrate(value)
                except Exception:
                    # Metadata, duplicate keys and count coercions must retain
                    # precedence over module hydration failures. Keep only
                    # an invalid record raw and let normal restoration retry.
                    pass
            result[key] = value
            character = self.peek()
            if character == '}':
                self.position += 1
                return self.hook(result)
            if character != ',':
                self.error('Expecting comma delimiter')
            self.position += 1

    def read(self):
        try:
            return super().read()
        finally:
            self.strings.clear()
            self.module_type = None


class InplaceStaticStreamReader(StaticStreamReader):
    def hook(self, value):
        if 'filePath' in value:
            share = self.strings.setdefault
            for name, item in value.items():
                if name in store._CACHE_STRING_FIELDS and type(item) is str:
                    value[name] = share(item, item)
        return value


class OwnedKeyStaticStreamReader(InplaceStaticStreamReader):
    def hydrate(self, value):
        share = self.keys.setdefault
        # Only these decoded dictionary keys survive ModuleIndex hydration.
        # Other wire property names are discarded before the next record.
        for name in ('symbolDefinitions', 'classBaseRefs', 'fieldAliases'):
            mapping = value.get(name)
            if isinstance(mapping, dict):
                value[name] = {share(key, key): item for key, item in mapping.items()}
        return super().hydrate(value)


def reader_for(module_type, original_reader=None, chunk_size=262144,
               reader_type=StaticStreamReader):
    original_reader = original_reader or store._read_cache_payload

    def read(cache_path, *, compact_surface_models=False, restore_static_modules=False,
             static_metadata_matches=None):
        if cache_path.name != store.STATIC_INDEX_FULL_CACHE_NAME or compact_surface_models:
            return original_reader(cache_path, compact_surface_models=compact_surface_models,
                                   restore_static_modules=restore_static_modules,
                                   static_metadata_matches=static_metadata_matches)
        try:
            with cache_path.open('r', encoding='utf-8') as stream:
                payload = reader_type(stream, module_type, chunk_size).read()
        except OSError:
            return None
        except (json.JSONDecodeError, UnicodeDecodeError):
            store._unlink_quietly(cache_path)
            return None
        return payload if isinstance(payload, dict) else None

    return read


def previous_reader(cache_path, **kwargs):
    kwargs['restore_static_modules'] = False
    return _production_reader(cache_path, **kwargs)


_production_reader = store._read_cache_payload
