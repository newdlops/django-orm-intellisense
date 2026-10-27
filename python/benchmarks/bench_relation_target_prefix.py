"""Whole relation-target list cost on complete configured graph metadata."""
import argparse
import gc
import json
import statistics
import subprocess
import sys
import tempfile
import time
import tracemalloc
from pathlib import Path
from unittest import mock

from benchmarks.bench_reindex import generate_synthetic_project
from django_orm_intellisense.features import relation_targets
from django_orm_intellisense.runtime.inspector import inspect_runtime
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.static_index.indexer import build_static_index


def previous(model_graph, prefix):
    normalized = (prefix or '').strip().lower()
    values = [relation_targets._target_dict(model_graph, node) for node in model_graph.nodes_by_label.values()]
    if normalized:
        values = [value for value in values if relation_targets._matches_prefix(value, normalized)]
    values.sort(key=lambda value: (0 if value['source'] == 'runtime' else 1, str(value['label']).lower()))
    return values


def worker(count, repetitions):
    with tempfile.TemporaryDirectory(prefix='djls-relation-prefix-') as temporary:
        root = Path(temporary).resolve()
        files = generate_synthetic_project(root, count // 10)
        apps = sorted({file.parent.name for file in files})
        (root / 'prefix_settings.py').write_text(f'INSTALLED_APPS={apps!r}\nSECRET_KEY="prefix"\n'
            'DATABASES={"default":{"ENGINE":"django.db.backends.sqlite3","NAME":":memory:"}}\n')
        for app in apps:
            (root / app / 'models.py').write_text('\n'.join(
                f'from .{file.stem} import Model{int(file.stem.split("_")[-1])}' for file in files if file.parent.name == app)+'\n')
        helper = root / 'helpers'
        helper.mkdir()
        for number in range(count-len(list(root.rglob('*.py')))):
            (helper / f'helper_{number}.py').write_text(f'value={number}\n')
        initial = build_static_index(root)
        sys.path.insert(0, str(root))
        runtime = inspect_runtime('prefix_settings')
        assert runtime.bootstrap_status == 'ready' and runtime.model_count == count // 10
        graph = build_model_graph(initial, runtime)
        modes = {'previous-all-targets': previous,
            'current-prefix-first': lambda owner, prefix: relation_targets.list_relation_targets(model_graph=owner, prefix=prefix)}
        rows = []
        for prefix in ['Model0', 'not_found', 'app0.', '']:
            expected = previous(graph, prefix)
            samples = {mode: [] for mode in modes}
            allocations = {}
            counts = {}
            for revision in range(repetitions):
                for mode in list(modes) if revision % 2 == 0 else list(reversed(modes)):
                    gc.collect()
                    cpu, started = time.process_time_ns(), time.perf_counter_ns()
                    result = modes[mode](graph, prefix)
                    row = {'wallMs': (time.perf_counter_ns()-started)/1e6, 'cpuMs': (time.process_time_ns()-cpu)/1e6}
                    assert result == expected
                    row['completeTargetMetadataEqual'] = True
                    samples[mode].append(row)
                    del result
            for mode, call in modes.items():
                gc.collect()
                tracemalloc.start()
                result = call(graph, prefix)
                retained, peak = tracemalloc.get_traced_memory()
                tracemalloc.stop()
                assert result == expected
                allocations[mode] = {'retainedBytes': retained, 'peakBytes': peak}
                with mock.patch.object(relation_targets, '_target_dict', wraps=relation_targets._target_dict) as target:
                    assert call(graph, prefix) == expected
                    counts[mode] = target.call_count
            assert counts['current-prefix-first'] == len(expected)
            rows.append({'prefix': prefix, 'matches': len(expected), 'targetMetadataConstructions': counts,
                'samples': samples, 'summary': {mode: {'wallMedianMs': statistics.median(row['wallMs'] for row in values),
                    'cpuMedianMs': statistics.median(row['cpuMs'] for row in values), **allocations[mode]}
                    for mode, values in samples.items()}})
        return {'pythonFiles': count, 'models': count // 10, 'repetitions': repetitions, 'prefixes': rows}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--files', type=int, nargs='+', default=[1000, 5000, 10000])
    parser.add_argument('--repetitions', type=int, default=9)
    parser.add_argument('--worker', action='store_true')
    args = parser.parse_args()
    if args.worker:
        print(json.dumps(worker(args.files[0], args.repetitions)))
    else:
        rows = [json.loads(subprocess.check_output([sys.executable, '-m', 'benchmarks.bench_relation_target_prefix',
            '--worker', '--files', str(count), '--repetitions', str(args.repetitions)], text=True)) for count in args.files]
        print(json.dumps({'productionApplied': True, 'rows': rows,
            'scope': 'Nine alternating complete target list calls per model/empty/miss/app prefix and exact1K/5K/10K source fixture with configured ready-runtime graph. Every output value/order/preview equal to original, metadata construction counts separate. Traced function-only allocations above graph. No actual RPC/VS Code/startup/aggregate/stable budget claim.'}, indent=2))
