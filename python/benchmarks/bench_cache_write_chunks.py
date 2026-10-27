"""Pair actual cache writes with full-string and bounded structural encoding."""
import gc
import gzip
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
from benchmarks.cache_write_candidates import iterencode_buffered, structural_chunks, sharded_maps
from benchmarks.cache_write_control import previous_write_cache_payload
from django_orm_intellisense.cache import store
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.static_index.indexer import build_static_index


def run(file_count, models, archive, repetitions=9):
    with tempfile.TemporaryDirectory(prefix='djls-cache-write-chunks-') as temporary:
        root = Path(temporary).resolve() / 'workspace'
        root.mkdir()
        generate_synthetic_project(root, models)
        helpers = root / 'helpers'
        helpers.mkdir()
        for number in range(file_count - len(list(root.rglob('*.py')))):
            (helpers / f'helper_{number}.py').write_text(f'value={number}\n')
        snapshot = snapshot_python_sources(root)
        index = build_static_index(root, snapshot.files)
        cache = root.parent / 'cache'
        with mock.patch.object(store, '_workspace_cache_dir', return_value=cache):
            store.save_static_index(root, snapshot, index)
            actual = json.loads(gzip.decompress(Path(archive).read_bytes()))
            surface = actual['surfaceIndex']
            store.save_surface_index(root, 'source', 'runtime', surface)
            payloads = {name: json.loads((cache / name).read_text()) for name in [
                store.STATIC_INDEX_CACHE_NAME, store.STATIC_INDEX_FULL_CACHE_NAME, store.SURFACE_INDEX_CACHE_NAME]}
            expected = {name: hashlib.sha256((cache / name).read_bytes()).hexdigest() for name in payloads}
            sizes = {name: (cache / name).stat().st_size for name in payloads}
        modes = {'previous-full-string': None, 'candidate-buffered-iterencode': iterencode_buffered,
                 'candidate-structural-chunks': structural_chunks,
                 'candidate-sharded-maps': sharded_maps}
        final = os.environ.get('DJLS_BENCH_FINAL_CACHE_WRITE') == '1'
        if final:
            modes = {'previous-full-string': None, 'current-sharded-atomic': None}
        samples = {mode: [] for mode in modes}
        allocation = {}

        def write_all(mode):
            for name, payload in payloads.items():
                target = cache / name
                if mode == 'previous-full-string':
                    previous_write_cache_payload(target, payload)
                elif mode == 'current-sharded-atomic':
                    store._write_cache_payload(target, payload)
                else:
                    temporary_path = target.with_suffix(target.suffix + '.tmp')
                    with temporary_path.open('w', encoding='utf-8') as stream:
                        modes[mode](stream, payload)
                    temporary_path.replace(target)

        for revision in range(repetitions):
            names = list(modes)
            order = names[revision % len(names):] + names[:revision % len(names)]
            for mode in order:
                gc.collect()
                cpu, wall = time.process_time_ns(), time.perf_counter_ns()
                write_all(mode)
                sample = {'wallMs': (time.perf_counter_ns() - wall) / 1e6,
                          'cpuMs': (time.process_time_ns() - cpu) / 1e6}
                assert all(hashlib.sha256((cache / name).read_bytes()).hexdigest() == expected[name] for name in payloads)
                sample['allThreeCacheBytesEqual'] = True
                samples[mode].append(sample)
        for mode in modes:
            gc.collect()
            tracemalloc.start(1)
            write_all(mode)
            retained, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
            assert all(hashlib.sha256((cache / name).read_bytes()).hexdigest() == expected[name] for name in payloads)
            allocation[mode] = {'additionalRetainedBytes': retained, 'additionalPeakBytes': peak}
        return {'pythonFiles': file_count, 'models': models, 'repetitions': repetitions,
            'cacheBytes': sizes, 'inputArchive': archive, 'samples': samples,
            'summary': {mode: {'wallMedianMs': statistics.median(row['wallMs'] for row in values),
                              'cpuMedianMs': statistics.median(row['cpuMs'] for row in values),
                              **allocation[mode]} for mode, values in samples.items()}}


if __name__ == '__main__':
    print(json.dumps({'date': '2026-10-09', 'productionApplied': os.environ.get('DJLS_BENCH_FINAL_CACHE_WRITE') == '1', 'rows': [
        run(1000, 100, 'bench/lsp-memory-1000-payload.json.gz'),
        run(5000, 500, 'bench/surface-decode-compaction-ready-5000-cached-payload.json.gz'),
        run(10000, 1000, 'bench/lsp-memory-10000-payload.json.gz')],
        'scope': 'Rotating9 writes ofthree actualcachepayloads per tier:staticpartial/full andrealDjango surface. Content includingmetadata/timestampsfixed samefixture. Everycachebyte hash equal tooriginal sortedJSON aftereverywrite, diskopen/write/replace included. Separate tracemalloc additionalencode/write aboveexistingpayloadfixture; excludespayloadcreation/parser/runtime/IPC/Node/wholeprocess/trueaggregatepeak/slowFS/platform. Finalmode comparesprevious writer andcurrent productionunique-temp shardedwriter; otherwise candidatesonly. Hostuncontrolled nostablepercentageglobalstartupclaim.'}, indent=2))
