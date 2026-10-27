"""Actual daemon writer versus source-locked split candidate over stdout."""
import argparse
import inspect
import json
import os
import sys
import textwrap
import threading
import time
import tracemalloc
from pathlib import Path

from django_orm_intellisense.server import app
from django_orm_intellisense.server.ipc_encoding import IPC_GZIP_LEVEL

parser = argparse.ArgumentParser()
parser.add_argument('--payload', required=True)
args = parser.parse_args()
payload = json.loads(Path(args.payload).read_bytes())
server = object.__new__(app.DaemonServer)
server._real_stdout = sys.stdout
server._write_lock = threading.Lock()
source = inspect.getsource(app.DaemonServer._write_message)
joined = "self._real_stdout.write(line + '\\n')"
split = "self._real_stdout.write(line)\n            self._real_stdout.write('\\n')"
if joined in source:
    assert source.count(joined) == 1
    production_mode = 'joined'
    other_source = source.replace(joined, split)
else:
    assert source.count(split) == 1
    production_mode = 'split'
    other_source = source.replace(split, joined)
namespace = dict(vars(app))
exec(compile(textwrap.dedent(other_source), '<ipc-line-write-candidate>', 'exec'), namespace)
writers = {production_mode: app.DaemonServer._write_message,
    'split' if production_mode == 'joined' else 'joined': namespace['_write_message']}
app._IPC_COMPRESS_MIN_KB = int(os.environ.get('DJLS_BENCH_IPC_PIPE_COMPRESS_KB', '256'))
print(json.dumps({'ready': True, 'productionLevel': IPC_GZIP_LEVEL, 'productionWriteMode': production_mode}), flush=True)
for raw in sys.stdin:
    request = json.loads(raw)
    mode = request['level']
    response = {'id': request['id'], 'result': payload}
    cpu, start = time.process_time_ns(), time.perf_counter_ns()
    prepared = server._prepare_message(response)
    encoded = time.perf_counter_ns()
    if request.get('trace'):
        tracemalloc.start()
    writers[mode](server, response, prepared_message=prepared)
    written = time.perf_counter_ns()
    peak = None
    if request.get('trace'):
        _, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
    print(json.dumps({'profile': {'id': request['id'], 'level': mode,
        'encodeMs': (encoded-start)/1e6, 'writeMs': (written-encoded)/1e6,
        'workerTotalMs': (written-start)/1e6, 'workerCpuMs': (time.process_time_ns()-cpu)/1e6,
        'wireBytes': len(prepared.line), 'encoding': prepared.encoding,
        'outputPeakBytes': peak}}), flush=True)
