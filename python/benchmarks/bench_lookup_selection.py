"""Compare registry-entry classification with legacy per-name Django dispatch."""
from __future__ import annotations
import argparse
import cProfile
import json
import pstats
import time
from contextlib import nullcontext
from unittest import mock

from tests.lookup_catalog_fixture import build_fixture
from django_orm_intellisense.runtime.lookup_catalog import collect_lookup_catalog


def sample(registry, repetitions, legacy):
    patcher = (mock.patch('django_orm_intellisense.runtime.lookup_catalog._uses_default_registry_method',
                         return_value=False) if legacy else nullcontext())
    with patcher:
        expected = collect_lookup_catalog(registry, include_class_defaults=False)
        profiler = cProfile.Profile()
        started = time.perf_counter()
        profiler.enable()
        for _ in range(repetitions):
            actual = collect_lookup_catalog(registry, include_class_defaults=False)
        profiler.disable()
        elapsed = (time.perf_counter() - started) * 1000
        assert actual == expected
    names = {'get_lookup', '_get_lookup', 'get_instance_lookups', 'get_transform',
             'collect_lookup_catalog', '_uses_default_registry_method'}
    rows = [{'file': key[0], 'function': key[2], 'calls': value[1],
             'cumulativeMs': value[3] * 1000}
            for key, value in pstats.Stats(profiler).stats.items() if key[2] in names]
    return {'profiledMs': elapsed, 'calls': rows, 'typeCount': len(expected['types'])}, expected


def run(repetitions):
    _, registry, _, _, _ = build_fixture()
    baseline, old_catalog = sample(registry, repetitions, True)
    selected, new_catalog = sample(registry, repetitions, False)
    assert old_catalog == new_catalog
    return {'repetitions': repetitions, 'registryFields': len(registry),
            'legacy': baseline, 'selected': selected, 'equivalent': True,
            'scope': 'Installed Django oracle fields, expressions, custom/instance registrations and optional field families. Collection only, excluding bootstrap, complete daemon/RPC, UI and SQL.',
            'note': 'Legacy disables only entry classification; helper mock dispatch adds baseline overhead. Shared-host timings do not establish a stable speedup percentage.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--repetitions', type=int, default=100)
    args = parser.parse_args()
    if args.repetitions < 1:
        parser.error('Repetitions must be positive')
    print(json.dumps(run(args.repetitions), indent=2))
