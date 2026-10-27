"""Opt-in phase/GC diagnostics; no policy changes to garbage collection."""
from __future__ import annotations

import gc
import json
import os
import sys
import threading
import time
from contextvars import ContextVar
from functools import wraps

_current = ContextVar('reindex_phase_profile', default=None)


class ReindexProfile:
    def __init__(self):
        self.thread = threading.get_ident()
        self.started = self.last_wall = time.perf_counter_ns()
        self.cpu_started = self.last_cpu = time.thread_time_ns()
        self.gc_ns = self.last_gc = 0
        self.gc_events = []
        self.gc_start = {}
        self.phases = []

    def gc_callback(self, phase, info):
        if threading.get_ident() != self.thread:
            return
        generation = info['generation']
        if phase == 'start':
            self.gc_start[generation] = time.perf_counter_ns()
        elif generation in self.gc_start:
            elapsed = time.perf_counter_ns() - self.gc_start.pop(generation)
            self.gc_ns += elapsed
            self.gc_events.append({'generation': generation, 'ms': elapsed / 1e6,
                'collected': info.get('collected', 0), 'uncollectable': info.get('uncollectable', 0)})

    def mark(self, phase):
        wall = time.perf_counter_ns()
        cpu = time.thread_time_ns()
        self.phases.append({'phase': phase, 'wallMs': (wall - self.last_wall) / 1e6,
            'threadCpuMs': (cpu - self.last_cpu) / 1e6, 'gcMs': (self.gc_ns - self.last_gc) / 1e6})
        self.last_wall, self.last_cpu, self.last_gc = wall, cpu, self.gc_ns

    def emit(self, file_path, outcome):
        print('[reindex:phases] ' + json.dumps({
            'file': file_path.name, 'affected': outcome.affected_count if outcome is not None else None,
            'totalWallMs': (self.last_wall - self.started) / 1e6,
            'threadCpuMs': (self.last_cpu - self.cpu_started) / 1e6,
            'gcMs': self.gc_ns / 1e6, 'phases': self.phases, 'gcEvents': self.gc_events,
        }), file=sys.stderr, flush=True)


def current_profile():
    return _current.get()


def profile_reindex(function):
    @wraps(function)
    def run(*args, **kwargs):
        if os.environ.get('DJLS_PROFILE_REINDEX') != '1':
            return function(*args, **kwargs)
        profile = ReindexProfile()
        token = _current.set(profile)
        gc.callbacks.append(profile.gc_callback)
        outcome = None
        try:
            outcome = function(*args, **kwargs)
            return outcome
        finally:
            profile.mark('finish')
            gc.callbacks.remove(profile.gc_callback)
            _current.reset(token)
            profile.emit(kwargs['file_path'], outcome)
    return run
