"""Benchmark-only bounded-input JSON reader using the standard C decoder."""
import json
import types
from pathlib import Path

from django_orm_intellisense.cache import store


class JsonStreamReader:
    def __init__(self, stream, object_hook, compacted=None, chunk_size=65536, object_depth=3):
        self.stream = stream
        self.buffer = ''
        self.position = 0
        self.eof = False
        self.chunk_size = chunk_size
        self.compacted = compacted
        self.object_depth = object_depth
        self.keys = {}
        self.original_hook = object_hook
        self.decoder = json.JSONDecoder(object_hook=self.hook)

    def hook(self, value):
        # Each raw_decode has its own key memo. Retain the standard full-read
        # key sharing across records without keeping a process-global pool.
        share = self.keys.setdefault
        value = {share(key, key): item for key, item in value.items()}
        return self.original_hook(value)

    def fill(self):
        remainder = self.buffer[self.position:]
        chunk = self.stream.read(self.chunk_size)
        self.buffer = remainder + chunk
        self.position = 0
        if not chunk:
            self.eof = True

    def peek(self):
        while True:
            self.position = json.decoder.WHITESPACE.match(self.buffer, self.position).end()
            if self.position < len(self.buffer):
                return self.buffer[self.position]
            if self.eof:
                return None
            self.fill()

    def error(self, message):
        raise json.JSONDecodeError(message, self.buffer, self.position)

    def take(self, character):
        if self.peek() != character:
            self.error(f'Expecting {character!r}')
        self.position += 1

    def raw_value(self, *, key=False):
        self.peek()
        delimiters = ' \t\r\n,]}' + (':' if key else '')
        while True:
            marker = len(self.compacted) if self.compacted is not None else None
            try:
                value, end = self.decoder.raw_decode(self.buffer, self.position)
            except json.JSONDecodeError:
                if marker is not None:
                    del self.compacted[marker:]
                if self.eof:
                    raise
                self.fill()
                continue
            # A number/literal can end at the current input boundary before
            # its suffix arrives. Reparse from its start after growing input.
            if not self.eof and (end == len(self.buffer) or self.buffer[end] not in delimiters):
                if marker is not None:
                    del self.compacted[marker:]
                del value
                self.fill()
                continue
            self.position = end
            return value

    def value(self, depth=0):
        if self.peek() != '{' or depth >= self.object_depth:
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
            result[key] = self.value(depth + 1)
            character = self.peek()
            if character == '}':
                self.position += 1
                return self.hook(result)
            if character != ',':
                self.error('Expecting comma delimiter')
            self.position += 1

    def read(self):
        try:
            result = self.value()
            if self.peek() is not None:
                self.error('Extra data')
            return result
        finally:
            # The decoder holds a bound hook; release that cycle and the
            # input/key pool immediately on both complete reads and failures.
            self.decoder = None
            self.original_hook = None
            self.stream = None
            self.compacted = None
            self.keys.clear()
            self.buffer = ''


def stream_decode(stream, object_hook, compacted=None, chunk_size=65536, object_depth=3):
    return JsonStreamReader(stream, object_hook, compacted, chunk_size, object_depth).read()


def candidate_module(*, chunk_size=65536, object_depth=3):
    source = Path(store.__file__).read_text()
    if 'from .json_stream import decode_json_stream' in source:
        module = types.ModuleType('django_orm_intellisense.cache._stream_variant')
        module.__package__ = store.__package__
        exec(compile(source, str(store.__file__) + ':stream_variant', 'exec'), module.__dict__)
        module.decode_json_stream = lambda stream, hook, compacted=None: stream_decode(
            stream, hook, compacted, chunk_size, object_depth)
        return module
    old = 'result = json.loads(raw_payload, object_hook=compact_model)'
    assert source.count(old) == 1
    source = source.replace(old, 'result = (stream_decode(raw_payload, compact_model, compacted, CHUNK_SIZE)\n'
        '              if hasattr(raw_payload, "read") else json.loads(raw_payload, object_hook=compact_model))')
    start = source.index('def _read_cache_payload(')
    end = source.index('\n\ndef _write_cache_json_value', start)
    source = source[:start] + '''def _read_cache_payload(cache_path: Path, *, compact_surface_models: bool = False):
    try:
        if compact_surface_models:
            with cache_path.open('r', encoding='utf-8') as stream:
                payload = _decode_surface_cache_payload(stream)
        else:
            payload = _decode_cache_payload(cache_path.read_text(encoding='utf-8'))
    except OSError:
        return None
    except json.JSONDecodeError:
        _unlink_quietly(cache_path)
        return None
    return payload if isinstance(payload, dict) else None
''' + source[end:]
    module = types.ModuleType('django_orm_intellisense.cache._stream_candidate')
    module.__package__ = store.__package__
    module.stream_decode = lambda stream, hook, compacted, chunk: stream_decode(
        stream, hook, compacted, chunk, object_depth)
    module.CHUNK_SIZE = chunk_size
    exec(compile(source, str(store.__file__) + ':stream_candidate', 'exec'), module.__dict__)
    return module


def previous_module():
    source = Path(store.__file__).read_text()
    start = source.index('def _read_cache_payload(')
    end = source.index('\n\ndef _write_cache_json_value', start)
    source = source[:start] + '''def _read_cache_payload(cache_path: Path, *, compact_surface_models: bool = False):
    try:
        raw_payload = cache_path.read_text(encoding='utf-8')
    except OSError:
        return None
    try:
        payload = (_decode_surface_cache_payload(raw_payload) if compact_surface_models
                   else _decode_cache_payload(raw_payload))
    except json.JSONDecodeError:
        _unlink_quietly(cache_path)
        return None
    return payload if isinstance(payload, dict) else None
''' + source[end:]
    module = types.ModuleType('django_orm_intellisense.cache._stream_previous')
    module.__package__ = store.__package__
    exec(compile(source, str(store.__file__) + ':stream_previous', 'exec'), module.__dict__)
    return module
