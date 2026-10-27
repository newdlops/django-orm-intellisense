"""Cost/residency of eagerly filling existing dependency caches only."""
import argparse
import dataclasses
import gc
import json
import pickle
import statistics
import tempfile
import time
import tracemalloc
from pathlib import Path

from benchmarks.bench_reindex import generate_synthetic_project
from django_orm_intellisense.features.orm_members import _workspace_files, prebuild_runtime_workspace_paths
from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection
from django_orm_intellisense.static_index.indexer import build_static_index


def run(file_count, repetitions):
    with tempfile.TemporaryDirectory(prefix='djls-dependency-prewarm-cost-') as temporary:
        root = Path(temporary).resolve()
        generate_synthetic_project(root, file_count // 10)
        count = len(list(root.rglob('*.py')))
        helpers = root / 'helpers'
        helpers.mkdir()
        for number in range(file_count - count):
            (helpers / f'helper_{number}.py').write_text(f'value = {number}\n')
        index = build_static_index(root)
        assert index.python_file_count == file_count
        _workspace_files(index)
        runtime = dataclasses.replace(create_pending_runtime_inspection(None), bootstrap_status='ready')
        before_wire = index.to_cache_dict()
        samples = []
        for _ in range(repetitions):
            index._import_dependency_cache.dependents = None
            index._constructor_dependency_cache = None
            started_cpu, started = time.process_time_ns(), time.perf_counter_ns()
            prebuild_runtime_workspace_paths(index, runtime)
            samples.append({'wallMs': (time.perf_counter_ns() - started) / 1e6,
                'cpuMs': (time.process_time_ns() - started_cpu) / 1e6})
            assert index.to_cache_dict() == before_wire
        expected_imports = dict(index._import_dependency_cache.dependents)
        expected_constructors = dict(index._constructor_dependency_cache)
        index._import_dependency_cache.dependents = None
        index._constructor_dependency_cache = None
        pickle_before = len(pickle.dumps(index))
        gc.collect()
        tracemalloc.start(1)
        before = tracemalloc.get_traced_memory()[0]
        prebuild_runtime_workspace_paths(index, runtime)
        gc.collect()
        current, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        assert index._import_dependency_cache.dependents == expected_imports
        assert index._constructor_dependency_cache == expected_constructors
        pickle_after = len(pickle.dumps(index))
        immutable_before = (dict(index._import_dependency_cache.dependents), dict(index._constructor_dependency_cache))
        for source in ['app0.model_0', 'helpers.helper_0', 'not_present']:
            index.source_dependents({source}); index.constructor_dependents(source)
        assert (index._import_dependency_cache.dependents, index._constructor_dependency_cache) == immutable_before
        assert index.to_cache_dict() == before_wire
        return {'pythonFiles': file_count, 'models': file_count // 10, 'repetitions': repetitions,
            'samples': samples, 'wallMedianMs': statistics.median(row['wallMs'] for row in samples),
            'cpuMedianMs': statistics.median(row['cpuMs'] for row in samples),
            'additionalRetainedBytes': current - before, 'additionalTrackedPeakBytes': peak - before,
            'staticIndexPickleBytesBefore': pickle_before, 'staticIndexPickleBytesAfter': pickle_after,
            'pickleIncreaseBytes': pickle_after - pickle_before,
            'completeGraphsAndWirePreserved': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--files', type=int, nargs='+', default=[1000, 5000, 10000])
    parser.add_argument('--repetitions', type=int, default=9)
    args = parser.parse_args()
    print(json.dumps({'date': '2026-10-09', 'rows': [run(count, args.repetitions) for count in args.files],
        'scope': '9cold dependency-only prewarms per complete actual source tier on already-warm path snapshot. Exact adjacency and fullstatic wire retained. Isolated additional tracemalloc retained/peak and StaticIndex pickle size, excludes existing index/runtime/daemon/LSP/extension/native/RSS/truepeak and worker deserialization peak. Eager residency before first save moves existing cache cost, does not erase it. Host uncontrolled; no full readiness/global timing claim.'}, indent=2))
