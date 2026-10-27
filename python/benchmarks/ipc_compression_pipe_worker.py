"""Candidate-only complete response writes over an actual stdout pipe."""
import argparse
import json
import sys
import time
from pathlib import Path

from benchmarks.ipc_compression_level_candidate import encode_level
from django_orm_intellisense.server.ipc_encoding import IPC_GZIP_LEVEL, encode_ipc_message

parser = argparse.ArgumentParser()
parser.add_argument('--payload', required=True)
args = parser.parse_args()
payload = json.loads(Path(args.payload).read_bytes())
print(json.dumps({'ready': True, 'productionLevel': IPC_GZIP_LEVEL}), flush=True)
for raw in sys.stdin:
    request = json.loads(raw)
    level = request['level']
    response = {'id': request['id'], 'result': payload}
    cpu, start = time.process_time_ns(), time.perf_counter_ns()
    line, kind, chars, compression = encode_ipc_message(response, 256, profile=True) if level == IPC_GZIP_LEVEL else encode_level(response, 256, level, profile=True)
    encoded = time.perf_counter_ns()
    print(line, flush=True)
    written = time.perf_counter_ns()
    print(json.dumps({'profile': {'id': request['id'], 'level': level,
        'encodeMs': (encoded-start)/1e6, 'writeMs': (written-encoded)/1e6,
        'workerTotalMs': (written-start)/1e6, 'workerCpuMs': (time.process_time_ns()-cpu)/1e6,
        'compressionMs': compression*1000, 'wireBytes': len(line), 'rawChars': chars,
        'encoding': kind}}), flush=True)
