"""Candidate-only incremental gzip of the exact existing sorted JSON wire."""
import base64
import json
import zlib

from django_orm_intellisense.cache.store import _write_cache_json_value
from django_orm_intellisense.runtime.lookup_catalog import lookup_catalog_json_default


class JsonGzipSink:
    def __init__(self, threshold):
        self.threshold = threshold
        self.raw_chars = 0
        self.pending = []
        self.compressor = None
        self.compressed = []

    def write(self, text):
        self.raw_chars += len(text)
        if self.compressor is None:
            self.pending.append(text)
            if self.threshold > 0 and self.raw_chars >= self.threshold:
                self.compressor = zlib.compressobj(6, zlib.DEFLATED, 31)
                encoded = ''.join(self.pending).encode('utf-8')
                self.pending.clear()
                compressed = self.compressor.compress(encoded)
                if compressed:
                    self.compressed.append(compressed)
        else:
            compressed = self.compressor.compress(text.encode('utf-8'))
            if compressed:
                self.compressed.append(compressed)

    def finish(self):
        if self.compressor is None:
            return ''.join(self.pending), None, self.raw_chars
        self.compressed.append(self.compressor.flush())
        encoded = base64.b64encode(b''.join(self.compressed)).decode('ascii')
        return '{"_enc":"gzip+b64","data":"' + encoded + '"}', 'gzip+b64', self.raw_chars


def prepare_streamed(payload, threshold_kb=256):
    sink = JsonGzipSink(threshold_kb * 1024)
    encoder = json.JSONEncoder(sort_keys=True, default=lookup_catalog_json_default)
    _write_cache_json_value(sink, payload, encoder, 0)
    return sink.finish()
