"""Pair the prior duplicate import scan and current shared adjacency."""
import argparse
import json
import statistics
import tempfile
import time
from pathlib import Path
from unittest import mock

from benchmarks.bench_reindex import generate_synthetic_project
from django_orm_intellisense.static_index.indexer import ModuleIndex, build_static_index


def previous_constructor(index, changed_module):
    cache = index._constructor_dependency_cache
    if cache is None:
        by_source = {}
        for name, module in index.modules.items():
            for reference in module.constructor_imports:
                origin = reference.rpartition('.')[0]
                if origin in index.modules:
                    by_source.setdefault(origin, set()).add(name)
        for name, module in index.modules.items():
            for binding in module.import_bindings:
                by_source.setdefault(binding.module, set()).add(name)
                if binding.symbol:
                    by_source.setdefault(f'{binding.module}.{binding.symbol}', set()).add(name)
        cache = {name: frozenset(values) for name, values in by_source.items()}
        index._constructor_dependency_cache = cache
    affected, pending = {changed_module}, [changed_module]
    while pending:
        for name in cache.get(pending.pop(), ()):
            if name not in affected:
                affected.add(name); pending.append(name)
    return {name for name in affected if name != changed_module and index.modules[name].constructor_imports}


def run(file_count, repetitions):
    with tempfile.TemporaryDirectory(prefix='djls-dependency-adjacency-cost-') as temporary:
        root = Path(temporary).resolve()
        generate_synthetic_project(root, file_count // 10)
        count = len(list(root.rglob('*.py')))
        helpers = root / 'helpers'
        helpers.mkdir()
        for number in range(file_count - count):
            (helpers / f'helper_{number}.py').write_text(f'value = {number}\n')
        index = build_static_index(root)
        assert index.python_file_count == file_count and len(index.modules) == file_count
        original_wire = index.to_cache_dict()
        previous = lambda: previous_constructor(index, 'app0.model_0')
        current = lambda: index.constructor_dependents('app0.model_0')
        modes = {'previous-duplicate-scan': previous, 'current-shared-adjacency': current}
        rows = {mode: [] for mode in modes}
        expected = None
        def measured(query):
            nonlocal expected
            index._constructor_dependency_cache = None
            index._import_dependency_cache.dependents = None
            cpu, started = time.process_time_ns(), time.perf_counter_ns()
            constructor = query()
            source = index.source_dependents({'app0.model_0'})
            wall_ms = (time.perf_counter_ns() - started) / 1e6
            cpu_ms = (time.process_time_ns() - cpu) / 1e6
            result = (constructor, source, dict(index._constructor_dependency_cache),
                      dict(index._import_dependency_cache.dependents))
            if expected is None: expected = result
            else: assert result == expected
            assert index.to_cache_dict() == original_wire
            return {'wallMs': wall_ms, 'cpuMs': cpu_ms, 'completeGraphsAndWireEqual': True}
        for round in range(repetitions):
            for mode in list(modes) if round % 2 == 0 else list(reversed(modes)):
                rows[mode].append(measured(modes[mode]))
        reads = {}
        original = ModuleIndex.__getattribute__
        for mode, query in modes.items():
            counter = [0]
            def read(module, name):
                if name == 'import_bindings': counter[0] += 1
                return original(module, name)
            # Only query graph construction, not wire verification, is counted.
            index._constructor_dependency_cache = None
            index._import_dependency_cache.dependents = None
            with mock.patch.object(ModuleIndex, '__getattribute__', read):
                query(); index.source_dependents({'app0.model_0'})
            reads[mode] = counter[0]
        assert reads['previous-duplicate-scan'] == file_count * 2
        assert reads['current-shared-adjacency'] == file_count
        return {'pythonFiles': file_count, 'models': file_count // 10, 'repetitions': repetitions,
            'rows': rows, 'importBindingReads': reads,
            'summary': {mode: {'wallMedianMs': statistics.median(value['wallMs'] for value in samples),
                              'cpuMedianMs': statistics.median(value['cpuMs'] for value in samples)}
                        for mode, samples in rows.items()}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--files', type=int, nargs='+', default=[1000, 5000, 10000])
    parser.add_argument('--repetitions', type=int, default=9)
    args = parser.parse_args()
    print(json.dumps({'date': '2026-10-09', 'rows': [run(count, args.repetitions) for count in args.files],
        'scope': 'Alternating9 cold constructor+source dependency graph queries per complete actual1K/5K/10K source fixture,10percent models. Full adjacency/result/wire comparisons and separate import read count. Existing-source graph semantics compared; unresolved-origin lifecycle handled by regressions separately. Isolated CPU/wall excludes parser/startup/runtime/RPC/Node/memory; no global timing claim.'}, indent=2))
