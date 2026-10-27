"""Whole cache loading comparison, including current validation and fields."""
import argparse
import gc
import hashlib
import json
import os
import statistics
import tempfile
import time
import tracemalloc
from pathlib import Path
from unittest import mock

from benchmarks.bench_reindex import generate_synthetic_project
from benchmarks.static_stream_restore_candidate import (
    InplaceStaticStreamReader, OwnedKeyStaticStreamReader, candidate_module, previous_reader, reader_for,
)
from django_orm_intellisense.cache import store
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.static_index import indexer


def run(count, repetitions):
    with tempfile.TemporaryDirectory(prefix='djls-static-stream-restore-') as temporary:
        root = Path(temporary).resolve() / 'workspace'
        root.mkdir()
        generate_synthetic_project(root, count // 10)
        helper = root / 'helpers'
        helper.mkdir()
        for number in range(count - len(list(root.rglob('*.py')))):
            (helper / f'helper_{number}.py').write_text(f'value={number}\n')
        snapshot = snapshot_python_sources(root)
        initial = indexer.build_static_index(root, snapshot.files)
        expected = initial.to_cache_dict()
        expected_fields = [field.to_dict() for field in initial.fields]
        candidate = candidate_module()
        owners = {
            'current-whole-json': (indexer.StaticIndex, store._read_cache_payload),
            'candidate-streamed-modules': (candidate.StaticIndex, reader_for(candidate.ModuleIndex)),
            'candidate-inplace-hook': (candidate.StaticIndex,
                reader_for(candidate.ModuleIndex, reader_type=InplaceStaticStreamReader)),
            'candidate-owned-key-hook': (candidate.StaticIndex,
                reader_for(candidate.ModuleIndex, reader_type=OwnedKeyStaticStreamReader)),
        }
        if os.environ.get('DJLS_BENCH_CURRENT_STATIC_STREAM_RESTORE') == '1':
            owners = {'previous-whole-json': (indexer.StaticIndex, previous_reader),
                      'current-streamed-modules': (indexer.StaticIndex, store._read_cache_payload)}
        cache = root.parent / 'cache'
        with mock.patch.object(store, '_workspace_cache_dir', return_value=cache):
            store.save_static_index(root, snapshot, initial)
        raw = (cache / store.STATIC_INDEX_FULL_CACHE_NAME).read_bytes()
        samples = {mode: [] for mode in owners}
        allocations = {}

        def restore(owner):
            static_type, reader = owner
            with mock.patch.object(store, '_workspace_cache_dir', return_value=cache), \
                    mock.patch.object(store, 'StaticIndex', static_type), \
                    mock.patch.object(store, '_read_cache_payload', reader):
                loaded, hit = store.load_cached_static_index(root, snapshot)
            assert hit == 'full'
            return loaded

        def validate(loaded):
            assert loaded.to_cache_dict() == expected
            assert [field.to_dict() for field in loaded.fields] == expected_fields

        for revision in range(repetitions):
            for mode in list(owners) if revision % 2 == 0 else list(reversed(owners)):
                gc.collect()
                cpu, started = time.process_time_ns(), time.perf_counter_ns()
                loaded = restore(owners[mode])
                row = {'wallMs': (time.perf_counter_ns() - started) / 1e6,
                       'cpuMs': (time.process_time_ns() - cpu) / 1e6}
                validate(loaded)
                row['completeStaticWireAndDerivedFieldsEqual'] = True
                samples[mode].append(row)
                del loaded
        for mode, owner in owners.items():
            gc.collect()
            tracemalloc.start()
            loaded = restore(owner)
            retained, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
            validate(loaded)
            allocations[mode] = {'retainedBytes': retained, 'peakBytes': peak}
            del loaded
        return {'pythonFiles': count, 'models': count // 10, 'cacheBytes': len(raw),
                'cacheSha256': hashlib.sha256(raw).hexdigest(), 'samples': samples,
                'summary': {mode: {**{key: statistics.median(row[key] for row in values)
                    for key in ['wallMs', 'cpuMs']}, **allocations[mode]}
                    for mode, values in samples.items()}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--files', type=int, nargs='+', default=[1000, 5000, 10000])
    parser.add_argument('--repetitions', type=int, default=9)
    args = parser.parse_args()
    print(json.dumps({'date': '2026-10-10', 'productionApplied':
        os.environ.get('DJLS_BENCH_CURRENT_STATIC_STREAM_RESTORE') == '1',
        'rows': [run(count, args.repetitions) for count in args.files],
        'scope': 'Alternating whole static cache loads; schema, fingerprint and completeness gates '
                 'plus full wire and derived fields verified. Tracemalloc excludes preexisting source '
                 'owners. This is not ordinary full startup or aggregate process peak.'}, indent=2))
