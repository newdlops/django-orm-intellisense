"""Pair full canonical membership construction on the same actual sources."""
import argparse
import cProfile
import json
import os
import statistics
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from benchmarks.bench_reindex import generate_synthetic_project
from django_orm_intellisense.features import orm_members
from django_orm_intellisense.static_index.indexer import build_static_index


def run(file_count, repetitions):
    with tempfile.TemporaryDirectory(prefix='djls-workspace-path-cost-') as temporary:
        root = Path(temporary).resolve()
        generate_synthetic_project(root, file_count // 10)
        count = len(list(root.rglob('*.py')))
        helpers = root / 'helpers'
        helpers.mkdir()
        for number in range(file_count - count):
            (helpers / f'helper_{number}.py').write_text(f'value = {number}\n')
        index = build_static_index(root)
        assert index.python_file_count == file_count and len(index.modules) == file_count
        paths = {name: str(Path(module.file_path).resolve()) for name, module in index.modules.items()}
        counts = {}
        for physical in paths.values():
            counts[physical] = counts.get(physical, 0) + 1
        expected = frozenset(counts)
        current = orm_members._canonical_workspace_source_path
        def serial_with(resolver):
            def build(value):
                paths_by_module = {name: resolver(module.file_path)
                    for name, module in index.modules.items()}
                counts = {}
                for physical in paths_by_module.values():
                    counts[physical] = counts.get(physical, 0) + 1
                with orm_members._workspace_files_cache_lock:
                    index._workspace_source_paths_by_module = paths_by_module
                    index._workspace_source_path_counts = counts
                    index._workspace_source_paths = frozenset(counts)
                return index._workspace_source_paths
            return build

        previous = serial_with(lambda value: str(Path(value).resolve()))
        serial_current = serial_with(current)
        def threaded_current(value):
            module_items = list(index.modules.items())
            with ThreadPoolExecutor(max_workers=8) as executor:
                canonical_paths = list(executor.map(
                    lambda item: current(item[1].file_path), module_items))
            paths_by_module = {name: path for (name, _), path in zip(module_items, canonical_paths)}
            counts = {}
            for physical in canonical_paths:
                counts[physical] = counts.get(physical, 0) + 1
            with orm_members._workspace_files_cache_lock:
                index._workspace_source_paths_by_module = paths_by_module
                index._workspace_source_path_counts = counts
                index._workspace_source_paths = frozenset(counts)
            return index._workspace_source_paths

        def grouped_parent_current(value):
            with mock.patch.object(orm_members, '_canonical_workspace_source_path', current):
                paths_by_module = orm_members._canonical_workspace_source_paths(index)
            counts = {}
            for canonical in paths_by_module.values():
                counts[canonical] = counts.get(canonical, 0) + 1
            with orm_members._workspace_files_cache_lock:
                index._workspace_source_paths_by_module = paths_by_module
                index._workspace_source_path_counts = counts
                index._workspace_source_paths = frozenset(counts)
            return index._workspace_source_paths

        modes = {'previous-pathlib': previous, 'current-posix-string': serial_current,
                 'threaded-current-posix-string': threaded_current,
                 'grouped-parent-posix-string': grouped_parent_current}
        rows = {mode: [] for mode in modes}

        def measure(function, mode):
            # Cold cache construction per call; only the fixture/index exists.
            index._workspace_source_paths = None
            index._workspace_source_paths_by_module = None
            index._workspace_source_path_counts = None
            with mock.patch.object(orm_members, '_canonical_workspace_source_path', function):
                started_cpu, started = time.process_time_ns(), time.perf_counter_ns()
                actual = function(index)
                wall_ms = (time.perf_counter_ns() - started) / 1e6
                cpu_ms = (time.process_time_ns() - started_cpu) / 1e6
            assert actual == expected
            assert index._workspace_source_paths_by_module == paths
            assert index._workspace_source_path_counts == counts
            return {'wallMs': wall_ms, 'cpuMs': cpu_ms, 'completeCanonicalPathsEqual': True}

        for round in range(repetitions):
            order = list(modes) if round % 2 == 0 else list(reversed(modes))
            for mode in order:
                rows[mode].append(measure(modes[mode], mode))
        profiles = {}
        for mode, function in modes.items():
            profiler = cProfile.Profile()
            profiler.runcall(measure, function, mode)
            selected = {}
            for entry in profiler.getstats():
                name = entry.code if isinstance(entry.code, str) else entry.code.co_name
                if name in {'resolve', 'realpath', '__str__', '_parse_path'} or 'lstat' in name or 'posix.stat' in name:
                    selected[name] = selected.get(name, 0) + entry.callcount
            profiles[mode] = selected
        return {'pythonFiles': file_count, 'models': file_count // 10, 'repetitions': repetitions,
            'rows': rows, 'profiles': profiles,
            'summary': {mode: {'wallMedianMs': statistics.median(row['wallMs'] for row in values),
                              'cpuMedianMs': statistics.median(row['cpuMs'] for row in values)}
                        for mode, values in rows.items()}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--files', type=int, nargs='+', default=[1000, 5000, 10000])
    parser.add_argument('--repetitions', type=int, default=9)
    args = parser.parse_args()
    print(json.dumps({'date': '2026-10-11', 'rows': [run(count, args.repetitions) for count in args.files],
        'scope': 'Paired alternating9 cold main-membership constructions on same actual full1K/5K/10K static sources,10percent model density. Complete per-module canonical paths/set/refcounts compared each time. Pathlib wrapper removed on POSIX only, same realpath ancestor/leaf checks and finalstat. Separate cProfile counts, no cache policy/link-check removal. Excludes static parse/startup/runtime/whole RPC/Node memory/global latency; host uncontrolled.'}, indent=2))
