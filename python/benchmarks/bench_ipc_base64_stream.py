"""Compare complete envelope bytes, CPU and encode peak for base64 sinks."""
import argparse
import gc
import hashlib
import json
import os
import statistics
import time
import tracemalloc
from pathlib import Path

from benchmarks.ipc_base64_stream_candidate import encode_candidate
from django_orm_intellisense.server.ipc_encoding import encode_ipc_message


def run(path, repetitions):
    source = Path(path).read_bytes()
    payload = {'event': 'surfaceIndexChanged', 'params': json.loads(source)}
    expected = encode_ipc_message(payload, 256)[:3]
    modes = {'current': lambda value: encode_ipc_message(value, 256, profile=True),
        'release-joined': lambda value: encode_candidate(value, 256, 'release', profile=True),
        'stream-base64': lambda value: encode_candidate(value, 256, 'stream', profile=True)}
    if os.environ.get('DJLS_BENCH_CURRENT_IPC_FINISH') == '1':
        modes = {'previous': lambda value: encode_candidate(value, 256, 'previous', profile=True),
            'current': lambda value: encode_ipc_message(value, 256, profile=True),
            'stream-base64': lambda value: encode_candidate(value, 256, 'stream', profile=True)}
    samples = {mode: [] for mode in modes}
    allocations = {}
    for revision in range(repetitions):
        order = list(modes)
        order = order[revision%len(order):]+order[:revision%len(order)]
        for mode in order:
            gc.collect()
            cpu, started = time.process_time_ns(), time.perf_counter_ns()
            result = modes[mode](payload)
            row = {'wallMs': (time.perf_counter_ns()-started)/1e6,
                'cpuMs': (time.process_time_ns()-cpu)/1e6, 'compressionMs': result[3]*1000}
            assert result[:3] == expected
            row['completeCompressedEnvelopeBytesEqual'] = True
            samples[mode].append(row)
            del result
    for mode, call in modes.items():
        gc.collect()
        tracemalloc.start()
        result = call(payload)
        retained, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        assert result[:3] == expected
        allocations[mode] = {'retainedBytes': retained, 'peakBytes': peak}
        del result
    return {'payloadPath': path, 'payloadSha256': hashlib.sha256(source).hexdigest(),
        'models': len(payload['params']['surfaceIndex']), 'wireBytes': len(expected[0]),
        'samples': samples, 'summary': {mode: {**{key: statistics.median(row[key] for row in values)
            for key in ['wallMs', 'cpuMs', 'compressionMs']}, **allocations[mode]} for mode, values in samples.items()}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('payloads', nargs='+')
    parser.add_argument('--repetitions', type=int, default=9)
    args = parser.parse_args()
    print(json.dumps({'date': '2026-10-10', 'productionApplied': os.environ.get('DJLS_BENCH_CURRENT_IPC_FINISH') == '1',
        'rows': [run(path, args.repetitions) for path in args.payloads],
        'scope': 'Nine rotating complete level1 streamedJSONgzipbase64 encodes/mode/tier. Everycompressed envelopebyte, kind and rawchar equal. Encoder-only traced peak above livemetadata; no pipe/Node/actualRPC/ordinaryeditor/trueaggregatepeak proof.'}, indent=2))
