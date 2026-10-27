"""Reachable catalogue storage after independently collecting every model."""
from __future__ import annotations

import argparse
import gc
import json
import time

from benchmarks.bench_surface_heap import reachable_storage
from django_orm_intellisense.runtime.lookup_catalog import (
    LookupTypeTable, apply_model_catalog_delta, collect_lookup_catalog, compact_lookup_catalog, lookup_catalog_json_default)
from tests.lookup_catalog_fixture import build_fixture


def roots(catalog):
    types = catalog['types']
    return (catalog, vars(types)) if isinstance(types, LookupTypeTable) else (catalog,)


def run(models, repetitions, cached=False):
    _, registry, runtime, _, _ = build_fixture()
    source = 'lookup_test.Item'
    fields = {name: field for (label, name), field in registry.items() if label == source}
    catalog = {**runtime.lookup_catalog, 'fields': {}, 'expressionFields': {}, 'relationPaths': {}}
    for number in range(models):
        label = f'bench.Item{number}'
        # Collect independently, as actual edit RPCs do. Reusing one fixture
        # chunk here would already share its lists and hide duplication.
        chunk = collect_lookup_catalog({(label, name): field for name, field in fields.items()},
                                       include_class_defaults=False)
        catalog = apply_model_catalog_delta(catalog, {label: chunk})
    initial_count = len(catalog['types'])
    before = reachable_storage(roots(catalog))
    started = time.perf_counter()
    collected = gc.collect(2)
    gc_ms = (time.perf_counter() - started) * 1000
    after = reachable_storage(roots(catalog))
    label = 'bench.Item0'
    for _ in range(repetitions):
        chunk = collect_lookup_catalog({(label, name): field for name, field in fields.items()},
                                       include_class_defaults=False)
        catalog = apply_model_catalog_delta(catalog, {label: chunk})
    assert len(catalog['types']) == initial_count
    started = time.perf_counter()
    serialized = json.dumps(catalog, sort_keys=True, default=lookup_catalog_json_default)
    export_ms = (time.perf_counter() - started) * 1000
    restored = json.loads(serialized)
    assert len(restored['types']) == initial_count
    result = {'models': models, 'fieldsPerModel': len(fields), 'catalogTypes': initial_count,
        'repeatedEdits': repetitions, 'retentionStable': True,
        'beforeExplicitCollection': before, 'afterExplicitCollection': after,
        'explicitFullCollectionMs': gc_ms, 'collected': collected,
        'fullExportMs': export_ms, 'fullExportBytes': len(serialized.encode()),
        'scope': 'Catalogue containers and values after separate real-Django collection for each synthetic label, using actual lookup fixture fields including instance registrations, parameterized transforms, JSON and relation projection. Counts identity once, including chunk table storage. Excludes Django field/class/registry ownership, other workspace/runtime/module allocations, allocator overhead, RSS, source reconstruction, RPC, editor and SQL. Explicit GC is diagnostic only; production policy is unchanged.'}
    if cached:
        started = time.perf_counter()
        restored = compact_lookup_catalog(restored)
        restore_ms = (time.perf_counter() - started) * 1000
        assert json.dumps(restored, sort_keys=True, default=lookup_catalog_json_default) == serialized
        gc.collect(2)
        result['restoredCatalogue'] = {'compactionMs': restore_ms, 'wireEquivalent': True,
                                      'storage': reachable_storage(roots(restored))}
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', type=int, default=1000)
    parser.add_argument('--repetitions', type=int, default=100)
    parser.add_argument('--cached', action='store_true')
    args = parser.parse_args()
    if args.models < 1 or args.repetitions < 1:
        parser.error('Model count and repetitions must be positive')
    print(json.dumps(run(args.models, args.repetitions, args.cached), indent=2))
