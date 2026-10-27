"""Prepare one complete JSON line without retaining a full raw gzip input."""
import base64
import json
import time
import zlib

from ..cache.store import _write_cache_json_value
from ..runtime.lookup_catalog import lookup_catalog_json_default

IPC_GZIP_LEVEL = 1


class _JsonGzipSink:
    def __init__(self, threshold, profile):
        self.threshold = threshold
        self.profile = profile
        self.raw_chars = 0
        self.pending = []
        self.compressor = None
        self.compressed = []
        self.compression_seconds = 0.0

    def _compress(self, text):
        started = time.perf_counter() if self.profile else 0.0
        encoded = self.compressor.compress(text.encode('utf-8'))
        if encoded:
            self.compressed.append(encoded)
        if self.profile:
            self.compression_seconds += time.perf_counter() - started

    def write(self, text):
        self.raw_chars += len(text)
        if self.compressor is None:
            self.pending.append(text)
            if self.threshold > 0 and self.raw_chars >= self.threshold:
                # IPC favors encode latency over a smaller disk artifact. Keep
                # the complete gzip envelope while avoiding level6 CPU cost.
                self.compressor = zlib.compressobj(IPC_GZIP_LEVEL, zlib.DEFLATED, 31)
                text = ''.join(self.pending)
                self.pending.clear()
                self._compress(text)
        else:
            self._compress(text)

    def finish(self):
        if self.compressor is None:
            return ''.join(self.pending), None
        started = time.perf_counter() if self.profile else 0.0
        self.compressed.append(self.compressor.flush())
        compressed = b''.join(self.compressed)
        self.compressed.clear()
        data = base64.b64encode(compressed).decode('ascii')
        del compressed
        # Drop compressed fragments before base64 and assemble the envelope
        # once, avoiding an extra full-size intermediate string.
        line = ''.join(('{"_enc":"gzip+b64","data":"', data, '"}'))
        if self.profile:
            self.compression_seconds += time.perf_counter() - started
        return line, 'gzip+b64'


def encode_ipc_message(payload, threshold_kb, *, profile=False):
    sink = _JsonGzipSink(threshold_kb * 1024, profile)
    encoder = json.JSONEncoder(sort_keys=True, default=lookup_catalog_json_default)
    _write_cache_json_value(sink, payload, encoder, 0)
    line, kind = sink.finish()
    return line, kind, sink.raw_chars, sink.compression_seconds
