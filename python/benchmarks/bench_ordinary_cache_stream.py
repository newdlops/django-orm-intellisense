"""Compare full static/graph cache restore without dropping ready-runtime data."""
import argparse
import gc
import json
import statistics
import subprocess
import sys
import tempfile
import time
import tracemalloc
from pathlib import Path
from unittest import mock

from benchmarks.bench_reindex import generate_synthetic_project
from benchmarks.ordinary_cache_stream_candidate import candidate_module, previous_module, graph_only_module
from django_orm_intellisense.cache import store
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.runtime.inspector import inspect_runtime
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.static_index.indexer import build_static_index


def worker(count, repetitions, variants, final):
    with tempfile.TemporaryDirectory(prefix='djls-ordinary-cache-stream-') as temporary:
        root = Path(temporary).resolve() / 'project'
        root.mkdir()
        files = generate_synthetic_project(root, count // 10)
        apps = sorted({file.parent.name for file in files})
        (root / 'ordinary_settings.py').write_text(f'INSTALLED_APPS={apps!r}\nSECRET_KEY="stream"\n'
            'DEFAULT_AUTO_FIELD="django.db.models.BigAutoField"\n'
            'DATABASES={"default":{"ENGINE":"django.db.backends.sqlite3","NAME":":memory:"}}\n')
        for app in apps:
            (root / app / 'models.py').write_text('\n'.join(
                f'from .{file.stem} import Model{int(file.stem.split("_")[-1])}'
                for file in files if file.parent.name == app) + '\n')
        helpers = root / 'helpers'
        helpers.mkdir()
        for number in range(count - len(list(root.rglob('*.py')))):
            (helpers / f'helper_{number}.py').write_text(f'value={number}\n')
        snapshot = snapshot_python_sources(root)
        initial = build_static_index(root, snapshot.files)
        sys.path.insert(0, str(root))
        runtime = inspect_runtime('ordinary_settings')
        assert runtime.bootstrap_status == 'ready' and runtime.model_count == count // 10
        initial_graph = build_model_graph(initial, runtime)
        expected_static = initial.to_cache_dict()
        expected_fields = [store._field_candidate_to_cache_dict(field) for field in initial.fields]
        expected_graph = store._model_graph_to_cache_dict(initial_graph)
        cache = root.parent / 'cache'
        with mock.patch.object(store, '_workspace_cache_dir', return_value=cache):
            store.save_static_index(root, snapshot, initial)
            store.save_model_graph(root, snapshot.fingerprint, 'runtime', initial_graph)
        modes = {'previous-text': store, 'candidate-fused-stream': candidate_module()}
        if final:
            modes = {'previous-text': previous_module(), 'current-graph-stream': store}
        if variants:
            modes['candidate-two-pass-stream'] = candidate_module(fused=False)
            if final:
                modes['candidate-graph-only-stream'] = graph_only_module()
        samples = {mode: [] for mode in modes}
        allocations = {}

        def restore(module):
            with mock.patch.object(module, '_workspace_cache_dir', return_value=cache):
                static, hit = module.load_cached_static_index(root, snapshot)
                assert hit == 'full'
                graph = module.load_cached_model_graph(root, snapshot.fingerprint, 'runtime', static_index=static)
            return static, graph

        def validate(static, graph):
            assert static.to_cache_dict() == expected_static
            assert [store._field_candidate_to_cache_dict(field) for field in static.fields] == expected_fields
            assert graph is not None and store._model_graph_to_cache_dict(graph) == expected_graph
            assert {name: tuple(node.label for node in nodes) for name, nodes in graph.nodes_by_object_name.items()} == {
                name: tuple(node.label for node in nodes) for name, nodes in initial_graph.nodes_by_object_name.items()}
            for number in range(count // 10):
                label = f'app{number // 50}.Model{number}'
                assert graph.find_field(label, 'pk') is not None
                for relation in range(2):
                    assert graph.find_field(label, f'fk_{relation}_id').is_relation is False

        for revision in range(repetitions):
            names = list(modes)
            order = names[revision % len(names):] + names[:revision % len(names)]
            for mode in order:
                gc.collect()
                cpu, started = time.process_time_ns(), time.perf_counter_ns()
                static, graph = restore(modes[mode])
                row = {'wallMs': (time.perf_counter_ns() - started) / 1e6,
                       'cpuMs': (time.process_time_ns() - cpu) / 1e6}
                validate(static, graph)
                row['completeStaticFieldsAndGraphEqual'] = True
                samples[mode].append(row)
                del static, graph
        for mode in modes:
            gc.collect()
            tracemalloc.start()
            static, graph = restore(modes[mode])
            retained, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
            validate(static, graph)
            allocations[mode] = {'additionalRetainedBytes': retained, 'additionalPeakBytes': peak}
            del static, graph
        return {'pythonFiles': count, 'models': count // 10, 'repetitions': repetitions,
            'readyRuntime': True, 'samples': samples, 'summary': {mode: {
                'wallMedianMs': statistics.median(row['wallMs'] for row in rows),
                'cpuMedianMs': statistics.median(row['cpuMs'] for row in rows), **allocations[mode]}
                for mode, rows in samples.items()}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--files', type=int, nargs='+', default=[1000, 5000, 10000])
    parser.add_argument('--repetitions', type=int, default=9)
    parser.add_argument('--variants', action='store_true')
    parser.add_argument('--worker', action='store_true')
    parser.add_argument('--final', action='store_true')
    args = parser.parse_args()
    if args.worker:
        print(json.dumps(worker(args.files[0], args.repetitions, args.variants, args.final)))
    else:
        rows = []
        for count in args.files:
            command = [sys.executable, '-m', 'benchmarks.bench_ordinary_cache_stream', '--worker',
                       '--files', str(count), '--repetitions', str(args.repetitions)]
            if args.variants:
                command.append('--variants')
            if args.final:
                command.append('--final')
            rows.append(json.loads(subprocess.check_output(command, text=True)))
        print(json.dumps({'productionApplied': args.final, 'rows': rows,
            'scope': 'Rotating complete static/full model-graph cache restore pairs on actual ready Django metadata. Full static cache, every resolved field, complete graph and name map/pk/FK aliases preserved per call. Separate traced allocation above existing fixtures. Source/schema/runtime checks unchanged; host uncontrolled, not whole startup, source-race, Node/native/editor/aggregate peak or stable budget proof.'}, indent=2))
