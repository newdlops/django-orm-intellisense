"""Diagnostic-only foreground request timings, including reply serialization."""
import functools
import sys
import time

from benchmarks.profile_runtime_member_refresh_worker import app, emit

original = app.DaemonServer._handle_request


@functools.wraps(original)
def handle(self, request):
    started, cpu = time.perf_counter_ns(), time.thread_time_ns()
    try:
        return original(self, request)
    finally:
        emit({'owner': 'parent', 'phase': 'foreground_request', 'id': request.get('id'),
            'method': request.get('method'), 'wallMs': (time.perf_counter_ns() - started) / 1e6,
            'threadCpuMs': (time.thread_time_ns() - cpu) / 1e6})


app.DaemonServer._handle_request = handle

if __name__ == '__main__':
    from django_orm_intellisense.__main__ import main
    main()
