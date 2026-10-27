"""Benchmark-only observed main-process memory at source/cache/IPC boundaries."""
import functools
import json
import sys
import threading
import time
import tracemalloc


def install():
    import multiprocessing.connection
    import multiprocessing.reduction
    from django_orm_intellisense.cache import store
    from django_orm_intellisense.features import orm_members
    from django_orm_intellisense.server import app

    serial = 0
    lock = threading.Lock()

    def instrument(module, name, owner=None):
        nonlocal serial
        original = getattr(module, name)

        @functools.wraps(original)
        def measured(*args, **kwargs):
            nonlocal serial
            with lock:
                serial += 1
                number = serial
            before, prior_peak = tracemalloc.get_traced_memory()
            wall, cpu = time.perf_counter_ns(), time.thread_time_ns()
            label = None
            if name == '_read_cache_payload' and args:
                label = args[0].name
            if name == '_prepare_message' and len(args) > 1:
                label = args[1].get('event') or args[1].get('id')
            if name == 'dump' and args:
                label = type(args[0]).__name__
            try:
                return original(*args, **kwargs)
            finally:
                after, peak = tracemalloc.get_traced_memory()
                print('[heap:boundary] ' + json.dumps({'number': number, 'phase': name,
                    'module': owner or module.__name__, 'thread': threading.current_thread().name,
                    'label': label, 'beforeBytes': before, 'afterBytes': after,
                    'priorGlobalPeakBytes': prior_peak, 'afterGlobalPeakBytes': peak,
                    'newObservedGlobalPeakBytes': max(0, peak-prior_peak),
                    'wallMs': (time.perf_counter_ns() - wall) / 1e6,
                    'threadCpuMs': (time.thread_time_ns() - cpu) / 1e6,
                    'scope': 'Nested/global tracer peak since last benchmark checkpoint, no reset in wrapper. Otherthread work may overlap; not isolatedallocation attribution or ordinarylatency.'}),
                    file=sys.stderr, flush=True)
        setattr(module, name, measured)

    for name in ['_read_cache_payload', '_decode_cache_payload', '_write_cache_payload']:
        instrument(store, name)
    for name in ['load_cached_surface_index', 'save_surface_index',
                 'prebuild_member_surface_cache', 'build_surface_index',
                 'fingerprint_surface_index', 'fingerprint_json_payload']:
        if hasattr(app, name):
            instrument(app, name)
    instrument(app.DaemonServer, '_prepare_message', owner=app.__name__)
    instrument(multiprocessing.reduction, 'dump')
    instrument(multiprocessing.connection.Connection, 'recv', owner='multiprocessing.connection.Connection')
