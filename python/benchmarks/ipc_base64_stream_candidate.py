"""Candidate-only bounded compressed-byte base64 carry, same envelope bytes."""
import base64
import json
import time

from django_orm_intellisense.cache.store import _write_cache_json_value
from django_orm_intellisense.runtime.lookup_catalog import lookup_catalog_json_default
from django_orm_intellisense.server.ipc_encoding import _JsonGzipSink


class ReleaseJoinedSink(_JsonGzipSink):
    def finish(self):
        if self.compressor is None:
            return super().finish()
        started = time.perf_counter() if self.profile else 0.0
        self.compressed.append(self.compressor.flush())
        data = b''.join(self.compressed)
        self.compressed.clear()
        encoded = base64.b64encode(data).decode('ascii')
        del data
        line = ''.join(('{"_enc":"gzip+b64","data":"', encoded, '"}'))
        if self.profile:
            self.compression_seconds += time.perf_counter()-started
        return line, 'gzip+b64'


class PreviousFinishSink(_JsonGzipSink):
    def finish(self):
        if self.compressor is None:
            return super().finish()
        started = time.perf_counter() if self.profile else 0.0
        self.compressed.append(self.compressor.flush())
        data = base64.b64encode(b''.join(self.compressed)).decode('ascii')
        line = '{"_enc":"gzip+b64","data":"' + data + '"}'
        if self.profile:
            self.compression_seconds += time.perf_counter()-started
        return line, 'gzip+b64'


class StreamBase64Sink(_JsonGzipSink):
    def __init__(self, threshold, profile):
        super().__init__(threshold, profile)
        self.base64_parts = ['{"_enc":"gzip+b64","data":"']
        self.base64_tail = b''

    def _append_compressed(self, data):
        if self.base64_tail:
            data = self.base64_tail + data
        count = len(data)-len(data)%3
        self.base64_tail = data[count:]
        if count:
            self.base64_parts.append(base64.b64encode(memoryview(data)[:count]).decode('ascii'))

    def _compress(self, text):
        started = time.perf_counter() if self.profile else 0.0
        self._append_compressed(self.compressor.compress(text.encode('utf-8')))
        if self.profile:
            self.compression_seconds += time.perf_counter()-started

    def finish(self):
        if self.compressor is None:
            return super().finish()
        started = time.perf_counter() if self.profile else 0.0
        self._append_compressed(self.compressor.flush())
        if self.base64_tail:
            self.base64_parts.append(base64.b64encode(self.base64_tail).decode('ascii'))
            self.base64_tail = b''
        self.base64_parts.append('"}')
        line = ''.join(self.base64_parts)
        self.base64_parts.clear()
        if self.profile:
            self.compression_seconds += time.perf_counter()-started
        return line, 'gzip+b64'


def encode_candidate(payload, threshold_kb, mode, *, profile=False):
    sink_type = StreamBase64Sink if mode == 'stream' else PreviousFinishSink if mode == 'previous' else ReleaseJoinedSink
    sink = sink_type(threshold_kb*1024, profile)
    encoder = json.JSONEncoder(sort_keys=True, default=lookup_catalog_json_default)
    _write_cache_json_value(sink, payload, encoder, 0)
    line, kind = sink.finish()
    return line, kind, sink.raw_chars, sink.compression_seconds
