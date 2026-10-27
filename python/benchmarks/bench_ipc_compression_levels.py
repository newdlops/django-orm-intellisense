"""Full IPC metadata encoder CPU, wire size and allocation per gzip level."""
import argparse
import base64
import gc
import gzip
import hashlib
import json
import statistics
import time
import tracemalloc
from pathlib import Path

from benchmarks.ipc_compression_level_candidate import encode_level
from django_orm_intellisense.runtime.lookup_catalog import lookup_catalog_json_default
from django_orm_intellisense.server.ipc_encoding import IPC_GZIP_LEVEL, encode_ipc_message


def decode(line):
    return gzip.decompress(base64.b64decode(json.loads(line)['data']))


def run(path, repetitions):
    source = Path(path).read_bytes()
    payload = {'event': 'surfaceIndexChanged', 'params': json.loads(source)}
    expected = json.dumps(payload, sort_keys=True, default=lookup_catalog_json_default).encode()
    control, kind, chars, _ = encode_ipc_message(payload, 256)
    equivalent, _, _, _ = encode_level(payload, 256, IPC_GZIP_LEVEL)
    assert equivalent == control and kind == 'gzip+b64'
    modes = {'current6': lambda value: encode_ipc_message(value, 256, profile=True),
        'candidate1': lambda value: encode_level(value, 256, 1, profile=True),
        'candidate3': lambda value: encode_level(value, 256, 3, profile=True)}
    if IPC_GZIP_LEVEL != 6:
        modes = {'reference6': lambda value: encode_level(value, 256, 6, profile=True),
            f'current{IPC_GZIP_LEVEL}': lambda value: encode_ipc_message(value, 256, profile=True),
            'candidate3': lambda value: encode_level(value, 256, 3, profile=True)}
    samples = {key: [] for key in modes}
    allocations = {}
    for revision in range(repetitions):
        order = list(modes)
        order = order[revision % len(order):] + order[:revision % len(order)]
        for key in order:
            gc.collect()
            cpu, started = time.process_time_ns(), time.perf_counter_ns()
            line, kind, chars, compression = modes[key](payload)
            row = {'wallMs': (time.perf_counter_ns()-started)/1e6,
                'cpuMs': (time.process_time_ns()-cpu)/1e6,
                'compressionMs': compression*1000, 'wireBytes': len(line)}
            assert kind == 'gzip+b64' and chars == len(expected) and decode(line) == expected
            row['completeDecompressedWireBytesEqual'] = True
            samples[key].append(row)
            del line
    for key, call in modes.items():
        gc.collect()
        tracemalloc.start()
        line, _, _, _ = call(payload)
        retained, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        assert decode(line) == expected
        allocations[key] = {'retainedBytes': retained, 'peakBytes': peak}
        del line
    return {'payloadPath': path, 'payloadSha256': hashlib.sha256(source).hexdigest(),
        'models': len(payload['params']['surfaceIndex']), 'rawBytes': len(expected),
        'repetitions': repetitions, 'samples': samples,
        'summary': {key: {**{name: statistics.median(row[name] for row in values)
            for name in ['wallMs', 'cpuMs', 'compressionMs', 'wireBytes']}, **allocations[key]}
            for key, values in samples.items()}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('payloads', nargs='+')
    parser.add_argument('--repetitions', type=int, default=9)
    args = parser.parse_args()
    print(json.dumps({'date': '2026-10-10', 'productionApplied': IPC_GZIP_LEVEL != 6,
        'rows': [run(path, args.repetitions) for path in args.payloads],
        'productionLevel': IPC_GZIP_LEVEL,
        'scope': 'Nine rotating encoder calls per gzip level/tier on complete actual configured surface/catalogue notifications. Exact canonical decompressed bytes and identical current-level control envelope required. Separate CPU/compression wall and encoder-only traced allocations above live metadata. No pipe/Node/editor/actualRPC/ordinarystartup/trueaggregatepeak claim.'}, indent=2))
