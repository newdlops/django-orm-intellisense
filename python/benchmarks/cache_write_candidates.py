"""Benchmark-only JSON cache writers with unchanged canonical bytes."""
import json

from django_orm_intellisense.runtime.lookup_catalog import lookup_catalog_json_default


def iterencode_buffered(stream, payload):
    encoder = json.JSONEncoder(sort_keys=True, default=lookup_catalog_json_default)
    chunks = []
    size = 0
    for chunk in encoder.iterencode(payload):
        chunks.append(chunk)
        size += len(chunk)
        if size >= 65536:
            stream.write(''.join(chunks))
            chunks.clear()
            size = 0
    if chunks:
        stream.write(''.join(chunks))


def structural_chunks(stream, payload):
    encoder = json.JSONEncoder(sort_keys=True, default=lookup_catalog_json_default)

    def write(value, depth):
        if type(value) is dict and (depth < 3 or len(value) > 128) and all(type(key) is str for key in value):
            stream.write('{')
            for number, key in enumerate(sorted(value)):
                if number:
                    stream.write(', ')
                stream.write(encoder.encode(key))
                stream.write(': ')
                write(value[key], depth + 1)
            stream.write('}')
        elif type(value) is list and len(value) > 128:
            stream.write('[')
            for offset in range(0, len(value), 128):
                if offset:
                    stream.write(', ')
                stream.write(encoder.encode(value[offset:offset + 128])[1:-1])
            stream.write(']')
        else:
            stream.write(encoder.encode(value))

    write(payload, 0)


def sharded_maps(stream, payload):
    encoder = json.JSONEncoder(sort_keys=True, default=lookup_catalog_json_default)

    def write(value, depth):
        if type(value) is dict and all(type(key) is str for key in value):
            keys = sorted(value)
            if len(keys) > 128:
                stream.write('{')
                for offset in range(0, len(keys), 64):
                    if offset:
                        stream.write(', ')
                    shard = {key: value[key] for key in keys[offset:offset + 64]}
                    stream.write(encoder.encode(shard)[1:-1])
                stream.write('}')
                return
            if depth < 3:
                stream.write('{')
                for number, key in enumerate(keys):
                    if number:
                        stream.write(', ')
                    stream.write(encoder.encode(key))
                    stream.write(': ')
                    write(value[key], depth + 1)
                stream.write('}')
                return
        if type(value) is list and len(value) > 128:
            stream.write('[')
            for offset in range(0, len(value), 128):
                if offset:
                    stream.write(', ')
                stream.write(encoder.encode(value[offset:offset + 128])[1:-1])
            stream.write(']')
        else:
            stream.write(encoder.encode(value))

    write(payload, 0)
