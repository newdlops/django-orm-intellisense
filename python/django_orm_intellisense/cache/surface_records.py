"""Per-model immutable member tables for the persistent completion cache."""
from __future__ import annotations

import json

from .json_stream import JsonStreamReader


def model_to_row(entry):
    if type(entry) is not dict:
        return [0, entry]
    definitions, indices, identities, receivers = [], {}, {}, {}
    for receiver, members in entry.items():
        if type(members) is not dict:
            receivers[receiver] = [0, members]
            continue
        references, literals = {}, {}
        for name, value in members.items():
            kind = type(value)
            if kind is tuple:
                index = identities.get(id(value))
                if index is not None:
                    references[name] = index
                    continue
            if ((kind is tuple or kind is list) and len(value) == 4
                    and (value[0] is None or type(value[0]) is str)
                    and (value[1] is None or type(value[1]) is str)
                    and (value[2] is None or type(value[2]) is str)
                    and (value[3] is None or type(value[3]) is str)):
                key = value if kind is tuple else tuple(value)
                index = indices.get(key)
                if index is None:
                    index = len(definitions)
                    indices[key] = index
                    definitions.append(key)
                # Only validated immutable tuples use the identity shortcut.
                # Lists and unknown children retain ordinary JSON semantics.
                if kind is tuple:
                    identities[id(value)] = index
                references[name] = index
            else:
                literals[name] = value
        receivers[receiver] = [1, references, literals]
    return [1, definitions, receivers]


def model_from_row(row, share=None, *, _share_member_keys=False):
    pool = None
    definitions = []

    def compact_literal_members(members):
        nonlocal pool
        if type(members) is dict:
            for name, value in members.items():
                if (type(value) is list and len(value) == 4
                        and all(item is None or type(item) is str for item in value)):
                    if pool is None:
                        pool = {value: value for value in definitions}
                    compact = tuple(value)
                    members[name] = pool.setdefault(compact, compact)
        return members

    if type(row) is not list or not row or type(row[0]) is not int:
        raise ValueError('Invalid surface model row.')
    if row[0] == 0 and len(row) == 2:
        if type(row[1]) is dict:
            for members in row[1].values():
                compact_literal_members(members)
        return row[1]
    if row[0] != 1 or len(row) != 3 or type(row[1]) is not list or type(row[2]) is not dict:
        raise ValueError('Invalid surface member table.')
    for value in row[1]:
        if (type(value) is not list or len(value) != 4
                or (value[0] is not None and type(value[0]) is not str)
                or (value[1] is not None and type(value[1]) is not str)
                or (value[2] is not None and type(value[2]) is not str)
                or (value[3] is not None and type(value[3]) is not str)):
            raise ValueError('Invalid surface member definition.')
        # These two atoms are fixed wire values, not model-specific data.
        # Retain the complete label/kind while avoiding duplicate scalar/field
        # strings in every validated definition of every decoded model.
        definitions.append(('scalar', value[1], 'field', value[3])
            if _share_member_keys and value[0] == 'scalar' and value[2] == 'field'
            else tuple(value))
    receivers = {}
    definition_count = len(definitions)
    for receiver, packed in row[2].items():
        if type(packed) is not list or not packed or type(packed[0]) is not int:
            raise ValueError('Invalid surface receiver row.')
        if packed[0] == 0 and len(packed) == 2:
            members = compact_literal_members(packed[1])
            if _share_member_keys:
                if type(members) is dict:
                    members = {share(name, name): item for name, item in members.items()}
                receivers[share(receiver, receiver)] = members
            else:
                receivers[receiver] = members
            continue
        if (packed[0] != 1 or len(packed) != 3 or type(packed[1]) is not dict
                or type(packed[2]) is not dict or packed[1].keys() & packed[2].keys()):
            raise ValueError('Invalid surface receiver table.')
        # Only the JSON stream reader opts in with its own string pool.
        # Build the retained keys directly instead of copying this complete
        # receiver table again after all references have been restored.
        members = compact_literal_members(
            {share(name, name): item for name, item in packed[2].items()}
            if _share_member_keys else dict(packed[2]))
        if _share_member_keys:
            for name, index in packed[1].items():
                if type(index) is not int or index < 0 or index >= definition_count:
                    raise ValueError('Invalid surface member reference.')
                members[share(name, name)] = definitions[index]
            receivers[share(receiver, receiver)] = members
        else:
            for name, index in packed[1].items():
                if type(index) is not int or index < 0 or index >= definition_count:
                    raise ValueError('Invalid surface member reference.')
                members[name] = definitions[index]
            receivers[receiver] = members
    if share is not None and not _share_member_keys:
        receivers = {share(receiver, receiver): {share(name, name): item for name, item in members.items()}
            if type(members) is dict else members for receiver, members in receivers.items()}
    return receivers


class _RestoredModel:
    __slots__ = ('value',)

    def __init__(self, value):
        self.value = value


class SurfaceRecordStreamReader(JsonStreamReader):
    """Restore actual model rows while releasing their temporary JSON tables."""
    def __init__(self, stream, chunk_size=262144, *, runtime_members=False):
        super().__init__(stream, lambda value: value, chunk_size=chunk_size)
        self.decoder = json.JSONDecoder()
        self.names = {}
        self.runtime_members = runtime_members

    def value(self, path=()):
        paths = ((), ('payload',), ('runtimeMembers',)) if self.runtime_members else ((), ('payload',))
        if path not in paths or self.peek() != '{':
            return self.raw_value()
        self.take('{')
        result = {}
        if self.peek() == '}':
            self.position += 1
            return result
        while True:
            if self.peek() != '"':
                self.error('Expecting property name enclosed in double quotes')
            name = self.raw_value(key=True)
            self.take(':')
            value = self.raw_value() if path in (('payload',), ('runtimeMembers',)) else self.value(path + (name,))
            if path == ('payload',):
                try:
                    value = _RestoredModel(model_from_row(value, self.names.setdefault, _share_member_keys=True))
                except (ValueError, TypeError, KeyError):
                    # A later duplicate can replace an invalid model or whole
                    # payload. Validate only the final selected JSON values.
                    pass
            elif path == ('runtimeMembers',):
                from .runtime_member_records import model_from_row as runtime_model_from_row
                try:
                    value = runtime_model_from_row(name, value)
                except (ValueError, TypeError, KeyError):
                    # Validate only the last selected value after duplicates.
                    pass
            result[name] = value
            character = self.peek()
            if character == '}':
                self.position += 1
                return result
            if character != ',':
                self.error('Expecting comma delimiter')
            self.position += 1

    def read(self):
        try:
            return super().read()
        finally:
            self.names.clear()


def restore_surface_rows(payload):
    if type(payload) is not dict:
        raise ValueError('Invalid surface row payload.')
    names = {}
    try:
        return {label: value.value if type(value) is _RestoredModel
            else model_from_row(value, names.setdefault) for label, value in payload.items()}
    finally:
        names.clear()


def surface_version_hint(stream):
    metadata = surface_metadata_hint(stream)
    return metadata.get('surfaceIndexVersion') if type(metadata) is dict else None


def surface_metadata_hint(stream):
    """Peek at a leading metadata object; final metadata still owns acceptance."""
    try:
        if not callable(getattr(stream, 'seekable', None)) or not stream.seekable():
            return None
        position = stream.tell()
    except (OSError, ValueError):
        return None
    decoder = json.JSONDecoder()
    buffer = ''
    try:
        while True:
            chunk = stream.read(65536)
            buffer += chunk
            try:
                start = json.decoder.WHITESPACE.match(buffer, 0).end()
                if start >= len(buffer):
                    if not chunk:
                        return None
                    continue
                if buffer[start] != '{':
                    return None
                start = json.decoder.WHITESPACE.match(buffer, start + 1).end()
                name, end = decoder.raw_decode(buffer, start)
                if name != 'metadata':
                    return None
                start = json.decoder.WHITESPACE.match(buffer, end).end()
                if start >= len(buffer) or buffer[start] != ':':
                    if chunk and start >= len(buffer):
                        continue
                    return None
                start = json.decoder.WHITESPACE.match(buffer, start + 1).end()
                metadata, _ = decoder.raw_decode(buffer, start)
                return metadata if type(metadata) is dict else None
            except json.JSONDecodeError:
                if not chunk:
                    return None
    finally:
        stream.seek(position)
