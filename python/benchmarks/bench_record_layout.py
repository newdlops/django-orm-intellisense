"""Fresh-process full static snapshot/cache/graph cost for record layouts."""
import argparse
import gc
import hashlib
import json
import statistics
import subprocess
import sys
import tempfile
import time
import tracemalloc
from pathlib import Path
from unittest import mock


def worker(root, layout, allocations):
    if layout == 'previous-dict':
        from benchmarks.record_layout_control import install_previous_layout
        install_previous_layout()
    from django_orm_intellisense.cache import store
    from django_orm_intellisense.discovery.workspace import snapshot_python_sources
    from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection
    from django_orm_intellisense.semantic.graph import build_model_graph
    from django_orm_intellisense.static_index.indexer import build_static_index
    gc.collect()
    if allocations:
        tracemalloc.start(1)
    cpu, wall = time.process_time_ns(), time.perf_counter_ns()
    snapshot = snapshot_python_sources(root)
    index = build_static_index(root, snapshot.files)
    graph = build_model_graph(index, create_pending_runtime_inspection(None))
    build_cost = {'wallMs': (time.perf_counter_ns() - wall) / 1e6,
                  'cpuMs': (time.process_time_ns() - cpu) / 1e6}
    if allocations:
        build_cost['retainedBytes'], build_cost['peakBytes'] = tracemalloc.get_traced_memory()
        tracemalloc.stop()
    encoded = json.dumps({'snapshot': snapshot.to_cache_dict(), 'index': index.to_cache_dict(),
        'fields': [store._field_candidate_to_cache_dict(field) for field in index.fields],
        'graph': store._model_graph_to_cache_dict(graph)}, sort_keys=True).encode()
    expected_hash = hashlib.sha256(encoded).hexdigest()
    with mock.patch.object(store, '_workspace_cache_dir', return_value=root.parent / 'cache'):
        store.save_static_index(root, snapshot, index)
        store.save_model_graph(root, snapshot.fingerprint, 'runtime', graph)
        del encoded, index, graph
        gc.collect()
        if allocations:
            tracemalloc.start(1)
        cpu, wall = time.process_time_ns(), time.perf_counter_ns()
        index, hit = store.load_cached_static_index(root, snapshot)
        graph = store.load_cached_model_graph(root, snapshot.fingerprint, 'runtime')
        restore_cost = {'wallMs': (time.perf_counter_ns() - wall) / 1e6,
                        'cpuMs': (time.process_time_ns() - cpu) / 1e6}
        if allocations:
            restore_cost['retainedBytes'], restore_cost['peakBytes'] = tracemalloc.get_traced_memory()
            tracemalloc.stop()
        assert hit == 'full' and graph is not None
        restored = json.dumps({'snapshot': snapshot.to_cache_dict(), 'index': index.to_cache_dict(),
            'fields': [store._field_candidate_to_cache_dict(field) for field in index.fields],
            'graph': store._model_graph_to_cache_dict(graph)}, sort_keys=True).encode()
        assert hashlib.sha256(restored).hexdigest() == expected_hash
    return {'layout': layout, 'build': build_cost, 'restore': restore_cost,
        'completeSnapshotStaticFieldsGraphSha256': expected_hash, 'completeRestoreEqual': True,
        'recordDictionaryPresent': hasattr(index.fields[0], '__dict__')}


def run(count, models, repetitions=9):
    from benchmarks.bench_reindex import generate_synthetic_project
    with tempfile.TemporaryDirectory(prefix='djls-record-layout-') as temporary:
        root = Path(temporary).resolve() / 'workspace'
        root.mkdir()
        generate_synthetic_project(root, models)
        helpers = root / 'helpers'
        helpers.mkdir()
        for number in range(count - len(list(root.rglob('*.py')))):
            (helpers / f'helper_{number}.py').write_text(f'value={number}\n')
        modes = ['previous-dict', 'current-slots']
        samples = {mode: [] for mode in modes}
        hashes = set()
        for repetition in range(repetitions):
            for mode in modes if repetition % 2 == 0 else list(reversed(modes)):
                command = [sys.executable, '-m', 'benchmarks.bench_record_layout', '--worker',
                           str(root), '--layout', mode]
                result = json.loads(subprocess.check_output(command, text=True, stderr=subprocess.DEVNULL))
                hashes.add(result['completeSnapshotStaticFieldsGraphSha256'])
                assert result['recordDictionaryPresent'] == (mode == 'previous-dict')
                samples[mode].append(result)
        allocations = {}
        for mode in modes:
            command = [sys.executable, '-m', 'benchmarks.bench_record_layout', '--worker',
                       str(root), '--layout', mode, '--allocations']
            allocations[mode] = json.loads(subprocess.check_output(command, text=True, stderr=subprocess.DEVNULL))
            hashes.add(allocations[mode]['completeSnapshotStaticFieldsGraphSha256'])
        assert len(hashes) == 1
        return {'pythonFiles': count, 'models': models, 'repetitions': repetitions, 'samples': samples,
            'allocationSamples': allocations, 'summary': {mode: {phase: {
                'wallMedianMs': statistics.median(sample[phase]['wallMs'] for sample in values),
                'cpuMedianMs': statistics.median(sample[phase]['cpuMs'] for sample in values),
                'retainedBytes': allocations[mode][phase]['retainedBytes'],
                'peakBytes': allocations[mode][phase]['peakBytes']} for phase in ['build', 'restore']}
                for mode, values in samples.items()}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--worker', type=Path)
    parser.add_argument('--layout', choices=['previous-dict', 'current-slots'])
    parser.add_argument('--allocations', action='store_true')
    args = parser.parse_args()
    if args.worker:
        print(json.dumps(worker(args.worker, args.layout, args.allocations)))
    else:
        print(json.dumps({'date': '2026-10-09', 'rows': [run(1000, 100), run(5000, 500), run(10000, 1000)],
            'scope': 'Alternating9 fresh worker processes per layout/tier. Priorlayout import transform removesonlyslots decorators on10 frozen recordclasses. Current source/snapshot/parse/runtime-skipped/cache/schema/stat checks preserved. Complete snapshot/static/fields/graph hash equal across layouts and every cache restore. Wall/processCPU includes snapshot/build/graph and separately fullstatic/modelgraph restore; excludes interpreterimport startup/cachewrite/configuredruntime/RPC/Node/aggregateheap. Separatetracedallocationstartsafterimports; build andrestore retained/peak abovepriorfixture. Hostuncontrolled no stablepercentage/globalreadyclaim.'}, indent=2))
