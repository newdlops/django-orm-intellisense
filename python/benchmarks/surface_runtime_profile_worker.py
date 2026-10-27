"""Thin capture/file phase timing around the actual configured daemon."""
import contextlib
import json
import sys
import time
from pathlib import Path

from django_orm_intellisense.server import app


original_capture = app.capture_runtime_member_surface
original_file = app.runtime_member_state_file


def capture(*args, **kwargs):
    wall, cpu = time.perf_counter_ns(), time.process_time_ns()
    result = original_capture(*args, **kwargs)
    row = {'phase': 'capture', 'wallMs': (time.perf_counter_ns() - wall) / 1e6,
           'processCpuMs': (time.process_time_ns() - cpu) / 1e6,
           'modelsWithRuntimeMembers': len({key[0] for key in result}) if result else 0,
           'runtimeItems': sum(map(len, result.values())) if result else 0}
    print('[surface-runtime:phase] ' + json.dumps(row), file=sys.stderr, flush=True)
    return result


@contextlib.contextmanager
def state_file(members):
    wall, cpu = time.perf_counter_ns(), time.process_time_ns()
    with original_file(members) as path:
        row = {'phase': 'runtime-state-file', 'wallMs': (time.perf_counter_ns() - wall) / 1e6,
               'processCpuMs': (time.process_time_ns() - cpu) / 1e6,
               'bytes': Path(path).stat().st_size if path else 0}
        print('[surface-runtime:phase] ' + json.dumps(row), file=sys.stderr, flush=True)
        yield path


app.capture_runtime_member_surface = capture
app.runtime_member_state_file = state_file

from django_orm_intellisense.__main__ import main

if __name__ == '__main__':
    main()
