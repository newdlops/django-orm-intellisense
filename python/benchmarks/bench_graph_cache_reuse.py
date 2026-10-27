"""Compare complete ready-runtime graph restores with exact immutable reuse."""
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
from benchmarks.graph_cache_reuse_candidate import candidate_module, previous_module
from django_orm_intellisense.cache import store
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.runtime.inspector import inspect_runtime
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.static_index.indexer import build_static_index


def worker(file_count, repetitions, final):
    with tempfile.TemporaryDirectory(prefix='djls-graph-cache-reuse-') as temporary:
        root = Path(temporary).resolve() / 'project'
        root.mkdir()
        models = generate_synthetic_project(root, file_count // 10)
        apps = sorted({file.parent.name for file in models})
        (root / 'graph_settings.py').write_text(f'INSTALLED_APPS={apps!r}\nSECRET_KEY="graph"\n'
            'DEFAULT_AUTO_FIELD="django.db.models.BigAutoField"\n'
            'DATABASES={"default":{"ENGINE":"django.db.backends.sqlite3","NAME":":memory:"}}\n')
        for app in apps:
            (root / app / 'models.py').write_text('\n'.join(
                f'from .{file.stem} import Model{int(file.stem.split("_")[-1])}'
                for file in models if file.parent.name == app) + '\n')
        helpers = root / 'helpers'
        helpers.mkdir()
        for number in range(file_count - len(list(root.rglob('*.py')))):
            (helpers / f'helper_{number}.py').write_text(f'value={number}\n')
        snapshot = snapshot_python_sources(root)
        initial = build_static_index(root, snapshot.files)
        sys.path.insert(0, str(root))
        runtime = inspect_runtime('graph_settings')
        assert runtime.bootstrap_status == 'ready' and runtime.model_count == file_count // 10
        graph = build_model_graph(initial, runtime)
        expected_wire = store._model_graph_to_cache_dict(graph)
        expected_by_name = {name: tuple(node.label for node in nodes)
                            for name, nodes in graph.nodes_by_object_name.items()}
        cache = root.parent / 'cache'
        with mock.patch.object(store, '_workspace_cache_dir', return_value=cache):
            store.save_static_index(root, snapshot, initial)
            store.save_model_graph(root, snapshot.fingerprint, 'runtime', graph)
            index, hit = store.load_cached_static_index(root, snapshot)
        assert hit == 'full' and index.to_cache_dict() == initial.to_cache_dict()
        candidate = store if final else candidate_module()
        previous = previous_module() if final else store
        modes = {'previous-independent': False, 'current-reuse' if final else 'candidate-reuse': True}
        samples = {mode: [] for mode in modes}
        allocation = {}
        identities = {}

        def restore(reuse):
            module = candidate if reuse else previous
            with mock.patch.object(module, '_workspace_cache_dir', return_value=cache):
                return module.load_cached_model_graph(root, snapshot.fingerprint, 'runtime',
                    **({'static_index': index} if reuse else {}))

        def validate(result):
            assert result is not None and store._model_graph_to_cache_dict(result) == expected_wire
            assert {name: tuple(node.label for node in nodes) for name, nodes in result.nodes_by_object_name.items()} == expected_by_name
            assert {path: node.label for path, node in result.node_by_import_path.items()} == {
                path: node.label for path, node in graph.node_by_import_path.items()}
            for number in range(file_count // 10):
                label = f'app{number // 50}.Model{number}'
                for field in range(15):
                    assert result.find_field(label, f'field_{field}') is not None
                for relation in range(2):
                    target = (number + relation + 1) % (file_count // 10)
                    assert result.find_field(label, f'fk_{relation}').related_model_label == f'app{target // 50}.Model{target}'
                    assert result.find_field(label, f'fk_{relation}_id').is_relation is False
                assert result.find_field(label, 'pk') is not None

        for revision in range(repetitions):
            order = list(modes) if revision % 2 == 0 else list(reversed(modes))
            for mode in order:
                gc.collect()
                cpu, started = time.process_time_ns(), time.perf_counter_ns()
                result = restore(modes[mode])
                row = {'wallMs': (time.perf_counter_ns() - started) / 1e6,
                       'cpuMs': (time.process_time_ns() - cpu) / 1e6}
                validate(result)
                row['completeGraphMetadataEqual'] = True
                samples[mode].append(row)
                del result
        for mode in modes:
            gc.collect()
            tracemalloc.start()
            result = restore(modes[mode])
            retained, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
            validate(result)
            identities[mode] = sum(field is index.find_field(field.model_label, field.name)
                for fields in result.fields_by_model_label.values() for field in fields.values())
            allocation[mode] = {'additionalRetainedBytes': retained, 'additionalPeakBytes': peak}
            del result
        assert identities['previous-independent'] == 0 and max(identities.values()) > 0
        return {'pythonFiles': file_count, 'models': file_count // 10, 'repetitions': repetitions,
            'readyRuntime': True, 'graphCacheBytes': (cache / store.MODEL_GRAPH_CACHE_NAME).stat().st_size,
            'samples': samples, 'reusedFieldIdentities': identities, 'summary': {mode: {
                'wallMedianMs': statistics.median(row['wallMs'] for row in rows),
                'cpuMedianMs': statistics.median(row['cpuMs'] for row in rows), **allocation[mode]}
                for mode, rows in samples.items()}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--files', type=int, nargs='+', default=[1000, 5000, 10000])
    parser.add_argument('--repetitions', type=int, default=9)
    parser.add_argument('--worker', action='store_true')
    parser.add_argument('--final', action='store_true')
    args = parser.parse_args()
    if args.worker:
        print(json.dumps(worker(args.files[0], args.repetitions, args.final)))
    else:
        rows = []
        for count in args.files:
            command = [sys.executable, '-m', 'benchmarks.bench_graph_cache_reuse', '--worker',
                       '--files', str(count), '--repetitions', str(args.repetitions)]
            if args.final:
                command.append('--final')
            rows.append(json.loads(subprocess.check_output(command, text=True)))
        print(json.dumps({'productionApplied': args.final, 'rows': rows,
            'scope': 'Alternating complete model graph cache loads from an actual configured ready Django runtime and a restored static index. Metadata/fingerprint checks, all graph cache values, object-name/import-path maps, scalars/FKs/pk/attname aliases compared each call. Separate tracemalloc probes above existing input owners. Exact immutable fields only; containers and runtime summaries remain independently restored. Host uncontrolled; excludes full daemon startup, Node/editor/native/aggregate peak or stable budget proof.'}, indent=2))
