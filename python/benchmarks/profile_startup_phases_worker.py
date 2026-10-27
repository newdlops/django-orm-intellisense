"""Benchmark-only sequential phase wall/main-thread/process CPU timings."""
import functools
import json
import sys
import threading
import time

from django_orm_intellisense.server import app
from django_orm_intellisense.features import orm_members
from django_orm_intellisense.cache import store
from django_orm_intellisense.runtime import lookup_catalog
from django_orm_intellisense.runtime import inspector
from django_orm_intellisense.__main__ import main

thread = threading.get_ident()
active = False
rows = []
original_initialize = app.DaemonServer._initialize


def instrument(module, name):
    original = getattr(module, name)
    @functools.wraps(original)
    def measured(*args, **kwargs):
        if not active or threading.get_ident() != thread:
            return original(*args, **kwargs)
        wall, cpu, process_cpu = time.perf_counter_ns(), time.thread_time_ns(), time.process_time_ns()
        try:
            return original(*args, **kwargs)
        finally:
            rows.append({'phase': name, 'module': module.__name__,
                'wallMs': (time.perf_counter_ns() - wall) / 1e6,
                'mainThreadCpuMs': (time.thread_time_ns() - cpu) / 1e6,
                'processCpuMs': (time.process_time_ns() - process_cpu) / 1e6})
    setattr(module, name, measured)


for name in ['resolve_venv_info', 'snapshot_python_sources', 'discover_workspace',
             'load_cached_static_index', 'build_static_index', 'save_static_index',
             'save_source_snapshot', 'load_cached_runtime_inspection', 'inspect_runtime',
             'save_runtime_inspection', 'build_semantic_graph', 'build_health_snapshot',
             'load_cached_model_graph', 'load_cached_surface_index', 'build_model_graph',
             'save_model_graph', 'prebuild_runtime_workspace_paths',
             'fingerprint_surface_index', 'fingerprint_json_payload',
             '_runtime_source_fingerprint', '_runtime_cache_fingerprint']:
    instrument(app, name)
for name in ['load_cached_static_index', 'load_cached_runtime_inspection',
             'load_cached_model_graph', 'load_cached_surface_index']:
    instrument(store, name)
instrument(orm_members, 'prebuild_runtime_workspace_paths')
instrument(lookup_catalog, 'collect_lookup_catalog')
instrument(inspector, 'collect_runtime_model_metadata')
instrument(inspector, '_collect_custom_lookups')

for name in ['_build_model_names', '_build_static_fallback']:
    instrument(app.DaemonServer, name)


def initialize(self, params):
    global active
    rows.clear()
    active = True
    wall, cpu, process_cpu = time.perf_counter_ns(), time.thread_time_ns(), time.process_time_ns()
    try:
        return original_initialize(self, params)
    finally:
        active = False
        print('[initialize:phase-cost] ' + json.dumps({'settingsModule': params.get('settingsModule'),
            'deferRuntime': params.get('deferRuntime'), 'wallMs': (time.perf_counter_ns() - wall) / 1e6,
            'mainThreadCpuMs': (time.thread_time_ns() - cpu) / 1e6,
            'processCpuMs': (time.process_time_ns() - process_cpu) / 1e6,
            'phases': rows,
            'scope': 'App boundary timings only on initialize request main thread. collect_lookup_catalog is nested in inspect_runtime; do not add nested rows. ProcessCPU includes active parser threads but excludes worker processes. Instrumented diagnostic, not ordinary RPC or memory.'}),
            file=sys.stderr, flush=True)


app.DaemonServer._initialize = initialize
if __name__ == '__main__':
    main()
