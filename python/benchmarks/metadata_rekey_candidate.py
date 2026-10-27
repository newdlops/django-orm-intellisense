"""Candidate-only per-read key/value pooling in newly decoded metadata dicts."""
from django_orm_intellisense.cache import json_stream


def decode_metadata_inplace(stream, string_fields):
    keys, strings = {}, {}
    share_key = keys.setdefault
    share_string = strings.setdefault

    def metadata(value):
        source_metadata = 'filePath' in value
        entries = tuple(value.items())
        value.clear()
        for name, item in entries:
            if source_metadata and name in string_fields and type(item) is str:
                item = share_string(item, item)
            value[share_key(name, name)] = item
        return value

    return json_stream.MetadataStreamReader(stream, metadata, object_depth=3).read()
