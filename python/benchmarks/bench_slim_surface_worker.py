"""Actual spawn/state-file/prebuild/response/shutdown on unchanged metadata."""
import gc
import json
import multiprocessing
import statistics
import tempfile
import time
import tracemalloc
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from benchmarks.bench_reindex import generate_synthetic_project
from benchmarks.slim_surface_worker_tasks import after_surface_return, initialize_profiled, task
from django_orm_intellisense.features.orm_members import prebuild_runtime_workspace_paths
from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.server import app
from django_orm_intellisense.static_index.indexer import build_static_index


def run(count, repetitions=5):
    with tempfile.TemporaryDirectory(prefix='djls-slim-surface-worker-') as temporary:
        root = Path(temporary).resolve()
        generate_synthetic_project(root, count // 10)
        helpers = root / 'helpers'
        helpers.mkdir()
        for number in range(count - len(list(root.rglob('*.py')))):
            (helpers / f'helper_{number}.py').write_text(f'value={number}\n')
        static = build_static_index(root)
        runtime = create_pending_runtime_inspection(None)
        graph = build_model_graph(static, runtime)
        prebuild_runtime_workspace_paths(static, runtime)
        modes = ['previous', 'candidate']
        samples = {mode: [] for mode in modes}
        allocation = {}
        expected = None

        def work(mode):
            wall, cpu = time.perf_counter_ns(), time.process_time_ns()
            with app.surface_worker_state_file(static, runtime, graph) as name:
                state_write = {'parentStateWriteWallMs': (time.perf_counter_ns() - wall) / 1e6,
                               'parentStateWriteCpuMs': (time.process_time_ns() - cpu) / 1e6,
                               'stateFileBytes': Path(name).stat().st_size}
                with ProcessPoolExecutor(max_workers=1, mp_context=multiprocessing.get_context('spawn'),
                        initializer=initialize_profiled, initargs=(mode, name)) as pool:
                    result = pool.submit(task, mode).result()
                    result.update(pool.submit(after_surface_return).result())
                    result.update(state_write)
                assert Path(name).exists()
            assert not Path(name).exists()
            return result

        def validate(mode, result):
            nonlocal expected
            surface = result.pop('surface')
            if expected is None:
                expected = surface
            else:
                assert surface == expected
            assert len(surface) == count // 10
            for number in range(count // 10):
                label = f'app{number // 50}.Model{number}'
                assert len([name for name in surface[label]['instance'] if name.startswith('field_')]) == 15
                for relation in range(2):
                    target = (number + relation + 1) % (count // 10)
                    assert surface[label]['instance'][f'fk_{relation}'][1] == f'app{target // 50}.Model{target}'
            assert result['childImportedRpcDaemon'] is (mode == 'previous')
            result['completeSurfaceAllScalarsAndRelationsEqual'] = True

        for revision in range(repetitions):
            for mode in modes if revision % 2 == 0 else list(reversed(modes)):
                gc.collect()
                cpu, wall = time.process_time_ns(), time.perf_counter_ns()
                result = work(mode)
                row = {'wallMs': (time.perf_counter_ns() - wall) / 1e6,
                       'parentCpuMs': (time.process_time_ns() - cpu) / 1e6}
                validate(mode, result)
                samples[mode].append({**row, **result})
        for mode in modes:
            gc.collect()
            tracemalloc.start()
            result = work(mode)
            retained, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
            validate(mode, result)
            allocation[mode] = {'parentRetainedBytes': retained, 'parentPeakBytes': peak}
        return {'pythonFiles': count, 'models': count // 10, 'samples': samples,
            'summary': {mode: {**{key: statistics.median(row[key] for row in values)
                for key in ['wallMs', 'parentCpuMs', 'parentStateWriteWallMs', 'parentStateWriteCpuMs',
                    'stateFileBytes', 'childInitializeWallMs', 'childInitializeCpuMs',
                    'childPrebuildWallMs', 'childPrebuildCpuMs', 'childCpuAtCompletionMs',
                    'childCpuAfterSurfaceReturnMs', 'childPeakRssThroughSurfaceReturnBytes', 'childModuleCount']},
                **allocation[mode]} for mode, values in samples.items()}}


def main():
    print(json.dumps({'productionApplied': False, 'rows': [run(count) for count in [1000, 5000, 10000]],
        'scope': 'Actual fresh spawn worker/state-file/complete prebuild/return/marker/shutdown; execute driver '
                 'from python -c so child main reconstruction does not import the driver/daemon. '
                 'Every complete surface/scalar/FK checked and child module absence verified. '
                 'Profiled initializer includes daemon/candidate imports and file load. Child OS high-water '
                 'RSS sampled after the complete surface was returned, before trivial marker/shutdown; '
                 'not aggregate process-tree/native/Node memory. Pending runtime fixture; no actual '
                 'configured daemon/editor or stable startup claim.'}, indent=2))
