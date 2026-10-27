"""Read cache objects incrementally with the standard JSON record decoder."""
from __future__ import annotations

import json


class JsonStreamReader:
    def __init__(self, stream, object_hook, compacted=None, chunk_size=262144, object_depth=2):
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
        # Separate raw_decode calls have separate key memos. Keep the normal
        # full-read key sharing, scoped to this read rather than the process.
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
        # Most compact records already point at a delimiter or value. Keep
        # the original refill/whitespace path for every other input shape.
        position, buffer = self.position, self.buffer
        if (type(buffer) is str and type(position) is int
                and 0 <= position < len(buffer) and buffer[position] not in ' \t\r\n'):
            return buffer[position]
        # Do not retain an older chunk while the fallback refills the input.
        del buffer, position
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

    def raw_value(self, *, key=False, record=False):
        self.peek()
        delimiters = ' \t\r\n,]}' + (':' if key else '')
        while True:
            marker = len(self.compacted) if self.compacted is not None else None
            try:
                value, end = (self.record_decoder if record else self.decoder).raw_decode(
                    self.buffer, self.position)
            except json.JSONDecodeError:
                if marker is not None:
                    del self.compacted[marker:]
                if self.eof:
                    raise
                self.fill()
                continue
            # Number/literal suffixes can cross a read boundary. Hooks may
            # already have run on completed children of an incomplete value;
            # discard their bookkeeping before reparsing the enlarged value.
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
            # The decoder holds a bound hook. Break that cycle and release
            # input/key-pool ownership immediately on success and failure.
            self.decoder = None
            self.original_hook = None
            self.stream = None
            self.compacted = None
            self.keys.clear()
            self.buffer = ''


def decode_json_stream(stream, object_hook, compacted=None, chunk_size=262144, object_depth=2):
    return JsonStreamReader(stream, object_hook, compacted, chunk_size, object_depth).read()


class MetadataStreamReader(JsonStreamReader):
    def hook(self, value):
        # The callback shares keys and metadata values in the same pass.
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


class StaticModuleStreamReader(MetadataStreamReader):
    def __init__(self, stream, object_hook, restore_module, chunk_size=262144, metadata_matches=None,
                 restore_module_row=None):
        self.restore_module = restore_module
        self.restore_module_row = restore_module_row
        self.metadata_matches = metadata_matches
        self.restore_allowed = metadata_matches is None
        super().__init__(stream, object_hook, chunk_size=chunk_size)

    def value(self, path=()):
        # Only actual full-index modules are restored. Future metadata and
        # unknown nested objects retain their normal JSON representation.
        paths = ((), ('payload',), ('payload', 'modules'))
        if self.restore_module_row is not None:
            paths += (('payload', 'moduleRows'),)
        if path not in paths or self.peek() != '{':
            return self.raw_value()
        self.take('{')
        result = {}
        if self.peek() == '}':
            self.position += 1
            return self.hook(result)
        module_map = path == ('payload', 'modules')
        row_map = path == ('payload', 'moduleRows') and self.restore_module_row is not None
        while True:
            if self.peek() != '"':
                self.error('Expecting property name enclosed in double quotes')
            key = self.raw_value(key=True)
            self.take(':')
            value = self.raw_value() if module_map or row_map else self.value(path + (key,))
            if module_map and self.restore_allowed and isinstance(value, dict):
                value = self.restore_module(value)
            elif row_map and self.restore_allowed and isinstance(value, (list, dict)):
                value = self.restore_module_row(value)
            if not path and key == 'metadata' and self.metadata_matches is not None:
                self.restore_allowed = self.metadata_matches(value)
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
            self.restore_module = None
            self.restore_module_row = None
            self.metadata_matches = None


def decode_static_modules_stream(stream, object_hook, restore_module, chunk_size=262144,
                                 metadata_matches=None, restore_module_row=None):
    return StaticModuleStreamReader(stream, object_hook, restore_module, chunk_size, metadata_matches,
                                    restore_module_row).read()


class GraphFieldStreamReader(MetadataStreamReader):
    def __init__(self, stream, object_hook, restore_model_fields, chunk_size=262144, metadata_matches=None,
                 restore_model_rows=None, record_hook=None):
        self.restore_model_fields = restore_model_fields
        self.restore_model_rows = restore_model_rows
        self.metadata_matches = metadata_matches
        self.restore_allowed = metadata_matches is None
        self.record_decoder = json.JSONDecoder(object_hook=record_hook) if record_hook is not None else None
        super().__init__(stream, object_hook, chunk_size=chunk_size, object_depth=3)

    def value(self, path=()):
        # Keep ordinary depth-three chunking for nodes, edges and future data.
        # Large raw maps would otherwise be reparsed at every read boundary.
        if len(path) >= 3 or self.peek() != '{':
            # Node/edge records are consumed by graph construction. Their
            # transient property keys need no read-wide sharing; retained map
            # keys and unknown paths still use the ordinary decoder.
            record = (self.record_decoder is not None and self.restore_allowed
                      and len(path) == 3
                      and path[:2] in (('payload', 'nodesByLabel'), ('payload', 'edgesBySourceLabel')))
            return self.raw_value(record=record)
        self.take('{')
        result = {}
        if self.peek() == '}':
            self.position += 1
            return self.hook(result)
        model_map = path == ('payload', 'fieldsByModelLabel')
        row_map = path == ('payload', 'fieldRowsByModelLabel') and self.restore_model_rows is not None
        while True:
            if self.peek() != '"':
                self.error('Expecting property name enclosed in double quotes')
            name = self.raw_value(key=True)
            self.take(':')
            value = self.raw_value() if model_map or row_map else self.value(path + (name,))
            if model_map and self.restore_allowed and isinstance(value, dict):
                value = self.restore_model_fields(value)
            elif row_map and self.restore_allowed and isinstance(value, dict):
                value = self.restore_model_rows(value)
            if not path and name == 'metadata' and self.metadata_matches is not None:
                self.restore_allowed = self.metadata_matches(value)
            result[name] = value
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
            self.restore_model_fields = None
            self.restore_model_rows = None
            self.metadata_matches = None
            self.record_decoder = None


def decode_graph_fields_stream(stream, object_hook, restore_model_fields, chunk_size=262144,
                               metadata_matches=None, restore_model_rows=None, record_hook=None):
    return GraphFieldStreamReader(stream, object_hook, restore_model_fields, chunk_size, metadata_matches,
                                 restore_model_rows, record_hook).read()
