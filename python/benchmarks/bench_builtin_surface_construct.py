"""Whole fresh receiver cache/surface comparison and complete member parity."""
import argparse
import gc
import json
import os
import statistics
import tempfile
import time
import tracemalloc
from pathlib import Path
from unittest import mock

from benchmarks.bench_reindex import generate_synthetic_project
from benchmarks.builtin_surface_construct_candidate import candidate_module
from django_orm_intellisense.features import orm_members
from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.static_index.indexer import build_static_index


def run(models, repetitions):
    with tempfile.TemporaryDirectory(prefix='djls-builtin-surface-construct-') as temporary:
        root = Path(temporary).resolve()
        generate_synthetic_project(root, models)
        static = build_static_index(root)
        runtime = create_pending_runtime_inspection(None)
        graph = build_model_graph(static, runtime)
        owners = {'current-bound-builtin-records': orm_members,
                  'candidate-direct-builtin-templates': candidate_module()}
        if os.environ.get('DJLS_BENCH_CURRENT_BUILTIN_SURFACE_CONSTRUCT') == '1':
            owners = {'previous-bound-builtin-records': candidate_module(previous=True),
                      'current-direct-builtin-templates': orm_members}
        samples = {mode: [] for mode in owners}
        allocation = {}
        expected = None
        expected_members = None

        def build(owner):
            owner._parse_class_nodes_cached.cache_clear()
            owner._builtin_member_template.cache_clear()
            cache = owner._MemberSurfaceCache()
            with mock.patch.object(owner, '_surface_cache', cache):
                surface = owner.prebuild_member_surface_cache(static, runtime, graph)
            return surface, cache

        def validate(surface, cache):
            nonlocal expected, expected_members
            members = {key: [item.to_dict() for item in items]
                       for key, items in cache._list_cache.items()}
            if expected is None:
                expected, expected_members = surface, members
            else:
                assert surface == expected
                assert members == expected_members

        for revision in range(repetitions):
            for mode in list(owners) if revision % 2 == 0 else list(reversed(owners)):
                gc.collect()
                cpu, started = time.process_time_ns(), time.perf_counter_ns()
                surface, cache = build(owners[mode])
                row = {'wallMs': (time.perf_counter_ns() - started) / 1e6,
                       'cpuMs': (time.process_time_ns() - cpu) / 1e6}
                validate(surface, cache)
                row['entireSurfaceAndAllReceiverMemberRecordsEqual'] = True
                samples[mode].append(row)
                del surface, cache
        for mode, owner in owners.items():
            gc.collect()
            tracemalloc.start()
            surface, cache = build(owner)
            retained, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
            validate(surface, cache)
            allocation[mode] = {'retainedBytes': retained, 'peakBytes': peak}
            del surface, cache
        return {'models': models, 'samples': samples,
            'receiverCount': len(expected_members),
            'memberRecordsPerValidation': sum(map(len, expected_members.values())),
            'summary': {mode: {**{key: statistics.median(row[key] for row in values)
                for key in ['wallMs', 'cpuMs']}, **allocation[mode]} for mode, values in samples.items()}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', type=int, nargs='+', default=[100, 500, 1000])
    parser.add_argument('--repetitions', type=int, default=9)
    args = parser.parse_args()
    print(json.dumps({'date': '2026-10-10', 'productionApplied':
        os.environ.get('DJLS_BENCH_CURRENT_BUILTIN_SURFACE_CONSTRUCT') == '1',
        'rows': [run(count, args.repetitions) for count in args.models],
        'scope': 'Fresh whole prebuilt receiver cache/surface, including cold method AST parsing and '
                 'template pool; exact full surface and every receiver/member wire record. Pending '
                 'runtime fixture, not actual configured Django/IPC/editor or aggregate RSS. '
                 'Tracemalloc above preexisting static/graph/runtime owners.'}, indent=2))
