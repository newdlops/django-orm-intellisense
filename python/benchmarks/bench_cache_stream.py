"""Compare complete surface cache reads with full-text and bounded input."""
import argparse
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

from benchmarks.cache_stream_candidate import candidate_module, previous_module
from django_orm_intellisense.cache import store


def run(archive, files, repetitions, variants=False, final=False):
    encoded = gzip.decompress(Path(archive).read_bytes())
    surface = json.loads(encoded)['surfaceIndex']
    expected = json.dumps(surface, sort_keys=True)
    modes = {'previous-full-text': store, 'candidate-stream': candidate_module()}
    if final:
        modes = {'previous-full-text': previous_module(), 'current-stream': store}
    if variants:
        modes.update({'candidate-depth2-64k': candidate_module(object_depth=2),
                      'candidate-depth2-256k': candidate_module(object_depth=2, chunk_size=262144),
                      'candidate-depth2-512k': candidate_module(object_depth=2, chunk_size=524288)})
    samples = {mode: [] for mode in modes}
    allocations = {}
    with tempfile.TemporaryDirectory(prefix='djls-cache-stream-') as temporary:
        root = Path(temporary).resolve() / 'project'
        root.mkdir()
        cache = root.parent / 'cache'
        with mock.patch.object(store, '_workspace_cache_dir', return_value=cache):
            store.save_surface_index(root, 'source', 'runtime', surface)
        for repetition in range(repetitions):
            order = list(modes) if repetition % 2 == 0 else list(reversed(modes))
            for mode in order:
                gc.collect()
                with mock.patch.object(modes[mode], '_workspace_cache_dir', return_value=cache):
                    cpu, started = time.process_time_ns(), time.perf_counter_ns()
                    result = modes[mode].load_cached_surface_index(root, 'source', 'runtime')
                    sample = {'wallMs': (time.perf_counter_ns() - started) / 1e6,
                              'cpuMs': (time.process_time_ns() - cpu) / 1e6}
                assert json.dumps(result, sort_keys=True) == expected
                assert len(result) == len(surface)
                assert all(isinstance(model['instance']['field_0'], tuple) for model in result.values())
                sample['completeSurfaceWireEqual'] = True
                samples[mode].append(sample)
                del result
        for mode in modes:
            gc.collect()
            tracemalloc.start()
            with mock.patch.object(modes[mode], '_workspace_cache_dir', return_value=cache):
                result = modes[mode].load_cached_surface_index(root, 'source', 'runtime')
            retained, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
            assert json.dumps(result, sort_keys=True) == expected
            allocations[mode] = {'additionalRetainedBytes': retained, 'additionalPeakBytes': peak}
            del result
        return {'pythonFiles': files, 'models': len(surface), 'repetitions': repetitions,
            'inputArchive': archive, 'inputUncompressedSha256': hashlib.sha256(encoded).hexdigest(),
            'surfaceCacheBytes': (cache / store.SURFACE_INDEX_CACHE_NAME).stat().st_size,
            'samples': samples, 'summary': {mode: {
                'wallMedianMs': statistics.median(row['wallMs'] for row in rows),
                'cpuMedianMs': statistics.median(row['cpuMs'] for row in rows), **allocations[mode]}
                for mode, rows in samples.items()}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--files', type=int, nargs='+', default=[1000, 5000, 10000])
    parser.add_argument('--repetitions', type=int, default=9)
    parser.add_argument('--variants', action='store_true')
    parser.add_argument('--final', action='store_true')
    args = parser.parse_args()
    archives = {1000: 'bench/lsp-memory-1000-payload.json.gz',
                5000: 'bench/graph-cache-reuse-ready-5000-cached-payload.json.gz',
                10000: 'bench/lsp-memory-10000-payload.json.gz'}
    print(json.dumps({'productionApplied': args.final,
        'rows': [run(archives[count], count, args.repetitions, args.variants, args.final) for count in args.files],
        'scope': 'Alternating complete real archived surface cache loads. Same schema/metadata checks and per-model compaction. All surface values compared each call, separate traced allocation probes above existing inputs. Streaming delegates records to the standard decoder and maintains per-read immutable key sharing. Host uncontrolled; no whole daemon/Node/editor/native/aggregate peak or stable startup proof.'}, indent=2))
