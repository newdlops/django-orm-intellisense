"""Diagnostic phase timings through cached surface publication, across all threads."""
import functools
import json
import sys
import threading
import time

from benchmarks import profile_startup_phases_worker
from django_orm_intellisense.runtime import inspector
from django_orm_intellisense.server import app


def instrument(owner, name):
    original = getattr(owner, name)
    @functools.wraps(original)
    def measured(*args, **kwargs):
        wall, cpu, process_cpu = time.perf_counter_ns(), time.thread_time_ns(), time.process_time_ns()
        try:
            return original(*args, **kwargs)
        finally:
            print('[surface-load:phase-cost] ' + json.dumps({'phase': name,
                'thread': threading.current_thread().name,
                'wallMs': (time.perf_counter_ns() - wall) / 1e6,
                'threadCpuMs': (time.thread_time_ns() - cpu) / 1e6,
                'processCpuMs': (time.process_time_ns() - process_cpu) / 1e6}),
                file=sys.stderr, flush=True)
    setattr(owner, name, measured)


for name in ('load_cached_surface_index', 'prebuild_runtime_workspace_paths',
             'fingerprint_surface_index', 'capture_runtime_member_surface'):
    instrument(app, name)
for name in ('_build_static_fallback', '_publish_current_surface_snapshot'):
    instrument(app.DaemonServer, name)
instrument(inspector, '_ensure_runtime_field_registry_locked')

_original_surface_request = app.DaemonServer._request_surface_index_load
@functools.wraps(_original_surface_request)
def mark_surface_request_start(self, *args, **kwargs):
    if not getattr(self, '_surface_request_profile_marker_emitted', False):
        self._surface_request_profile_marker_emitted = True
        print('[surface-load:phase-start] request_surface_index_load',
            file=sys.stderr, flush=True)
    return _original_surface_request(self, *args, **kwargs)
app.DaemonServer._request_surface_index_load = mark_surface_request_start

if __name__ == '__main__':
    profile_startup_phases_worker.main()
