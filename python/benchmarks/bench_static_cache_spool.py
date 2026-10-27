"""Compare complete two-file static saves with a frozen timestamp and full fidelity."""
import argparse
import gc
import hashlib
import json
import statistics
import tempfile
import time
import tracemalloc
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from benchmarks.bench_reindex import generate_synthetic_project
from benchmarks.static_cache_spool_candidate import save_static_spooled, record_writer, previous_save_static_index
from django_orm_intellisense.cache import store
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.static_index.indexer import ModuleIndex, build_static_index


class Clock:
    @staticmethod
    def now(tz=None):
        return datetime(2026, 10, 9, tzinfo=timezone.utc)


def run(count, repetitions, final):
    from benchmarks import static_cache_spool_candidate as candidate
    with tempfile.TemporaryDirectory(prefix='djls-static-cache-spool-') as temporary:
        root = Path(temporary).resolve() / 'project'
        root.mkdir()
        generate_synthetic_project(root, count // 10)
        helpers = root / 'helpers'
        helpers.mkdir()
        for number in range(count - len(list(root.rglob('*.py')))):
            (helpers / f'helper_{number}.py').write_text(f'value={number}\n')
        snapshot = snapshot_python_sources(root)
        index = build_static_index(root, snapshot.files)
        cache = root.parent / 'cache'
        files = [store.STATIC_INDEX_CACHE_NAME, store.STATIC_INDEX_FULL_CACHE_NAME]
        modes = {'previous-eager-dicts': store.save_static_index, 'candidate-spooled-records': save_static_spooled}
        if final:
            modes = {'previous-eager-dicts': previous_save_static_index, 'current-spooled-records': store.save_static_index}
        original_writer = store._write_cache_json_value
        samples = {mode: [] for mode in modes}
        allocation = {}
        with mock.patch.object(store, '_workspace_cache_dir', return_value=cache), \
                mock.patch.object(store, 'datetime', Clock), mock.patch.object(candidate, 'datetime', Clock):
            previous_save_static_index(root, snapshot, index)
            hashes = {name: hashlib.sha256((cache / name).read_bytes()).hexdigest() for name in files}

            def save(mode):
                with mock.patch.object(store, '_write_cache_json_value',
                        record_writer(original_writer) if mode == 'candidate-spooled-records' else original_writer):
                    modes[mode](root, snapshot, index)

            for revision in range(repetitions):
                order = list(modes) if revision % 2 == 0 else list(reversed(modes))
                for mode in order:
                    gc.collect()
                    cpu, started = time.process_time_ns(), time.perf_counter_ns()
                    save(mode)
                    row = {'wallMs': (time.perf_counter_ns() - started) / 1e6,
                           'cpuMs': (time.process_time_ns() - cpu) / 1e6}
                    assert all(hashlib.sha256((cache / name).read_bytes()).hexdigest() == hashes[name] for name in files)
                    row['bothCacheBytesEqual'] = True
                    samples[mode].append(row)
            calls = {}
            for mode in modes:
                gc.collect()
                counter = Counter()
                original_to_dict = ModuleIndex.to_dict
                def to_dict(module):
                    counter[module.module_name] += 1
                    return original_to_dict(module)
                with mock.patch.object(ModuleIndex, 'to_dict', to_dict):
                    tracemalloc.start()
                    save(mode)
                    retained, peak = tracemalloc.get_traced_memory()
                    tracemalloc.stop()
                assert counter == {name: 1 for name in index.modules}
                assert all(hashlib.sha256((cache / name).read_bytes()).hexdigest() == hashes[name] for name in files)
                allocation[mode] = {'additionalRetainedBytes': retained, 'additionalPeakBytes': peak}
                calls[mode] = sum(counter.values())
            restored, hit = store.load_cached_static_index(root, snapshot)
            assert hit == 'full' and restored.to_cache_dict() == index.to_cache_dict() and restored.fields == index.fields
        return {'pythonFiles': count, 'models': count // 10, 'repetitions': repetitions, 'samples': samples,
            'moduleConversions': calls, 'cacheBytes': {name: (cache / name).stat().st_size for name in files},
            'summary': {mode: {'wallMedianMs': statistics.median(row['wallMs'] for row in rows),
                'cpuMedianMs': statistics.median(row['cpuMs'] for row in rows), **allocation[mode]}
                for mode, rows in samples.items()}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--files', type=int, nargs='+', default=[1000, 5000, 10000])
    parser.add_argument('--repetitions', type=int, default=9)
    parser.add_argument('--final', action='store_true')
    args = parser.parse_args()
    print(json.dumps({'productionApplied': args.final, 'rows': [run(count, args.repetitions, args.final) for count in args.files],
        'scope': 'Alternating complete partial+full static cache saves with fixed timestamps. Every output byte hash preserved, module conversion exactly once across both files, full static/field restore verified. Separate traced encoding/serialization allocation above source/index fixture. Spool includes temporary file I/O; host uncontrolled, no whole daemon/Node/native/aggregate peak or stable startup proof.'}, indent=2))
