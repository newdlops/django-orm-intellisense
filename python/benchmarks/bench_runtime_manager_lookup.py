"""Uninstrumented cost of all runtime manager-name queries in one build."""
import dataclasses
import gc
import json
import statistics
import tempfile
import time
import tracemalloc
from pathlib import Path

from benchmarks.runtime_manager_map_candidate import candidate_module
from django_orm_intellisense.features import orm_members
from django_orm_intellisense.runtime.inspector import RuntimeModelSummary, create_pending_runtime_inspection
from django_orm_intellisense.static_index.indexer import build_static_index


def run(count, static, owners):
    catalog = tuple(RuntimeModelSummary(f'bench.Model{i}', 'bench.models', [], [], [], [], [],
        ['objects', 'archived', 'objects']) for i in range(count))
    runtime = dataclasses.replace(create_pending_runtime_inspection(None), model_catalog=catalog)
    expected = {model.label: ['archived', 'objects'] for model in catalog}
    queries = {}
    for mode, owner in owners.items():
        def query(owner=owner):
            return {model.label: owner._manager_names(static, runtime, model.label) for model in catalog}
        queries[mode] = owner._with_runtime_source_paths(query)
    samples = {mode: [] for mode in owners}
    allocation = {}
    for revision in range(9):
        for mode in list(owners) if revision % 2 == 0 else list(reversed(owners)):
            gc.collect()
            cpu, wall = time.process_time_ns(), time.perf_counter_ns()
            result = queries[mode]()
            row = {'wallMs': (time.perf_counter_ns() - wall) / 1e6,
                   'cpuMs': (time.process_time_ns() - cpu) / 1e6}
            assert result == expected
            samples[mode].append(row)
            del result
    for mode in owners:
        gc.collect()
        tracemalloc.start()
        result = queries[mode]()
        retained, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        assert result == expected
        allocation[mode] = {'retainedBytes': retained, 'peakBytes': peak}
        del result
    return {'models': count, 'samples': samples, 'summary': {
        mode: {**{key: statistics.median(row[key] for row in values) for key in ('wallMs', 'cpuMs')},
               **allocation[mode]} for mode, values in samples.items()}}


def main():
    with tempfile.TemporaryDirectory(prefix='djls-runtime-manager-query-') as temporary:
        static = build_static_index(Path(temporary))
        applied = hasattr(orm_members, '_runtime_model_catalogs')
        owners = {'previous-linear-search': candidate_module(previous=True) if applied else orm_members,
                  'current-build-scoped-map' if applied else 'candidate-build-scoped-map': candidate_module()}
        print(json.dumps({'productionApplied': applied,
            'rows': [run(count, static, owners) for count in (100, 500, 1000, 5000)],
            'scope': 'Uninstrumented actual manager-name queries for every model, inside the actual '
                'build-scope decorator including scope setup/cleanup and fresh lazy map construction. '
                'Complete names, duplicate removal and sorted ordering equal. No full surface/AST '
                'generation, actual configured Django/editor/startup or aggregate RSS claim.'}, indent=2))


if __name__ == '__main__':
    main()
