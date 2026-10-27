"""Benchmark-only daemon encoder level replacement, preserving all RPCs."""
import os

from benchmarks.ipc_compression_level_candidate import encode_level
from django_orm_intellisense.server import app
from django_orm_intellisense.__main__ import main
from django_orm_intellisense.server.ipc_encoding import IPC_GZIP_LEVEL

level = int(os.environ['DJLS_BENCH_IPC_LEVEL'])
original = app.encode_ipc_message


def encode(payload, threshold_kb, *, profile=False):
    if level == IPC_GZIP_LEVEL:
        return original(payload, threshold_kb, profile=profile)
    return encode_level(payload, threshold_kb, level, profile=profile)


app.encode_ipc_message = encode
if __name__ == '__main__':
    main()
