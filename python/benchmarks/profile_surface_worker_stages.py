"""Diagnostic-only timing for cold surface worker handoff and construction."""
from __future__ import annotations

import contextlib
import functools
import json
import sys
import time

from benchmarks import profile_surface_load_worker as base

app = base.app


def _record(phase: str, started: int) -> None:
    print('[surface-worker:phase-cost] ' + json.dumps({
        'phase': phase,
        'wallMs': (time.perf_counter_ns() - started) / 1e6,
    }), file=sys.stderr, flush=True)


def instrument(owner, name, phase=None):
    original = getattr(owner, name)

    @functools.wraps(original)
    def measured(*args, **kwargs):
        if phase == 'build_surface_index_cache':
            print('[surface-worker:phase-start] build_surface_index_cache',
                file=sys.stderr, flush=True)
        started = time.perf_counter_ns()
        try:
            return original(*args, **kwargs)
        finally:
            _record(phase or name, started)

    setattr(owner, name, measured)


def instrument_context(owner, name, phase=None):
    original = getattr(owner, name)

    @functools.wraps(original)
    @contextlib.contextmanager
    def measured(*args, **kwargs):
        started = time.perf_counter_ns()
        with original(*args, **kwargs) as value:
            _record(f'{phase or name}_prepare', started)
            lifetime = time.perf_counter_ns()
            try:
                yield value
            finally:
                _record(f'{phase or name}_lifetime', lifetime)

    setattr(owner, name, measured)


# Parent-side state serialization, cache write, and process-pool round trip.
instrument_context(app, 'surface_worker_state_file')
instrument_context(app, 'runtime_member_state_file')
instrument(app, 'save_surface_index')

# Child-side state restore and actual surface generation. These module-level
# wrappers are importable by ProcessPoolExecutor's spawned worker process.
instrument(app, 'load_surface_worker_state', 'restore_worker_state')
instrument(app, 'load_runtime_member_state', 'restore_runtime_member_state')
instrument(app, 'prebuild_member_surface_cache', 'build_surface_index_cache')
instrument(app, '_bg_prebuild_surface_index', 'surface_worker_task')


if __name__ == '__main__':
    base.profile_startup_phases_worker.main()
