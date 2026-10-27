"""Actual TextIOWrapper output allocation with identical final line bytes."""
import argparse
import gc
import hashlib
import io
import json
import statistics
import time
import tracemalloc
from pathlib import Path

from django_orm_intellisense.server.ipc_encoding import encode_ipc_message


class DigestOutput(io.RawIOBase):
    def __init__(self):
        super().__init__()
        self.digest = hashlib.sha256()
        self.count = 0

    def writable(self):
        return True

    def write(self, data):
        self.digest.update(data)
        self.count += len(data)
        return len(data)


def write_line(line, mode):
    raw = DigestOutput()
    stream = io.TextIOWrapper(io.BufferedWriter(raw, buffer_size=8192), encoding='utf-8')
    try:
        if mode == 'joined':
            stream.write(line+'\n')
        else:
            stream.write(line)
            stream.write('\n')
        stream.flush()
        return raw.count, raw.digest.hexdigest()
    finally:
        stream.close()


def run(path, repetitions):
    source = Path(path).read_bytes()
    payload = {'event': 'surfaceIndexChanged', 'params': json.loads(source)}
    rows = []
    for threshold in [256, 0]:
        line, kind, _, _ = encode_ipc_message(payload, threshold)
        expected = (len((line+'\n').encode()), hashlib.sha256((line+'\n').encode()).hexdigest())
        samples = {'joined': [], 'split': []}
        allocations = {}
        for revision in range(repetitions):
            for mode in ['joined', 'split'] if revision%2==0 else ['split', 'joined']:
                gc.collect()
                cpu, started = time.process_time_ns(), time.perf_counter_ns()
                result = write_line(line, mode)
                row = {'wallMs': (time.perf_counter_ns()-started)/1e6,
                    'cpuMs': (time.process_time_ns()-cpu)/1e6, 'completeWireBytesEqual': result == expected}
                assert row['completeWireBytesEqual']
                samples[mode].append(row)
        for mode in samples:
            gc.collect()
            tracemalloc.start()
            result = write_line(line, mode)
            retained, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
            assert result == expected
            allocations[mode] = {'retainedBytes': retained, 'peakBytes': peak}
        rows.append({'thresholdKb': threshold, 'encoding': kind, 'wireBytes': expected[0],
            'samples': samples, 'summary': {mode: {**{key: statistics.median(row[key] for row in values)
                for key in ['wallMs', 'cpuMs']}, **allocations[mode]} for mode, values in samples.items()}})
    return {'payloadPath': path, 'payloadSha256': hashlib.sha256(source).hexdigest(),
        'models': len(payload['params']['surfaceIndex']), 'encodings': rows}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('payloads', nargs='+')
    parser.add_argument('--repetitions', type=int, default=15)
    args = parser.parse_args()
    print(json.dumps({'date': '2026-10-10', 'productionApplied': False,
        'rows': [run(path, args.repetitions) for path in args.payloads],
        'scope': '15alternating completepreparedline writes/mode/gzip-or-disabled/tier through actualTextIOWrapper+8KiBBufferedWriter tosha256discardstream. FinalbytesincludingoneLFmustmatch. Output-only CPUandtracemallocpeakabovepreparedline, noOSpipe/Node/concurrentpublication/allstartup/trueprocesspeak claim.'}, indent=2))
