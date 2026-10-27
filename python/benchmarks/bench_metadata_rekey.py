"""Paired complete graph-cache JSON decode, including immutable key pooling."""
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
from benchmarks.metadata_rekey_candidate import decode_metadata_inplace
from django_orm_intellisense.cache import store
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.runtime.inspector import inspect_runtime
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.static_index.indexer import build_static_index


def worker(count, repetitions):
    with tempfile.TemporaryDirectory(prefix='djls-metadata-rekey-') as temporary:
        root = Path(temporary).resolve() / 'project'
        root.mkdir()
        files = generate_synthetic_project(root, count // 10)
        apps = sorted({file.parent.name for file in files})
        (root / 'rekey_settings.py').write_text(f'INSTALLED_APPS={apps!r}\nSECRET_KEY="rekey"\n'
            'DEFAULT_AUTO_FIELD="django.db.models.BigAutoField"\n'
            'DATABASES={"default":{"ENGINE":"django.db.backends.sqlite3","NAME":":memory:"}}\n')
        for app in apps:
            (root / app / 'models.py').write_text('\n'.join(
                f'from .{file.stem} import Model{int(file.stem.split("_")[-1])}'
                for file in files if file.parent.name == app) + '\n')
        helpers = root / 'helpers'
        helpers.mkdir()
        for number in range(count-len(list(root.rglob('*.py')))):
            (helpers / f'helper_{number}.py').write_text(f'value={number}\n')
        snapshot = snapshot_python_sources(root)
        initial = build_static_index(root, snapshot.files)
        sys.path.insert(0, str(root))
        runtime = inspect_runtime('rekey_settings')
        assert runtime.bootstrap_status == 'ready' and runtime.model_count == count // 10
        graph = build_model_graph(initial, runtime)
        expected = store._model_graph_to_cache_dict(graph)
        cache = root.parent / 'cache'
        with mock.patch.object(store, '_workspace_cache_dir', return_value=cache):
            store.save_model_graph(root, snapshot.fingerprint, 'runtime', graph)
        modes = {'previous-new-dict': store.decode_metadata_stream, 'candidate-inplace': decode_metadata_inplace}
        samples = {mode: [] for mode in modes}
        allocations = {}

        def restore(reader):
            with mock.patch.object(store, '_workspace_cache_dir', return_value=cache), \
                    mock.patch.object(store, 'decode_metadata_stream', reader):
                return store.load_cached_model_graph(root, snapshot.fingerprint, 'runtime', static_index=initial)

        def validate(result):
            assert result is not None and store._model_graph_to_cache_dict(result) == expected
            for number in range(count // 10):
                label = f'app{number // 50}.Model{number}'
                assert result.find_field(label, 'pk') is not None
                for field in range(15):
                    assert result.find_field(label, f'field_{field}') == graph.find_field(label, f'field_{field}')
                for relation in range(2):
                    assert result.find_field(label, f'fk_{relation}_id').is_relation is False

        for revision in range(repetitions):
            order = list(modes) if revision % 2 == 0 else list(reversed(modes))
            for mode in order:
                gc.collect()
                cpu, started = time.process_time_ns(), time.perf_counter_ns()
                result = restore(modes[mode])
                row = {'wallMs': (time.perf_counter_ns()-started)/1e6, 'cpuMs': (time.process_time_ns()-cpu)/1e6}
                validate(result)
                row['completeGraphMetadataEqual'] = True
                samples[mode].append(row)
                del result
        for mode, reader in modes.items():
            gc.collect()
            tracemalloc.start()
            result = restore(reader)
            retained, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
            validate(result)
            allocations[mode] = {'retainedBytes': retained, 'peakBytes': peak}
            del result
        return {'pythonFiles': count, 'models': count // 10, 'repetitions': repetitions,
            'samples': samples, 'summary': {mode: {'wallMedianMs': statistics.median(row['wallMs'] for row in rows),
                'cpuMedianMs': statistics.median(row['cpuMs'] for row in rows), **allocations[mode]}
                for mode, rows in samples.items()}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--files', type=int, nargs='+', default=[1000, 5000, 10000])
    parser.add_argument('--repetitions', type=int, default=9)
    parser.add_argument('--worker', action='store_true')
    args = parser.parse_args()
    if args.worker:
        print(json.dumps(worker(args.files[0], args.repetitions)))
    else:
        rows = [json.loads(subprocess.check_output([sys.executable, '-m', 'benchmarks.bench_metadata_rekey',
            '--worker', '--files', str(count), '--repetitions', str(args.repetitions)], text=True)) for count in args.files]
        print(json.dumps({'productionApplied': False, 'rows': rows,
            'scope': 'Nine alternating full configured ready graph-cache restores per tier. Read-local key/value pools and complete metadata/source/runtime/schema guards retained; candidate rekeys exclusively parsed dicts in place after capturing entries. Every full graph value/pk/scalar/FK alias checked. Separate allocation above input owners; no actual startup/editor/Node/native/aggregate/stable budget claim.'}, indent=2))
