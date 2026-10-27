"""Benchmark-only bounded phase timers around actual daemon/fresh workers."""
import contextlib
import functools
import json
import pickle
import subprocess
import sys
import threading
import time
from pathlib import Path

PREFIX = '[async-member:phase] '
fresh = len(sys.argv) > 1 and sys.argv[1] == '--fresh'


def emit(row):
    row['finishedUnixMs'] = time.time_ns() / 1e6
    row['thread'] = threading.current_thread().name
    print(PREFIX + json.dumps(row), file=sys.stderr, flush=True)


def instrument(owner, name, predicate=lambda: True):
    original = getattr(owner, name)
    @functools.wraps(original)
    def measured(*args, **kwargs):
        if not predicate():
            return original(*args, **kwargs)
        started, cpu = time.perf_counter_ns(), time.thread_time_ns()
        result = None
        try:
            result = original(*args, **kwargs)
            return result
        finally:
            row = {'owner': 'fresh' if fresh else 'parent', 'phase': name,
                'wallMs': (time.perf_counter_ns() - started) / 1e6,
                'threadCpuMs': (time.thread_time_ns() - cpu) / 1e6}
            if isinstance(result, dict):
                row['entries'] = len(result)
            emit(row)
    setattr(owner, name, measured)


if fresh:
    import django
    from django_orm_intellisense.features import orm_members
    from django_orm_intellisense.server import runtime_members
    from django_orm_intellisense.runtime import inspector
    from django_orm_intellisense.runtime import lookup_catalog
    for owner, name in ((django, 'setup'), (pickle, 'load'), (pickle, 'dump'),
            (orm_members, 'capture_current_runtime_members'),
            (orm_members, 'prebuild_member_surface_cache'), (orm_members, 'build_surface_index'),
            (orm_members, 'fingerprint_surface_index'),
            (inspector, 'collect_runtime_model_metadata'),
            (inspector.RuntimeModelMetadata, 'to_health_dict')):
        instrument(owner, name)
    for name in ('refresh_runtime_model_graph', 'model_graph_delta'):
        if hasattr(runtime_members, name):
            instrument(runtime_members, name)
    instrument(lookup_catalog, 'collect_model_lookup_catalog')
    runtime_members.worker_main(*sys.argv[2:5], sys.argv[5:])
else:
    from django_orm_intellisense.server import app, runtime_members
    from django_orm_intellisense.runtime import lookup_catalog
    active = lambda: threading.current_thread().name == 'runtime-member-refresh'
    for owner, name in ((app, 'snapshot_python_sources'), (app, 'refresh_in_process'),
            (app, 'fingerprint_json_payload'), (app.DaemonServer, '_refresh_runtime_members'),
            (app.DaemonServer, '_build_static_fallback'),
            (app, 'install_runtime_members')):
        instrument(owner, name, active)
    instrument(app.DaemonServer, '_refresh_health_snapshot')
    if hasattr(runtime_members, 'apply_runtime_graph_delta'):
        instrument(runtime_members, 'apply_runtime_graph_delta', active)
    instrument(lookup_catalog, 'apply_model_catalog_delta', active)
    background = lambda: threading.current_thread() is not threading.main_thread()
    for name in ('_prepare_message', '_write_message', '_publish_current_surface_snapshot'):
        instrument(app.DaemonServer, name, background)
    original_file = runtime_members.runtime_member_refresh_state_file
    @contextlib.contextmanager
    def state_file(*args):
        started, cpu = time.perf_counter_ns(), time.thread_time_ns()
        with original_file(*args) as path:
            emit({'owner': 'parent', 'phase': 'write_private_state',
                'wallMs': (time.perf_counter_ns() - started) / 1e6,
                'threadCpuMs': (time.thread_time_ns() - cpu) / 1e6,
                'bytes': Path(path).stat().st_size})
            yield path
    runtime_members.runtime_member_refresh_state_file = state_file
    original_process = subprocess.Popen
    class ObservedProcess(original_process):
        def __init__(self, argv, **kwargs):
            self.phase_log = None
            if len(argv) > 2 and argv[2] == 'django_orm_intellisense.server.runtime_member_worker':
                argv = [*argv[:2], 'benchmarks.profile_runtime_member_refresh_worker', '--fresh', *argv[3:]]
                self.phase_log = kwargs['stderr'].name
                self.result_path = argv[5]
            self.reported = False
            super().__init__(argv, **kwargs)
        def poll(self):
            code = super().poll()
            if code is not None and self.phase_log is not None and not self.reported:
                self.reported = True
                for line in Path(self.phase_log).read_text().splitlines():
                    if line.startswith(PREFIX):
                        print(line, file=sys.stderr, flush=True)
                if Path(self.result_path).exists():
                    emit({'owner': 'fresh', 'phase': 'result_file', 'bytes': Path(self.result_path).stat().st_size})
            return code
    runtime_members.subprocess.Popen = ObservedProcess
    from django_orm_intellisense.__main__ import main
    if __name__ == '__main__':
        main()
