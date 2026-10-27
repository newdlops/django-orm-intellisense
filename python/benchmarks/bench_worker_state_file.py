"""Pair actual spawn worker startup with direct versus private-file state."""
import argparse
import gc
import hashlib
import json
import multiprocessing
import statistics
import tempfile
import time
import tracemalloc
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from benchmarks.bench_reindex import generate_synthetic_project
from benchmarks.worker_state_candidate import state_file, initialize_from_file
from django_orm_intellisense.cache import store
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.server import app
from django_orm_intellisense.static_index.indexer import build_static_index


def state_digest():
    index, runtime, graph = app._worker_static_index, app._worker_runtime, app._worker_model_graph
    raw = json.dumps({'static': index.to_cache_dict(), 'fields': [store._field_candidate_to_cache_dict(field) for field in index.fields],
        'runtime': runtime.to_cache_dict(), 'graph': store._model_graph_to_cache_dict(graph)}, sort_keys=True).encode()
    return hashlib.sha256(raw).hexdigest()


def run(count, repetitions, final):
    with tempfile.TemporaryDirectory(prefix='djls-worker-state-file-') as directory:
        root = Path(directory).resolve()
        generate_synthetic_project(root, count // 10)
        helpers = root / 'helpers'
        helpers.mkdir()
        for number in range(count - len(list(root.rglob('*.py')))):
            (helpers / f'helper_{number}.py').write_text(f'value={number}\n')
        snapshot = snapshot_python_sources(root)
        index = build_static_index(root, snapshot.files)
        runtime = create_pending_runtime_inspection(None)
        graph = build_model_graph(index, runtime)
        app._init_bg_worker(index, runtime, graph)
        expected = state_digest()
        file_mode = 'current-private-file' if final else 'candidate-private-file'
        modes = ['previous-direct-initargs', file_mode]
        samples = {mode: [] for mode in modes}
        allocation = {}

        def work(mode):
            if mode == 'previous-direct-initargs':
                with ProcessPoolExecutor(max_workers=1, mp_context=multiprocessing.get_context('spawn'),
                        initializer=app._init_bg_worker, initargs=(index, runtime, graph)) as pool:
                    return pool.submit(state_digest).result()
            if final:
                context = app.surface_worker_state_file(index, runtime, graph)
                initializer = app._init_bg_worker_from_file
            else:
                context = state_file(index, runtime, graph)
                initializer = initialize_from_file
            with context as path:
                with ProcessPoolExecutor(max_workers=1, mp_context=multiprocessing.get_context('spawn'),
                        initializer=initializer, initargs=(path,)) as pool:
                    result = pool.submit(state_digest).result()
                assert Path(path).exists()
            assert not Path(path).exists()
            return result

        for revision in range(repetitions):
            for mode in modes if revision % 2 == 0 else list(reversed(modes)):
                gc.collect()
                cpu, started = time.process_time_ns(), time.perf_counter_ns()
                result = work(mode)
                row = {'wallMs': (time.perf_counter_ns() - started) / 1e6,
                       'parentCpuMs': (time.process_time_ns() - cpu) / 1e6}
                assert result == expected
                row['completeWorkerStateEqual'] = True
                samples[mode].append(row)
        for mode in modes:
            gc.collect()
            tracemalloc.start()
            result = work(mode)
            retained, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
            assert result == expected
            allocation[mode] = {'parentAdditionalRetainedBytes': retained, 'parentAdditionalPeakBytes': peak}
        return {'pythonFiles': count, 'models': count // 10, 'repetitions': repetitions,
            'samples': samples, 'summary': {mode: {'wallMedianMs': statistics.median(row['wallMs'] for row in rows),
                'parentCpuMedianMs': statistics.median(row['parentCpuMs'] for row in rows), **allocation[mode]}
                for mode, rows in samples.items()}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--files', type=int, nargs='+', default=[1000, 5000, 10000])
    parser.add_argument('--repetitions', type=int, default=5)
    parser.add_argument('--final', action='store_true')
    args = parser.parse_args()
    print(json.dumps({'productionApplied': args.final, 'rows': [run(count, args.repetitions, args.final) for count in args.files],
        'scope': 'Alternating actual spawn/initialize/one complete state-digest task/shutdown; file lifetime covers pool shutdown and complete static/fields/runtime/graph state preserved. Parent process CPU and separate parent-only traced allocations; pending runtime, excludes child/Node/native/aggregate peak, actual full surface processing or stable startup/RPC proof.'}, indent=2))
