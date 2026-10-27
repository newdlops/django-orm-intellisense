"""Diagnostic clocks for current startup, source parsing and worker transfer.

This module changes no production settings or return values. Nested/overlapping
phase durations are not additive; thread CPU excludes other threads/processes.
Optional cProfile runs are separate from ordinary latency controls.
"""
from __future__ import annotations

import cProfile
import functools
import itertools
import json
import os
import pickle
import sys
import threading
import time
from pathlib import Path

import django
from django_orm_intellisense.features import orm_members
from django_orm_intellisense.runtime import inspector
from django_orm_intellisense.server import app
from django_orm_intellisense.__main__ import main

PREFIX = '[startup-attribution:phase] '
EPOCH = time.perf_counter_ns()
SEQUENCE = itertools.count()
LOCK = threading.Lock()
PROFILE_LOCK = threading.Lock()
LOCAL = threading.local()
PROFILE_DIR = os.environ.get('DJLS_CACHED_STARTUP_PROFILE_DIR')
PROFILE_NAMES = {'inspect_runtime', 'capture_runtime_member_surface',
    'prebuild_member_surface_cache', '_prepare_message', 'load_cached_static_index',
    'load_cached_surface_index', '_ensure_runtime_field_registry_locked'}


def emit(row):
    with LOCK:
        print(PREFIX + json.dumps(row), file=sys.stderr, flush=True)


def instrument(owner, name):
    original = getattr(owner, name)

    @functools.wraps(original)
    def measured(*args, **kwargs):
        if name in {'_prepare_message', '_write_message'}:
            payload = args[1]
            if payload.get('id') != 1 and payload.get('event') != 'surfaceIndexChanged':
                return original(*args, **kwargs)
        if name == '_ensure_runtime_field_registry_locked' and inspector.runtime_field_registry_is_ready(args[0]):
            return original(*args, **kwargs)
        sequence = next(SEQUENCE)
        row = {'sequence': sequence, 'pid': os.getpid(),
            'thread': threading.current_thread().name,
            'threadId': threading.get_ident(), 'owner': getattr(owner, '__name__', str(owner)),
            'phase': name, 'startedUnixNs': time.time_ns()}
        if name in {'_prepare_message', '_write_message'}:
            row.update({'id': args[1].get('id'), 'event': args[1].get('event')})
        if owner is pickle and len(args) > 1:
            row['file'] = str(getattr(args[1], 'name', ''))
        elif owner is pickle and args:
            row['file'] = str(getattr(args[0], 'name', ''))
        profiler = None
        if (PROFILE_DIR and name in PROFILE_NAMES
                and not getattr(LOCAL, 'profiling', False)
                and PROFILE_LOCK.acquire(blocking=False)):
            folder = Path(PROFILE_DIR)
            folder.mkdir(parents=True, exist_ok=True)
            row['cProfile'] = str(folder / f'{os.getpid()}-{sequence}-{name}.pstats')
            profiler = cProfile.Profile()
            LOCAL.profiling = True
        parse_before = getattr(LOCAL, 'parses', (0, 0, 0))
        wall, cpu = time.perf_counter_ns(), time.thread_time_ns()
        row['startedMs'] = (wall - EPOCH) / 1e6
        result = None
        try:
            if profiler:
                profiler.enable()
            result = original(*args, **kwargs)
            return result
        except BaseException as error:
            row['error'] = type(error).__name__ + ': ' + str(error)
            raise
        finally:
            if profiler:
                profiler.disable()
            finished = time.perf_counter_ns()
            parse_after = getattr(LOCAL, 'parses', (0, 0, 0))
            row.update({'wallMs': (finished - wall) / 1e6,
                'threadCpuMs': (time.thread_time_ns() - cpu) / 1e6,
                'finishedMs': (finished - EPOCH) / 1e6, 'finishedUnixNs': time.time_ns(),
                'classSourceParses': parse_after[0] - parse_before[0],
                'classSourceParseWallMs': (parse_after[1] - parse_before[1]) / 1e6,
                'classSourceParseThreadCpuMs': (parse_after[2] - parse_before[2]) / 1e6})
            if isinstance(result, dict):
                row['resultEntries'] = len(result)
            if owner is pickle and row.get('file'):
                try:
                    stream = args[1] if name == 'dump' else args[0]
                    row['streamPositionBytes'] = stream.tell()
                    row['fileStatBytesBeforeClose'] = Path(row['file']).stat().st_size
                except (OSError, ValueError):
                    pass
            if profiler:
                LOCAL.profiling = False
                profiler.dump_stats(row['cProfile'])
                PROFILE_LOCK.release()
            emit(row)

    setattr(owner, name, measured)


original_parse = orm_members._parse_class_nodes


@functools.wraps(original_parse)
def parse_class_nodes(*args, **kwargs):
    wall, cpu = time.perf_counter_ns(), time.thread_time_ns()
    try:
        return original_parse(*args, **kwargs)
    finally:
        count, elapsed, thread_cpu = getattr(LOCAL, 'parses', (0, 0, 0))
        LOCAL.parses = (count + 1, elapsed + time.perf_counter_ns() - wall,
            thread_cpu + time.thread_time_ns() - cpu)


orm_members._parse_class_nodes = parse_class_nodes
for name in ('resolve_venv_info', 'snapshot_python_sources', 'discover_workspace',
        'load_cached_static_index', 'build_static_index', 'save_static_index',
        'load_cached_runtime_inspection', 'inspect_runtime', 'save_runtime_inspection',
        'build_model_graph', 'load_cached_model_graph', 'save_model_graph',
        'load_cached_surface_index', 'save_surface_index', 'prebuild_runtime_workspace_paths',
        'capture_runtime_member_surface', 'prebuild_member_surface_cache',
        'fingerprint_surface_index', '_init_bg_worker_from_file', '_bg_prebuild_surface_index'):
    instrument(app, name)
for name in ('_initialize', '_build_static_fallback', '_commit_loaded_surface_index',
        '_publish_current_surface_snapshot', '_prepare_message', '_write_message'):
    instrument(app.DaemonServer, name)
instrument(django, 'setup')
instrument(inspector, '_ensure_runtime_field_registry_locked')
instrument(pickle, 'load')
instrument(pickle, 'dump')


if __name__ == '__main__':
    main()
