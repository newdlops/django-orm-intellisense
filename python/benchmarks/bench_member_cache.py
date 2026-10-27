"""Compare member-cache invalidation with the former full key scan."""
from __future__ import annotations

import argparse
import json
import statistics
import tempfile
import time
from pathlib import Path

from benchmarks.bench_reindex import generate_synthetic_project
from django_orm_intellisense.features.orm_members import _MemberSurfaceCache, _with_runtime_source_paths
from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.static_index.indexer import build_static_index

KINDS = ('instance', 'model_class', 'manager', 'queryset', 'related_manager')


def legacy_invalidate(cache, label):
    with cache._lock:
        keys = [key for key in cache._list_cache if key[0] == label]
        for key in keys:
            cache._list_cache.pop(key, None)
            cache._dict_cache.pop(key, None)
        # Keep the new bookkeeping equivalent during repeated baseline calls.
        cache._keys_by_model.pop(label, None)
        cache._model_versions.pop(label, None)


def sample(cache, index, runtime, graph, label, repetitions, legacy):
    @_with_runtime_source_paths
    def refill():
        return [cache.get_list(index, runtime, graph, label, kind, None) for kind in KINDS]
    expected = refill()
    counts = (len(cache._list_cache), len(cache._keys_by_model[label]))
    samples = []
    for _ in range(repetitions):
        started = time.perf_counter()
        if legacy:
            legacy_invalidate(cache, label)
        else:
            cache.invalidate_model(label)
        samples.append((time.perf_counter() - started) * 1000)
        assert refill() == expected
        assert (len(cache._list_cache), len(cache._keys_by_model[label])) == counts
        assert not cache._inflight
    ordered = sorted(samples)
    return {'count': repetitions, 'p50Ms': statistics.median(samples),
            'p95Ms': ordered[min(len(ordered) - 1, int(len(ordered) * .95))],
            'maxMs': max(samples), 'cacheEntries': counts[0],
            'targetReceiverEntries': counts[1], 'equivalent': True}


def run(model_count, repetitions):
    with tempfile.TemporaryDirectory(prefix='djls-member-cache-') as folder:
        root = Path(folder)
        generate_synthetic_project(root, model_count)
        index = build_static_index(root)
        runtime = create_pending_runtime_inspection(None)
        graph = build_model_graph(index, runtime)
        cache = _MemberSurfaceCache()
        @_with_runtime_source_paths
        def populate():
            for candidate in index.model_candidates:
                for kind in KINDS:
                    cache.get_list(index, runtime, graph, candidate.label, kind, None)
        populate()
        label = index.model_candidates[0].label
        other = index.model_candidates[-1].label
        unchanged = cache.get_list(index, runtime, graph, other, 'instance', None)
        before = sample(cache, index, runtime, graph, label, repetitions, True)
        after = sample(cache, index, runtime, graph, label, repetitions, False)
        assert cache.get_list(index, runtime, graph, other, 'instance', None) is unchanged
        assert len(cache._model_versions) == model_count
        return {'models': model_count, 'repetitions': repetitions,
                'legacyScan': before, 'modelKeyIndex': after,
                'unchangedSurfaceReused': True, 'retentionStable': True,
                'scope': 'Member-cache invalidation only with five populated receiver entries per model, pending runtime and real static/graph metadata. Refill and setup are excluded from timings but verified after every invalidation. Excludes full surface construction, runtime callable inspection, complete reindex RPC, serialization, editor rendering and SQL.',
                'note': 'Legacy uses the former full-key comprehension and synchronizes the new bookkeeping. Shared-host wall time is not a stable complete-RPC speedup claim.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', type=int, default=1000)
    parser.add_argument('--repetitions', type=int, default=1000)
    args = parser.parse_args()
    if args.models < 2 or args.repetitions < 1:
        parser.error('At least two models and positive repetitions are required')
    print(json.dumps(run(args.models, args.repetitions), indent=2))
