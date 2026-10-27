"""Pair complete real surface cache loads with late and per-model compaction."""
import gc
import gzip
import hashlib
import json
import statistics
import tempfile
import time
import tracemalloc
from pathlib import Path
from unittest import mock

from django_orm_intellisense.cache import store


def run(archive, files, repetitions=9):
    raw = gzip.decompress(Path(archive).read_bytes())
    payload = json.loads(raw)
    surface = payload['surfaceIndex']
    expected = json.dumps(surface, sort_keys=True)
    modes = {'previous-late-compaction': lambda raw, **_: store._decode_cache_payload(raw),
             'current-model-decode-compaction': store._decode_surface_cache_payload}
    samples = {mode: [] for mode in modes}
    allocations = {}
    with tempfile.TemporaryDirectory(prefix='djls-surface-decode-') as temporary:
        root = Path(temporary).resolve() / 'workspace'
        root.mkdir()
        with mock.patch.object(store, '_workspace_cache_dir', return_value=root.parent / 'cache'):
            store.save_surface_index(root, 'source', 'runtime', surface)
            cache = root.parent / 'cache' / store.SURFACE_INDEX_CACHE_NAME
            encoded_size = cache.stat().st_size
            for revision in range(repetitions):
                order = list(modes) if revision % 2 == 0 else list(reversed(modes))
                for mode in order:
                    gc.collect()
                    with mock.patch.object(store, '_decode_surface_cache_payload', modes[mode]):
                        cpu, wall = time.process_time_ns(), time.perf_counter_ns()
                        result = store.load_cached_surface_index(root, 'source', 'runtime')
                        sample = {'wallMs': (time.perf_counter_ns() - wall) / 1e6,
                                  'cpuMs': (time.process_time_ns() - cpu) / 1e6}
                    assert json.dumps(result, sort_keys=True) == expected
                    assert len(result) == len(surface)
                    assert all(isinstance(model['instance']['field_0'], tuple) for model in result.values())
                    sample['completeSurfaceWireEqual'] = True
                    samples[mode].append(sample)
                    del result
            for mode in modes:
                gc.collect()
                tracemalloc.start(1)
                with mock.patch.object(store, '_decode_surface_cache_payload', modes[mode]):
                    result = store.load_cached_surface_index(root, 'source', 'runtime')
                retained, peak = tracemalloc.get_traced_memory()
                tracemalloc.stop()
                assert json.dumps(result, sort_keys=True) == expected
                allocations[mode] = {'retainedBytes': retained, 'peakBytes': peak}
                del result
        return {'pythonFiles': files, 'models': len(surface), 'repetitions': repetitions,
            'inputArchive': archive, 'inputUncompressedSha256': hashlib.sha256(raw).hexdigest(),
            'surfaceCacheBytes': encoded_size, 'samples': samples,
            'summary': {mode: {'wallMedianMs': statistics.median(row['wallMs'] for row in values),
                              'cpuMedianMs': statistics.median(row['cpuMs'] for row in values),
                              **allocations[mode]} for mode, values in samples.items()}}


if __name__ == '__main__':
    print(json.dumps({'date': '2026-10-09', 'rows': [
        run('bench/lsp-memory-1000-payload.json.gz', 1000),
        run('bench/compact-records-direct-state-ready-5000-cached-payload.json.gz', 5000),
        run('bench/lsp-memory-10000-payload.json.gz', 10000)],
        'scope': 'Alternating9 actual complete saved surface-cache reads/tier on same archivedrealDjango metadata. Prior onlydecodecompactiondisabled, existingvalidation/late4tuplepool retained. FullsurfaceJSON wire and allmodel/field tuples equal everycall. Separatetraceddecode/read/validation/compaction allocation includesrawtext/arrays/tuples, excludesbaselinefixture/static/runtime/IPC/Node/wholeprocess/aggregatepeak. Currentformat/schema/checks unchanged; hostuncontrolled no globalstartup/stablepercentage.'}, indent=2))
