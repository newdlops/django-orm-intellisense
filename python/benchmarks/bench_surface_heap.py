"""Measure reachable member-cache/surface storage, separately from RPC latency."""
from __future__ import annotations

import argparse
import dataclasses
import gc
import json
import os
import sys
import tempfile
import time
from collections import Counter
from pathlib import Path

from benchmarks.bench_reindex import generate_synthetic_project
from django_orm_intellisense.cache.store import load_cached_surface_index, save_surface_index
from django_orm_intellisense.features import orm_members
from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.static_index.indexer import build_static_index


def reachable_storage(roots):
    """Count owned containers/records once; do not traverse global class state."""
    pending = list(roots)
    seen = set()
    counts = Counter()
    tracked = Counter()
    sizes = Counter()
    while pending:
        value = pending.pop()
        identity = id(value)
        if identity in seen:
            continue
        seen.add(identity)
        name = type(value).__name__
        counts[name] += 1
        sizes[name] += sys.getsizeof(value)
        tracked[name] += gc.is_tracked(value)
        if isinstance(value, dict):
            pending.extend(value.keys())
            pending.extend(value.values())
        elif isinstance(value, (list, tuple, set, frozenset)):
            pending.extend(value)
        elif isinstance(value, orm_members._CachedMemberSurface):
            pending.extend(value.storage_roots())
        elif dataclasses.is_dataclass(value) and not isinstance(value, type):
            pending.extend(getattr(value, field.name) for field in dataclasses.fields(value))
            if hasattr(value, '__dict__'):
                pending.append(vars(value))
    return {'objects': sum(counts.values()), 'trackedObjects': sum(tracked.values()),
            'bytes': sum(sizes.values()),
            'types': [{'type': name, 'objects': counts[name], 'tracked': tracked[name], 'bytes': sizes[name]}
                      for name, _ in counts.most_common()]}


def run(models, cached=False):
    with tempfile.TemporaryDirectory(prefix='djls-surface-heap-') as folder:
        root = Path(folder)
        generate_synthetic_project(root, models)
        index = build_static_index(root)
        runtime = create_pending_runtime_inspection(None)
        graph = build_model_graph(index, runtime)
        cache = orm_members._MemberSurfaceCache()
        previous = orm_members._surface_cache
        orm_members._surface_cache = cache
        try:
            surface = orm_members.build_surface_index(index, runtime, graph)
            cache_roots = (cache._list_cache, cache._dict_cache, cache._keys_by_model,
                           cache._model_versions, cache._inflight)
            before = reachable_storage((*cache_roots, surface))
            started = time.perf_counter()
            collected = gc.collect(2)
            collect_ms = (time.perf_counter() - started) * 1000
            after = reachable_storage((*cache_roots, surface))
            result = {'models': models, 'receiverCacheEntries': len(cache._list_cache),
                    'memberItems': sum(len(items) for items in cache._list_cache.values()),
                    'beforeExplicitCollection': before, 'afterExplicitCollection': after,
                    'cacheAfterCollection': reachable_storage(cache_roots),
                    'surfaceAfterCollection': reachable_storage((surface,)),
                    'explicitFullCollectionMs': collect_ms, 'collected': collected,
                    'scope': 'Owned cache/surface records and containers plus their scalar values, counted once by identity. Real static/graph metadata and pending runtime; excludes other workspace/runtime/module/AST objects, allocator overhead, process RSS, and complete RPC. Explicit full collection is diagnostic only; production enablement and thresholds are unchanged.'}
            if cached:
                cache_key = 'DJANGO_ORM_INTELLISENSE_CACHE_DIR'
                old_cache = os.environ.get(cache_key)
                os.environ[cache_key] = str(root / 'cache')
                try:
                    save_surface_index(root, 'source', 'runtime', surface)
                    started = time.perf_counter()
                    loaded = load_cached_surface_index(root, 'source', 'runtime',
                        static_index=index, model_graph=graph)
                    load_ms = (time.perf_counter() - started) * 1000
                finally:
                    if old_cache is None:
                        os.environ.pop(cache_key, None)
                    else:
                        os.environ[cache_key] = old_cache
                assert loaded is not None
                assert json.dumps(loaded, sort_keys=True) == json.dumps(surface, sort_keys=True)
                assert orm_members.fingerprint_surface_index(loaded) == orm_members.fingerprint_surface_index(surface)
                gc.collect(2)
                result['cachedSurface'] = {'loadAndValidationMs': load_ms,
                    'wireAndFingerprintsEquivalent': True, 'storage': reachable_storage((loaded,))}
            return result
        finally:
            orm_members._surface_cache = previous


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', type=int, default=1000)
    parser.add_argument('--cached', action='store_true')
    args = parser.parse_args()
    if args.models < 1:
        parser.error('Model count must be positive')
    print(json.dumps(run(args.models, args.cached), indent=2))
