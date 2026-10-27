"""Full static cache restore and input ownership on exact source tiers."""
import argparse
import gc
import hashlib
import json
import statistics
import tempfile
import time
import tracemalloc
from pathlib import Path
from unittest import mock

from benchmarks.bench_reindex import generate_synthetic_project
from benchmarks.static_restore_copy_candidate import candidate_module
from django_orm_intellisense.cache import store
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.static_index import indexer


def run(count, repetitions):
    with tempfile.TemporaryDirectory(prefix='djls-static-restore-copies-') as temporary:
        root = Path(temporary).resolve() / 'workspace'
        root.mkdir()
        generate_synthetic_project(root, count//10)
        helper = root / 'helpers'
        helper.mkdir()
        for number in range(count-len(list(root.rglob('*.py')))):
            (helper / f'helper_{number}.py').write_text(f'value={number}\n')
        snapshot = snapshot_python_sources(root)
        initial = indexer.build_static_index(root, snapshot.files)
        expected = initial.to_cache_dict()
        expected_fields = [field.to_dict() for field in initial.fields]
        candidate = candidate_module()
        owners = {'current-defensive-copies': indexer.StaticIndex, 'candidate-exact-dict-input': candidate.StaticIndex}
        cache = root.parent / 'cache'
        with mock.patch.object(store, '_workspace_cache_dir', return_value=cache):
            store.save_static_index(root, snapshot, initial)
        cache_path = cache / store.STATIC_INDEX_FULL_CACHE_NAME
        raw = cache_path.read_bytes()
        samples = {mode: [] for mode in owners}
        allocations = {}

        def restore(owner):
            module_owner = candidate if owner is candidate.StaticIndex else indexer
            with mock.patch.object(store, '_workspace_cache_dir', return_value=cache), \
                    mock.patch.object(store, 'StaticIndex', owner), \
                    mock.patch.object(store, 'ModuleIndex', module_owner.ModuleIndex):
                loaded, hit = store.load_cached_static_index(root, snapshot)
            assert hit == 'full'
            return loaded

        def validate(loaded):
            assert loaded.to_cache_dict() == expected
            assert [field.to_dict() for field in loaded.fields] == expected_fields

        for revision in range(repetitions):
            for mode in list(owners) if revision%2==0 else list(reversed(owners)):
                gc.collect()
                cpu, started = time.process_time_ns(), time.perf_counter_ns()
                loaded = restore(owners[mode])
                row = {'wallMs': (time.perf_counter_ns()-started)/1e6,
                    'cpuMs': (time.process_time_ns()-cpu)/1e6}
                validate(loaded)
                row['completeStaticWireAndFieldsEqual'] = True
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
        parsed = store._read_cache_payload(cache_path)['payload']
        wire = json.dumps(parsed, sort_keys=True)
        loaded = candidate.StaticIndex.from_cache_dict(parsed)
        assert json.dumps(parsed, sort_keys=True) == wire
        target = next(value for value in parsed['modules'].values() if value.get('modelCandidates'))
        target['definedSymbols'].append('CallerOnlySymbol')
        target['modelCandidates'][0]['baseClassRefs'].append('CallerOnlyBase')
        target['pendingFields'][0]['constructorImports'].append('CallerOnlyImport')
        assert loaded.to_cache_dict() == expected
        return {'pythonFiles': count, 'models': count//10, 'cacheBytes': len(raw),
            'cacheSha256': hashlib.sha256(raw).hexdigest(), 'samples': samples,
            'inputNotMutatedAndCallerMutationIndependent': True,
            'summary': {mode: {**{key: statistics.median(row[key] for row in values)
                for key in ['wallMs', 'cpuMs']}, **allocations[mode]} for mode, values in samples.items()}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--files', type=int, nargs='+', default=[1000, 5000, 10000])
    parser.add_argument('--repetitions', type=int, default=9)
    args = parser.parse_args()
    print(json.dumps({'date': '2026-10-11', 'productionApplied': False,
        'rows': [run(count, args.repetitions) for count in args.files],
        'scope': f'{args.repetitions} alternating complete full-static-cache loads per source tier, including JSON decode, module/model/field hydration, source-count/schema/fingerprint guards. Candidate avoids six exact-dict intermediate copies but preserves dict-subclass copies and read-only hydration/caller ownership semantics. Every wire value and derived field checked; traced allocations exclude source/input owners. No actual-startup/RPC/editor/aggregate-peak/all-platform claim.'}, indent=2))
