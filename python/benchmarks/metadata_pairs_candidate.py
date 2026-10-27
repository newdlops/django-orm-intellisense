"""Candidate-only one-dictionary JSON pairs hydration with read-local pools."""
import json

from django_orm_intellisense.cache.json_stream import JsonStreamReader


class PairsMetadataReader(JsonStreamReader):
    def __init__(self, stream, string_fields, *, chunk_size=262144):
        self.string_pool = {}
        self.string_fields = string_fields
        super().__init__(stream, self.metadata, object_depth=3, chunk_size=chunk_size)
        self.decoder = json.JSONDecoder(object_pairs_hook=self.pairs)

    def metadata(self, value):
        source = 'filePath' in value
        share_key = self.keys.setdefault
        share_string = self.string_pool.setdefault
        return {share_key(name, name): share_string(item, item)
                if source and name in self.string_fields and type(item) is str else item
                for name, item in value.items()}

    def hook(self, value):
        return self.metadata(value)

    def pairs(self, pairs):
        source = any(name == 'filePath' for name, _ in pairs)
        share_key = self.keys.setdefault
        share_string = self.string_pool.setdefault
        return {share_key(name, name): share_string(item, item)
                if source and name in self.string_fields and type(item) is str else item
                for name, item in pairs}

    def read(self):
        try:
            return super().read()
        finally:
            self.string_pool.clear()
            self.string_fields = None


def decode_metadata_pairs(stream, string_fields):
    return PairsMetadataReader(stream, string_fields).read()
