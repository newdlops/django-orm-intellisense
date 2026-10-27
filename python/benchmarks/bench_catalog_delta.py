"""Catalogue replacement cost after every model has a private type chunk."""
from __future__ import annotations

import argparse
import json
import statistics
import time
from datetime import datetime, timezone

from tests.lookup_catalog_fixture import build_fixture
from django_orm_intellisense.runtime.lookup_catalog import apply_model_catalog_delta, lookup_catalog_json_default


def run(model_count: int, repetitions: int):
    _, _, runtime, _, _ = build_fixture()
    fixture = runtime.lookup_catalog
    source = 'lookup_test.Item'
    pending = list(fixture['fields'][source].values())
    pending.extend(fixture.get('expressionFields', {}).get(source, {}).values())
    reachable = set()
    while pending:
        type_id = pending.pop()
        if type_id is None or type_id in reachable:
            continue
        reachable.add(type_id)
        descriptor = fixture['types'][type_id]
        pending.extend(descriptor['transforms'].values())
        dynamic = descriptor.get('dynamicTransform') or {}
        pending.extend((dynamic.get('outputType'), dynamic.get('sliceType')))
    types = {key: fixture['types'][key] for key in reachable}
    catalog = {**fixture, 'fields': {}, 'expressionFields': {}, 'relationPaths': {}}
    for number in range(model_count):
        label = f'bench.Item{number}'
        catalog['fields'][label] = fixture['fields'][source]
        catalog['expressionFields'][label] = fixture['expressionFields'].get(source, {})
    initial = catalog
    samples = []
    for number in range(model_count):
        label = f'bench.Item{number}'
        chunk = {'types': types, 'fields': {label: fixture['fields'][source]},
                 'expressionFields': {label: fixture['expressionFields'].get(source, {})}}
        started = time.perf_counter()
        catalog = apply_model_catalog_delta(catalog, {label: chunk})
        samples.append((time.perf_counter() - started) * 1000)
    count = len(catalog['types'])
    repeated = []
    label = 'bench.Item0'
    chunk = {'types': types, 'fields': {label: fixture['fields'][source]},
             'expressionFields': {label: fixture['expressionFields'].get(source, {})}}
    for _ in range(repetitions):
        started = time.perf_counter()
        catalog = apply_model_catalog_delta(catalog, {label: chunk})
        repeated.append((time.perf_counter() - started) * 1000)
    assert len(catalog['types']) == count
    assert initial['fields'][label] == fixture['fields'][source]
    assert not any(key.startswith('model:') for key in initial['types'])
    # This is an explicit full export, measured separately from edit updates.
    started = time.perf_counter()
    exported = json.dumps(catalog, sort_keys=True, default=lookup_catalog_json_default)
    export_ms = (time.perf_counter() - started) * 1000
    restored = json.loads(exported)
    assert len(restored['types']) == count
    return {'timestamp': datetime.now(timezone.utc).isoformat(),
            'models': model_count, 'fieldsPerModel': len(fixture['fields'][source]),
            'descriptorsPerChunk': len(types), 'catalogTypes': count,
            'allModelEdits': summarize(samples), 'repeatedEdits': summarize(repeated),
            'fullExportMs': export_ms, 'fullExportBytes': len(exported.encode()),
            'retentionStable': True, 'initialSnapshotUnchanged': True,
            'scope': 'Python catalogue replacement only; excludes Django source reconstruction, daemon RPC and editor rendering'}


def summarize(values):
    ordered = sorted(values)
    return {'count': len(values), 'p50Ms': statistics.median(values),
            'p95Ms': ordered[min(len(values) - 1, int(len(values) * .95))], 'maxMs': max(values)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', type=int, default=1000)
    parser.add_argument('--repetitions', type=int, default=100)
    args = parser.parse_args()
    if args.models < 1 or args.repetitions < 1:
        parser.error('Model count and repetitions must be positive')
    print(json.dumps(run(args.models, args.repetitions), indent=2))
