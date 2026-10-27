"""Whole fresh surface build with a populated, immutable runtime catalogue."""
import argparse
import dataclasses
import gc
import json
import statistics
import tempfile
import time
import tracemalloc
from pathlib import Path
from unittest import mock

from benchmarks.bench_reindex import generate_synthetic_project
from benchmarks.runtime_manager_map_candidate import candidate_module
from django_orm_intellisense.features import orm_members
from django_orm_intellisense.runtime.inspector import RuntimeModelSummary, create_pending_runtime_inspection
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.static_index.indexer import build_static_index


class CountingCatalog(tuple):
    visits = 0

    def __iter__(self):
        for item in super().__iter__():
            self.visits += 1
            yield item


def run(count, repetitions=7, count_visits=False):
    with tempfile.TemporaryDirectory(prefix='djls-runtime-manager-map-') as temporary:
        root = Path(temporary).resolve()
        generate_synthetic_project(root, count)
        static = build_static_index(root)
        catalog_type = CountingCatalog if count_visits else tuple
        catalog = catalog_type(RuntimeModelSummary(
            label=c.label, module=c.module, field_names=[], relation_names=[],
            reverse_relation_names=[], fields=[], relations=[], manager_names=['objects'])
            for c in static.model_candidates)
        runtime = dataclasses.replace(create_pending_runtime_inspection(None),
            model_catalog=catalog, model_preview=list(catalog[:10]), model_count=count)
        graph = build_model_graph(static, runtime)
        applied = hasattr(orm_members, '_runtime_model_catalogs')
        owners = {'previous-linear-search': candidate_module(previous=True) if applied else orm_members,
                  'current-build-scoped-map' if applied else 'candidate-build-scoped-map': candidate_module()}
        samples = {mode: [] for mode in owners}
        allocation = {}
        expected = None
        expected_members = None

        def build(owner):
            owner._parse_class_nodes_cached.cache_clear()
            owner._builtin_member_template.cache_clear()
            cache = owner._MemberSurfaceCache()
            if count_visits:
                catalog.visits = 0
            with mock.patch.object(owner, '_surface_cache', cache):
                surface = owner.prebuild_member_surface_cache(static, runtime, graph)
            return surface, cache, catalog.visits if count_visits else None

        def validate(surface, cache):
            nonlocal expected, expected_members
            members = {key: [item.to_dict() for item in items]
                       for key, items in cache._list_cache.items()}
            if expected is None:
                expected, expected_members = surface, members
            else:
                assert surface == expected
                assert members == expected_members
            assert len(surface) == count and len(members) == count * 5
            for candidate in static.model_candidates:
                entry = surface[candidate.label]
                assert len([name for name in entry['instance'] if name.startswith('field_')]) == 15
                assert entry['model_class']['objects'][0] == 'manager'

        for revision in range(repetitions):
            modes = list(owners) if revision % 2 == 0 else list(reversed(owners))
            for mode in modes:
                gc.collect()
                cpu, wall = time.process_time_ns(), time.perf_counter_ns()
                surface, cache, visits = build(owners[mode])
                row = {'wallMs': (time.perf_counter_ns() - wall) / 1e6,
                       'cpuMs': (time.process_time_ns() - cpu) / 1e6}
                if count_visits:
                    row['runtimeCatalogEntriesVisited'] = visits
                validate(surface, cache)
                row['completeSurfaceAndEveryMemberWireEqual'] = True
                samples[mode].append(row)
                del surface, cache
        for mode, owner in owners.items():
            gc.collect()
            tracemalloc.start()
            surface, cache, visits = build(owner)
            retained, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
            validate(surface, cache)
            allocation[mode] = {'retainedBytes': retained, 'peakBytes': peak}
            del surface, cache
        numeric_keys = ['wallMs', 'cpuMs']
        if count_visits:
            numeric_keys.append('runtimeCatalogEntriesVisited')
        return {'models': count, 'samples': samples, 'catalogVisitCounterEnabled': count_visits,
            'memberRecordsPerValidation': sum(map(len, expected_members.values())),
            'summary': {mode: {**{key: statistics.median(row[key] for row in values)
                for key in numeric_keys},
                **allocation[mode]} for mode, values in samples.items()}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--count-visits', action='store_true')
    args = parser.parse_args()
    print(json.dumps({'productionApplied': hasattr(orm_members, '_runtime_model_catalogs'),
        'catalogVisitCounterEnabled': args.count_visits,
        'rows': [run(count, count_visits=args.count_visits) for count in (100, 500, 1000)],
        'scope': 'Whole fresh actual prebuild and every receiver/member wire compared. '
            'Static/source AST and shared builtin pools cold. Populated immutable runtime '
            'summaries with pending bootstrap, no live Django/custom runtime method inspection. '
            'Optional counting tuple adds per-visited-entry diagnostic overhead in both modes; '
            'when enabled elapsed gains require uninstrumented confirmation. '
            'Parent tracemalloc above existing owners, no aggregate RSS/editor/startup claim.'}, indent=2))


if __name__ == '__main__':
    main()
