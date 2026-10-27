"""Complete actual prepare+write allocation, retaining source-locked control."""
import argparse
import gc
import hashlib
import inspect
import io
import json
import textwrap
import threading
import tracemalloc
from pathlib import Path
from unittest import mock

from benchmarks.bench_ipc_line_write import DigestOutput
from django_orm_intellisense.server import app


source = inspect.getsource(app.DaemonServer._write_message)
split = "self._real_stdout.write(line)\n            self._real_stdout.write('\\n')"
joined = "self._real_stdout.write(line + '\\n')"
assert source.count(split) == 1
namespace = dict(vars(app))
exec(compile(textwrap.dedent(source.replace(split, joined)), '<joined-publication-control>', 'exec'), namespace)
writers = {'previous-joined': namespace['_write_message'], 'current-split': app.DaemonServer._write_message}


def run(path):
    raw = Path(path).read_bytes()
    payload = {'event': 'surfaceIndexChanged', 'params': json.loads(raw)}
    server = object.__new__(app.DaemonServer)
    server._write_lock = threading.Lock()
    rows = []
    for threshold in [256, 0]:
        allocation = {}
        expected = None
        for mode, writer in writers.items():
            sink = DigestOutput()
            stream = io.TextIOWrapper(io.BufferedWriter(sink, buffer_size=8192), encoding='utf-8')
            server._real_stdout = stream
            try:
                gc.collect()
                with mock.patch.object(app, '_IPC_COMPRESS_MIN_KB', threshold), mock.patch.object(app.sys, 'stderr', io.StringIO()):
                    tracemalloc.start()
                    writer(server, payload)
                    retained, peak = tracemalloc.get_traced_memory()
                    tracemalloc.stop()
                result = (sink.count, sink.digest.hexdigest())
                if expected is None: expected = result
                else: assert result == expected
                allocation[mode] = {'retainedBytes': retained, 'peakBytes': peak,
                    'completeOutputWireBytesEqual': True}
            finally:
                if tracemalloc.is_tracing(): tracemalloc.stop()
                stream.close()
        rows.append({'thresholdKb': threshold, 'wireBytes': expected[0], 'allocations': allocation})
    return {'payloadPath': path, 'payloadSha256': hashlib.sha256(raw).hexdigest(),
        'models': len(payload['params']['surfaceIndex']), 'encodings': rows}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('payloads', nargs='+')
    args = parser.parse_args()
    print(json.dumps({'date': '2026-10-10', 'productionApplied': True,
        'rows': [run(path) for path in args.payloads],
        'scope': 'One tracedcomplete actualDaemonServer_prepare_message+_write_message pergzip-or-disabled/tier/mode aboveexistingfullmetadata. Source-lockedpreviouswriter differs onlyline+LF concatenation. ActualTextIO+8KiBbuffer+sha256discard output allbytesmatch; noOSpipe/wholeprocess-treetruepeak/stablelatency claim.'}, indent=2))
