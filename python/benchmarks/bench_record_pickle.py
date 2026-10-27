"""Isolate actual state snapshot pickle cost across compact record layouts."""
import argparse
import gc
import hashlib
import json
import pickle
import statistics
import subprocess
import sys
import tempfile
import time
import tracemalloc
from pathlib import Path


def worker(root, layout):
    if layout == 'previous-dict':
        from benchmarks.record_layout_control import install_previous_layout
        install_previous_layout()
    from django_orm_intellisense.cache import store
    from django_orm_intellisense.discovery.workspace import snapshot_python_sources
    from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection
    from django_orm_intellisense.semantic.graph import build_model_graph
    from django_orm_intellisense.static_index.indexer import build_static_index
    if layout == 'default-slots':
        from benchmarks.compact_pickle_candidate import install_default_slot_state_pickle
        install_default_slot_state_pickle()
    if layout == 'candidate-constructor':
        from benchmarks.compact_pickle_candidate import install_constructor_pickle
        install_constructor_pickle()
    if layout == 'candidate-tuple-state':
        from benchmarks.compact_pickle_candidate import install_tuple_state_pickle
        install_tuple_state_pickle()
    if layout == 'candidate-direct-state':
        from benchmarks.compact_pickle_candidate import install_direct_state_pickle
        install_direct_state_pickle()
    source = snapshot_python_sources(root)
    index = build_static_index(root, source.files)
    runtime = create_pending_runtime_inspection(None)
    graph = build_model_graph(index, runtime)
    state = (source, index, runtime, graph)
    original_wire = (source.to_cache_dict(), index.to_cache_dict(), index.fields,
                     store._model_graph_to_cache_dict(graph))
    samples = []
    for _ in range(9):
        gc.collect()
        cpu, wall = time.process_time_ns(), time.perf_counter_ns()
        encoded = pickle.dumps(state, protocol=pickle.HIGHEST_PROTOCOL)
        restored = pickle.loads(encoded)
        sample = {'wallMs': (time.perf_counter_ns() - wall) / 1e6,
                  'cpuMs': (time.process_time_ns() - cpu) / 1e6, 'pickleBytes': len(encoded)}
        assert (restored[0].to_cache_dict(), restored[1].to_cache_dict(), restored[1].fields,
                store._model_graph_to_cache_dict(restored[3])) == original_wire
        sample['completeWireEqual'] = True
        samples.append(sample)
        del restored, encoded
    gc.collect()
    tracemalloc.start(1)
    encoded = pickle.dumps(state, protocol=pickle.HIGHEST_PROTOCOL)
    encode_retained, encode_peak = tracemalloc.get_traced_memory()
    tracemalloc.reset_peak()
    restored = pickle.loads(encoded)
    retained, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    assert (restored[0].to_cache_dict(), restored[1].to_cache_dict(), restored[1].fields,
            store._model_graph_to_cache_dict(restored[3])) == original_wire
    return {'layout': layout, 'samples': samples, 'summary': {
        'wallMedianMs': statistics.median(row['wallMs'] for row in samples),
        'cpuMedianMs': statistics.median(row['cpuMs'] for row in samples),
        'pickleBytes': len(encoded), 'encodeRetainedBytes': encode_retained, 'encodePeakBytes': encode_peak,
        'restoredPlusEncodedRetainedBytes': retained, 'decodePeakAboveBaselineBytes': peak}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--worker', type=Path)
    parser.add_argument('--layout', choices=['previous-dict', 'default-slots', 'current-slots', 'candidate-constructor', 'candidate-tuple-state', 'candidate-direct-state'])
    args = parser.parse_args()
    if args.worker:
        print(json.dumps(worker(args.worker, args.layout)))
    else:
        from benchmarks.bench_reindex import generate_synthetic_project
        with tempfile.TemporaryDirectory(prefix='djls-record-pickle-') as temporary:
            root = Path(temporary).resolve() / 'workspace'
            root.mkdir()
            generate_synthetic_project(root, 500)
            helpers = root / 'helpers'
            helpers.mkdir()
            for number in range(5000 - len(list(root.rglob('*.py')))):
                (helpers / f'helper_{number}.py').write_text(f'value={number}\n')
            rows = [json.loads(subprocess.check_output([sys.executable, '-m',
                'benchmarks.bench_record_pickle', '--worker', str(root), '--layout', mode],
                text=True, stderr=subprocess.DEVNULL)) for mode in ['previous-dict', 'default-slots', 'current-slots']]
        print(json.dumps({'pythonFiles': 5000, 'models': 500, 'rows': rows,
            'scope': 'One freshprocess perlayout,9 actualsource/index/runtime/graph pickle roundtrips. Completewire fields verifiedeverycall. Separatetracedencode/decode aboveexistingfixture,encoded+restoredretained notwholeprocess/trueIPC/aggregatepeak. Sequentiallayouts hostuncontrolled; diagnosticnotcausalwholepeak/latencyproof.'}, indent=2))
