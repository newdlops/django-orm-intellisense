"""Diagnostic-only startup phases, thread CPU and optional cache cProfiles.

Ordinary workers remain the timing/SLO control. These wrappers log nested
boundaries without changing results, source verification, idle scheduling or
registry readiness. Process CPU includes other threads, not child processes.
"""
from __future__ import annotations

import cProfile
import functools
import itertools
import json
import os
import sys
import threading
import time
from pathlib import Path

from django_orm_intellisense.cache import store
from django_orm_intellisense.runtime import inspector
from django_orm_intellisense.server import app
from django_orm_intellisense.__main__ import main

EPOCH = time.perf_counter_ns()
SEQUENCE = itertools.count()
PRINT_LOCK = threading.Lock()
LOCAL = threading.local()
PROFILE_DIR = os.environ.get('DJLS_CACHED_STARTUP_PROFILE_DIR')
PROFILE_NAMES = {'load_cached_static_index', 'load_cached_runtime_inspection',
    'load_cached_model_graph', 'load_cached_surface_index', '_build_static_fallback'}


def instrument(owner, name):
    original = getattr(owner, name)

    @functools.wraps(original)
    def measured(*args, **kwargs):
        if name == '_ensure_runtime_field_registry' and inspector.runtime_field_registry_is_ready(args[0]):
            return original(*args, **kwargs)
        if name in {'_prepare_message', '_write_message'}:
            payload = args[1]
            if payload.get('id') != 1 and payload.get('event') != 'surfaceIndexChanged':
                return original(*args, **kwargs)
        sequence = next(SEQUENCE)
        thread = threading.current_thread()
        row = {'sequence': sequence, 'pid': os.getpid(), 'thread': thread.name,
            'threadId': threading.get_ident(), 'owner': getattr(owner, '__name__', str(owner)), 'phase': name}
        if owner is store and name == '_read_cache_payload':
            path = Path(args[0])
            row['cacheFile'] = path.name
            try:
                row['cacheBytes'] = path.stat().st_size
            except OSError:
                pass
        if name in {'_prepare_message', '_write_message'}:
            row.update({'id': args[1].get('id'), 'event': args[1].get('event')})
        profiler = None
        if PROFILE_DIR and name in PROFILE_NAMES and not getattr(LOCAL, 'profiling', False):
            folder = Path(PROFILE_DIR)
            folder.mkdir(parents=True, exist_ok=True)
            row['cProfile'] = str(folder / f'{os.getpid()}-{sequence}-{name}.pstats')
            profiler = cProfile.Profile()
            LOCAL.profiling = True
        wall, cpu, process_cpu = time.perf_counter_ns(), time.thread_time_ns(), time.process_time_ns()
        row['startedMs'] = (wall - EPOCH) / 1e6
        row['startedUnixNs'] = time.time_ns()
        if profiler:
            profiler.enable()
        try:
            return original(*args, **kwargs)
        except BaseException as error:
            row['error'] = type(error).__name__ + ': ' + str(error)
            raise
        finally:
            if profiler:
                profiler.disable()
            finished = time.perf_counter_ns()
            row.update({'wallMs': (finished - wall) / 1e6,
                'threadCpuMs': (time.thread_time_ns() - cpu) / 1e6,
                'processCpuMs': (time.process_time_ns() - process_cpu) / 1e6,
                'finishedMs': (finished - EPOCH) / 1e6, 'finishedUnixNs': time.time_ns()})
            if profiler:
                LOCAL.profiling = False
                profiler.dump_stats(row['cProfile'])
            with PRINT_LOCK:
                print('[cached-startup:phase] ' + json.dumps(row), file=sys.stderr, flush=True)

    setattr(owner, name, measured)


for name in ['resolve_venv_info', 'snapshot_python_sources', 'discover_workspace',
        'load_cached_static_index', 'build_static_index', 'save_static_index', 'save_source_snapshot',
        'load_cached_runtime_inspection', 'inspect_runtime', 'save_runtime_inspection',
        'build_semantic_graph', 'build_health_snapshot', 'load_cached_model_graph', 'build_model_graph',
        'save_model_graph', 'load_cached_surface_index', 'save_surface_index',
        '_runtime_source_fingerprint', '_runtime_cache_fingerprint', 'fingerprint_surface_index',
        'fingerprint_json_payload', 'prebuild_runtime_workspace_paths']:
    instrument(app, name)
for name in ['_read_cache_payload', '_decode_cache_payload', '_decode_static_cache_payload',
        '_decode_surface_cache_payload', '_model_graph_from_cache_dict', '_surface_index_cache_problem']:
    instrument(store, name)
for name in ['_initialize', '_build_static_fallback', '_surface_index_changed_payload',
        '_commit_loaded_surface_index', '_prepare_message', '_write_message']:
    instrument(app.DaemonServer, name)
instrument(inspector, '_ensure_runtime_field_registry')


if __name__ == '__main__':
    main()
