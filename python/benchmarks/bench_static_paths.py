"""Compare complete cold builds and partial cache restores, changing path work only."""
import argparse
import gc
import json
import statistics
import tempfile
import time
import tracemalloc
from pathlib import Path
from unittest import mock

from benchmarks.bench_reindex import generate_synthetic_project
from benchmarks.static_path_candidate import alternate_module
from django_orm_intellisense.cache import store
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.static_index import indexer


def run(file_count, repetitions, final):
    with tempfile.TemporaryDirectory(prefix='djls-static-paths-') as temporary:
        root = Path(temporary).resolve() / 'project'
        root.mkdir()
        models = generate_synthetic_project(root, file_count // 10)
        helpers = root / 'helpers'
        helpers.mkdir()
        for number in range(file_count - len(list(root.rglob('*.py')))):
            (helpers / f'helper_{number}.py').write_text(f'value={number}\n')
        snapshot = snapshot_python_sources(root)
        initial = indexer.build_static_index(root, snapshot.files)
        cache = root.parent / 'cache'
        with mock.patch.object(store, '_workspace_cache_dir', return_value=cache):
            store.save_static_index(root, snapshot, initial)
        models[0].write_text(models[0].read_text().replace('field_0 = models.CharField', 'field_0 = models.TextField'))
        current = snapshot_python_sources(root)
        expected = indexer.build_static_index(root, current.files)
        expected_wire = expected.to_cache_dict()
        modes = ({'previous-pathlib': alternate_module(previous=True), 'current-lexical': indexer}
                 if final else {'previous-pathlib': indexer, 'candidate-lexical': alternate_module()})

        def operation(stage, module):
            if stage == 'cold':
                return module.build_static_index(root, current.files)
            with mock.patch.object(store, '_workspace_cache_dir', return_value=cache), \
                 mock.patch.object(store, 'build_static_index', module.build_static_index):
                result, hit = store.load_cached_static_index(root, current)
            assert hit == 'partial'
            return result

        results = {}
        for stage in ['cold', 'partial']:
            samples = {mode: [] for mode in modes}
            for round_number in range(repetitions):
                order = list(modes) if round_number % 2 == 0 else list(reversed(modes))
                for mode in order:
                    gc.collect()
                    cpu, started = time.process_time_ns(), time.perf_counter_ns()
                    result = operation(stage, modes[mode])
                    row = {'wallMs': (time.perf_counter_ns() - started) / 1e6,
                           'cpuMs': (time.process_time_ns() - cpu) / 1e6}
                    assert result.to_cache_dict() == expected_wire
                    assert [field.to_dict() for field in result.fields] == [field.to_dict() for field in expected.fields]
                    row['completeStaticWireAndFieldsEqual'] = True
                    samples[mode].append(row)
                    del result
            paths = {}
            allocations = {}
            for mode, module in modes.items():
                path_calls = 0
                original_relative_to = Path.relative_to
                def relative_to(path, *args, **kwargs):
                    nonlocal path_calls
                    path_calls += 1
                    return original_relative_to(path, *args, **kwargs)
                with mock.patch.object(Path, 'relative_to', relative_to):
                    result = operation(stage, module)
                assert result.to_cache_dict() == expected_wire
                paths[mode] = path_calls
                del result
                gc.collect()
                tracemalloc.start()
                baseline, _ = tracemalloc.get_traced_memory()
                result = operation(stage, module)
                retained, peak = tracemalloc.get_traced_memory()
                tracemalloc.stop()
                assert result.to_cache_dict() == expected_wire
                allocations[mode] = {'additionalRetainedBytes': retained - baseline,
                                     'additionalPeakBytes': peak - baseline}
                del result
            results[stage] = {'samples': samples, 'relativeToCalls': paths, 'allocations': allocations,
                'summary': {mode: {'wallMedianMs': statistics.median(row['wallMs'] for row in rows),
                                   'cpuMedianMs': statistics.median(row['cpuMs'] for row in rows)}
                            for mode, rows in samples.items()}}
        return {'pythonFiles': file_count, 'models': file_count // 10, 'repetitions': repetitions,
                'stages': results}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--files', type=int, nargs='+', default=[1000, 5000, 10000])
    parser.add_argument('--repetitions', type=int, default=7)
    parser.add_argument('--final', action='store_true')
    args = parser.parse_args()
    print(json.dumps({'productionApplied': args.final,
        'rows': [run(count, args.repetitions, args.final) for count in args.files],
        'scope': 'Alternating complete cold index builds and full+partial cache restores after actual CharField-to-TextField source edit. Same source inventory, parser, 8 threads, 64-file windows and source ordering. Every result matches complete cache wire and fields. Separate relative_to counts and one traced allocation probe per mode/stage. Host uncontrolled, warm filesystem, diagnostic GC; excludes Django/daemon/Node/editor/aggregate peak/stable startup or platform proof.'}, indent=2))
