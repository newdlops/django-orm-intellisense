"""Pair complete real notification JSON preparation and incremental gzip."""
import base64
import gc
import gzip
import hashlib
import json
import os
import statistics
import time
import tracemalloc
from pathlib import Path

from benchmarks.ipc_stream_candidate import prepare_streamed
from django_orm_intellisense.runtime.lookup_catalog import lookup_catalog_json_default
from django_orm_intellisense.server.app import _maybe_compress_ipc_payload
from django_orm_intellisense.server.ipc_encoding import encode_ipc_message


def previous(payload):
    serialized = json.dumps(payload, sort_keys=True, default=lookup_catalog_json_default)
    line, kind = _maybe_compress_ipc_payload(serialized)
    return line, kind, len(serialized)


def decoded_bytes(line):
    envelope = json.loads(line)
    return gzip.decompress(base64.b64decode(envelope['data'])) if envelope.get('_enc') == 'gzip+b64' else line.encode()


def run(archive, files, repetitions=15):
    archived = gzip.decompress(Path(archive).read_bytes())
    payload = {'event': 'surfaceIndexChanged', 'params': json.loads(archived)}
    expected = json.dumps(payload, sort_keys=True, default=lookup_catalog_json_default).encode()
    modes = {'previous-full-json': previous, 'candidate-streamed-gzip': prepare_streamed}
    if os.environ.get('DJLS_BENCH_FINAL_IPC_STREAM') == '1':
        def production(value):
            line, kind, raw_chars, _ = encode_ipc_message(value, 256)
            return line, kind, raw_chars
        modes = {'previous-full-json': previous, 'current-streamed-gzip': production}
    samples = {mode: [] for mode in modes}
    allocation = {}
    for revision in range(repetitions):
        order = list(modes) if revision % 2 == 0 else list(reversed(modes))
        for mode in order:
            gc.collect()
            cpu, wall = time.process_time_ns(), time.perf_counter_ns()
            line, kind, chars = modes[mode](payload)
            sample = {'wallMs': (time.perf_counter_ns() - wall) / 1e6,
                      'cpuMs': (time.process_time_ns() - cpu) / 1e6,
                      'wireBytes': len(line), 'rawChars': chars}
            assert decoded_bytes(line) == expected and chars == len(expected)
            assert kind == 'gzip+b64'
            sample['completeDecompressedWireBytesEqual'] = True
            samples[mode].append(sample)
            del line
    for mode in modes:
        gc.collect()
        tracemalloc.start(1)
        line, kind, chars = modes[mode](payload)
        retained, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        assert decoded_bytes(line) == expected
        allocation[mode] = {'additionalRetainedBytes': retained, 'additionalPeakBytes': peak}
        del line
    return {'pythonFiles': files, 'models': len(payload['params']['surfaceIndex']), 'repetitions': repetitions,
        'inputArchive': archive, 'inputUncompressedSha256': hashlib.sha256(archived).hexdigest(),
        'notificationRawBytes': len(expected), 'samples': samples,
        'summary': {mode: {'wallMedianMs': statistics.median(row['wallMs'] for row in values),
                          'cpuMedianMs': statistics.median(row['cpuMs'] for row in values),
                          'wireBytes': values[0]['wireBytes'], **allocation[mode]}
                    for mode, values in samples.items()}}


if __name__ == '__main__':
    print(json.dumps({'date': '2026-10-09', 'productionApplied': os.environ.get('DJLS_BENCH_FINAL_IPC_STREAM') == '1', 'rows': [
        run('bench/lsp-memory-1000-payload.json.gz', 1000),
        run('bench/cache-write-sharded-ready-5000-cached-payload.json.gz', 5000),
        run('bench/lsp-memory-10000-payload.json.gz', 10000)],
        'scope': 'Alternating15 complete actual notification prepare calls/tier fullsortedJSONbytes preserved aftergzipdecode. IncrementalCJSONgroups+zlibgzip6 versuswholeJSON+gzip6, sameenvelope/protocol/threshold/rawsize. Separatetracedadditionalencode/compress allocations aboveexistingmetadata; excludes pipewrite/clientdecode/actualRPC/Node/wholeheap/aggregatepeak/source/platform. Finalmode usesproductionencoder, otherwisecandidateonly;hostuncontrolled, no stableCPUpercentage/globalstartupclaim.'}, indent=2))
