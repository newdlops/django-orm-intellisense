"""Compare decode-time callbacks to an exhaustive post-decode string walk."""
import gc
import json
import statistics
import tempfile
import time
import tracemalloc
from pathlib import Path
from unittest import mock

from benchmarks.bench_reindex import generate_synthetic_project
from django_orm_intellisense.cache import store
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.static_index.indexer import build_static_index


def walk_decoder(raw):
    if hasattr(raw, 'read'):
        raw = raw.read()
    result = json.loads(raw)
    strings = {}
    share = strings.setdefault
    keys = store._CACHE_STRING_FIELDS
    pending = [result]
    while pending:
        value = pending.pop()
        if type(value) is dict:
            metadata = 'filePath' in value
            for key, item in value.items():
                kind = type(item)
                if kind is dict or kind is list:
                    pending.append(item)
                elif metadata and key in keys and kind is str:
                    value[key] = share(item, item)
        elif type(value) is list:
            for item in value:
                kind = type(item)
                if kind is dict or kind is list:
                    pending.append(item)
    return result


def run(files, models, repetitions=9):
    with tempfile.TemporaryDirectory(prefix='djls-cache-pool-walk-') as temporary:
        root = Path(temporary).resolve() / 'workspace'
        root.mkdir()
        generate_synthetic_project(root, models)
        helpers = root / 'helpers'
        helpers.mkdir()
        for number in range(files - len(list(root.rglob('*.py')))):
            (helpers / f'helper_{number}.py').write_text(f'value={number}\n')
        snapshot = snapshot_python_sources(root)
        assert snapshot.file_count == files
        expected = build_static_index(root, snapshot.files)
        expected_wire = expected.to_cache_dict()
        readers = {'current-object-hook': store._decode_cache_payload, 'candidate-post-walk': walk_decoder}
        samples = {name: [] for name in readers}
        allocations = {}
        with mock.patch.object(store, '_workspace_cache_dir', return_value=root.parent / 'cache'):
            store.save_static_index(root, snapshot, expected)
            for revision in range(repetitions):
                order = list(readers) if revision % 2 == 0 else list(reversed(readers))
                for name in order:
                    gc.collect()
                    with mock.patch.object(store, '_decode_cache_payload', readers[name]):
                        cpu, wall = time.process_time_ns(), time.perf_counter_ns()
                        restored, hit = store.load_cached_static_index(root, snapshot)
                        sample = {'wallMs': (time.perf_counter_ns() - wall) / 1e6,
                                  'cpuMs': (time.process_time_ns() - cpu) / 1e6}
                    assert hit == 'full' and restored.to_cache_dict() == expected_wire
                    assert restored.fields == expected.fields
                    sample['completeStaticWireAndFieldsEqual'] = True
                    samples[name].append(sample)
                    del restored
            for name in readers:
                gc.collect()
                tracemalloc.start(1)
                with mock.patch.object(store, '_decode_cache_payload', readers[name]):
                    restored, hit = store.load_cached_static_index(root, snapshot)
                current, peak = tracemalloc.get_traced_memory()
                tracemalloc.stop()
                assert hit == 'full' and restored.to_cache_dict() == expected_wire
                allocations[name] = {'retainedBytes': current, 'peakBytes': peak}
                del restored
        return {'pythonFiles': files, 'models': models, 'repetitions': repetitions,
            'samples': samples, 'summary': {name: {
                'wallMedianMs': statistics.median(sample['wallMs'] for sample in values),
                'cpuMedianMs': statistics.median(sample['cpuMs'] for sample in values),
                **allocations[name]} for name, values in samples.items()}}


if __name__ == '__main__':
    print(json.dumps({'date': '2026-10-09', 'productionApplied': False,
        'rows': [run(1000, 100), run(5000, 500), run(10000, 1000)],
        'scope': 'Alternating9 complete real static cache restores per tier. Full static wire and fields equal each call; source checks/cache formats unchanged. Allocation samples separate from wall/processCPU, cache-load-only retained/peak excludes existing fixture and daemon/runtime/Node/aggregate memory. Exhaustive walk keeps nested metadata semantics but may add traversal and unpooled decode peak. Host uncontrolled, no stable percentage or whole startup proof.'}, indent=2))
