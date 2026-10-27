"""Candidate-only compression level; production envelope/streaming unchanged."""
import json
import zlib

from django_orm_intellisense.cache.store import _write_cache_json_value
from django_orm_intellisense.runtime.lookup_catalog import lookup_catalog_json_default
from django_orm_intellisense.server.ipc_encoding import _JsonGzipSink


class CompressionLevelSink(_JsonGzipSink):
    def __init__(self, threshold, profile, level):
        super().__init__(threshold, profile)
        self.level = level

    def write(self, text):
        if self.compressor is None and self.threshold > 0 and self.raw_chars + len(text) >= self.threshold:
            self.raw_chars += len(text)
            self.pending.append(text)
            self.compressor = zlib.compressobj(self.level, zlib.DEFLATED, 31)
            text = ''.join(self.pending)
            self.pending.clear()
            self._compress(text)
        else:
            super().write(text)


def encode_level(payload, threshold_kb, level, *, profile=False):
    sink = CompressionLevelSink(threshold_kb * 1024, profile, level)
    encoder = json.JSONEncoder(sort_keys=True, default=lookup_catalog_json_default)
    _write_cache_json_value(sink, payload, encoder, 0)
    line, kind = sink.finish()
    return line, kind, sink.raw_chars, sink.compression_seconds
