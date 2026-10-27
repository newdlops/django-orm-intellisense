"""Diagnostic nested cache read/decode/restore costs during initialize."""
import contextvars
import functools
import threading
import time

from benchmarks import profile_startup_phases_worker as phases
from django_orm_intellisense.cache import store


cache_name = contextvars.ContextVar('cache_name', default=None)


def active():
    return phases.active and threading.get_ident() == phases.thread


def measured(module, name):
    original = getattr(module, name)

    @functools.wraps(original)
    def call(*args, **kwargs):
        if not active():
            return original(*args, **kwargs)
        wall, cpu, process = time.perf_counter_ns(), time.thread_time_ns(), time.process_time_ns()
        try:
            return original(*args, **kwargs)
        finally:
            phases.rows.append({'phase': name, 'module': module.__name__, 'nested': True,
                'cacheName': cache_name.get(), 'wallMs': (time.perf_counter_ns() - wall) / 1e6,
                'mainThreadCpuMs': (time.thread_time_ns() - cpu) / 1e6,
                'processCpuMs': (time.process_time_ns() - process) / 1e6})

    setattr(module, name, call)


original_read = store._read_cache_payload


def read(path, **kwargs):
    if not active():
        return original_read(path, **kwargs)
    token = cache_name.set(path.name)
    wall, cpu, process = time.perf_counter_ns(), time.thread_time_ns(), time.process_time_ns()
    try:
        return original_read(path, **kwargs)
    finally:
        phases.rows.append({'phase': '_read_cache_payload', 'module': store.__name__,
            'nested': True, 'cacheName': path.name, 'wallMs': (time.perf_counter_ns() - wall) / 1e6,
            'mainThreadCpuMs': (time.thread_time_ns() - cpu) / 1e6,
            'processCpuMs': (time.process_time_ns() - process) / 1e6})
        cache_name.reset(token)


store._read_cache_payload = read
for name in ['_decode_cache_payload', '_model_graph_from_cache_dict']:
    measured(store, name)

if __name__ == '__main__':
    phases.main()
