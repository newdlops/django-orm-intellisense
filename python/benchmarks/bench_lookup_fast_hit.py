"""Pair previous/full catalogue checks with guarded early default-field hits."""
import argparse
import json
import statistics
import time
import types
from pathlib import Path

from tests.lookup_catalog_fixture import build_fixture
from django_orm_intellisense.runtime import lookup_catalog


def previous_module():
    source = Path(lookup_catalog.__file__).read_text()
    source = source.replace('fast_seen: dict[tuple[object, ...], tuple[str, dict, dict, dict, dict]] = {}',
                            'fast_seen: dict[tuple[object, ...], str] = {}')
    start = source.index('        fast_key = None\n', source.index('    def describe('))
    end = source.index('        lookup_method = expression.get_lookup', start)
    source = source[:start] + '''        registered = {**output_registry, **own_registry}
        has_custom_transform = any(
            isinstance(cls, type) and issubclass(cls, Transform)
            and not cls.__module__.startswith('django.') for cls in registered.values()
        )
        fast_key = None
        if (isinstance(expression, Field) and type(expression).__module__.startswith('django.')
                and not getattr(expression, 'instance_lookups', None)
                and not hasattr(effective_output, 'base_field') and not has_custom_transform):
            fast_key = (type(expression), id(own_registry), id(output_registry), kind_override)
            if fast_key in fast_seen:
                return fast_seen[fast_key]
''' + source[end:]
    old = '''            # Per-collection snapshots retain registry identity and detect
            # in-place updates, including same-size lookup/transform swaps.
            fast_seen[fast_key] = (type_id, own_registry, output_registry,
                                   dict(own_registry), dict(output_registry))'''
    assert old in source
    source = source.replace(old, '            fast_seen[fast_key] = type_id')
    module = types.ModuleType('django_orm_intellisense.runtime._previous_lookup_fast_hit')
    module.__package__ = lookup_catalog.__package__
    exec(compile(source, str(lookup_catalog.__file__) + ':previous', 'exec'), module.__dict__)
    return module


def run(repetitions):
    from django.db import models
    _, oracle, _, _, _ = build_fixture()
    old = previous_module()
    cases = {'complete-installed-oracle': oracle}
    for count in [100, 1000, 10000]:
        cases[f'ordinary-{count}-fields'] = {('sample.Item', f'field_{number}'): models.IntegerField()
            for number in range(count)}
    rows = []
    for name, registry in cases.items():
        modes = {'previous-after-scan-hit': old.collect_lookup_catalog,
                 'current-guarded-early-hit': lookup_catalog.collect_lookup_catalog}
        expected = old.collect_lookup_catalog(registry, include_class_defaults=False)
        samples = {mode: [] for mode in modes}
        for round in range(repetitions):
            for mode in list(modes) if round % 2 == 0 else list(reversed(modes)):
                cpu, started = time.process_time_ns(), time.perf_counter_ns()
                actual = modes[mode](registry, include_class_defaults=False)
                sample = {'wallMs': (time.perf_counter_ns() - started) / 1e6,
                          'cpuMs': (time.process_time_ns() - cpu) / 1e6}
                assert actual == expected
                sample['completeCatalogEqual'] = True
                samples[mode].append(sample)
        rows.append({'case': name, 'fields': len(registry), 'repetitions': repetitions,
            'samples': samples, 'summary': {mode: {
                'wallMedianMs': statistics.median(row['wallMs'] for row in values),
                'cpuMedianMs': statistics.median(row['cpuMs'] for row in values)}
                for mode, values in samples.items()}})
    return {'date': '2026-10-09', 'rows': rows,
        'scope': 'Alternating9 complete catalogue calls per real installed fixture and100/1000/10000 ordinary IntegerField entries. Exact entire types/fields/transforms/relations/expression metadata equal each time. Previous source implementation reconstructed without mock dispatch overhead; excludes bootstrap/daemon/RPC/editor/wholeheap/truepeak. Ordinary-field cases are intentionally narrow and not fullready fixture; mutation semantics are regression tested separately. Host uncontrolled, no global speedup claim.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--repetitions', type=int, default=9)
    args = parser.parse_args()
    print(json.dumps(run(args.repetitions), indent=2))
