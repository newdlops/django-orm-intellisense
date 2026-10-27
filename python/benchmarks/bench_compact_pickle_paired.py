"""Rotate pickle state strategies on one complete actual analysis snapshot."""
import gc
import json
import pickle
import statistics
import tempfile
import time
import tracemalloc
from pathlib import Path

from benchmarks.bench_reindex import generate_synthetic_project
from benchmarks.compact_pickle_candidate import (
    RECORDS, install_constructor_pickle, install_tuple_state_pickle, install_direct_state_pickle)
from django_orm_intellisense.cache import store
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.static_index.indexer import build_static_index


original = {record: {name: record.__dict__.get(name) for name in ['__reduce_ex__', '__getstate__', '__setstate__']}
            for record in RECORDS}


def restore():
    for record, methods in original.items():
        for name, method in methods.items():
            if method is None:
                if name in record.__dict__:
                    delattr(record, name)
            else:
                setattr(record, name, method)


def run(count, models, repetitions=15):
    with tempfile.TemporaryDirectory(prefix='djls-compact-pickle-paired-') as temporary:
        root = Path(temporary).resolve()
        generate_synthetic_project(root, models)
        helpers = root / 'helpers'
        helpers.mkdir()
        for number in range(count - len(list(root.rglob('*.py')))):
            (helpers / f'helper_{number}.py').write_text(f'value={number}\n')
        source = snapshot_python_sources(root)
        index = build_static_index(root, source.files)
        runtime = create_pending_runtime_inspection(None)
        graph = build_model_graph(index, runtime)
        state = (source, index, runtime, graph)
        expected = (source.to_cache_dict(), index.to_cache_dict(), index.fields,
                    store._model_graph_to_cache_dict(graph))
        modes = {'default-slots': lambda: None, 'constructor': install_constructor_pickle,
                 'tuple-state': install_tuple_state_pickle, 'direct-state': install_direct_state_pickle}
        samples = {mode: [] for mode in modes}
        allocations = {}
        try:
            for repetition in range(repetitions):
                names = list(modes)
                order = names[repetition % len(names):] + names[:repetition % len(names)]
                for mode in order:
                    restore()
                    modes[mode]()
                    gc.collect()
                    cpu, wall = time.process_time_ns(), time.perf_counter_ns()
                    encoded = pickle.dumps(state, protocol=pickle.HIGHEST_PROTOCOL)
                    decoded = pickle.loads(encoded)
                    sample = {'wallMs': (time.perf_counter_ns() - wall) / 1e6,
                              'cpuMs': (time.process_time_ns() - cpu) / 1e6,
                              'pickleBytes': len(encoded)}
                    assert (decoded[0].to_cache_dict(), decoded[1].to_cache_dict(), decoded[1].fields,
                            store._model_graph_to_cache_dict(decoded[3])) == expected
                    sample['completeStateEqual'] = True
                    samples[mode].append(sample)
                    del encoded, decoded
            for mode in modes:
                restore()
                modes[mode]()
                gc.collect()
                tracemalloc.start(1)
                encoded = pickle.dumps(state, protocol=pickle.HIGHEST_PROTOCOL)
                encode_retained, encode_peak = tracemalloc.get_traced_memory()
                tracemalloc.reset_peak()
                decoded = pickle.loads(encoded)
                retained, decode_peak = tracemalloc.get_traced_memory()
                tracemalloc.stop()
                assert (decoded[0].to_cache_dict(), decoded[1].to_cache_dict(), decoded[1].fields,
                        store._model_graph_to_cache_dict(decoded[3])) == expected
                allocations[mode] = {'encodeRetainedBytes': encode_retained, 'encodePeakBytes': encode_peak,
                    'decodedPlusEncodedRetainedBytes': retained, 'decodePeakAboveBaselineBytes': decode_peak}
                del encoded, decoded
        finally:
            restore()
        return {'pythonFiles': count, 'models': models, 'repetitions': repetitions, 'samples': samples,
            'summary': {mode: {'wallMedianMs': statistics.median(row['wallMs'] for row in values),
                              'cpuMedianMs': statistics.median(row['cpuMs'] for row in values),
                              'pickleBytes': values[0]['pickleBytes'], **allocations[mode]}
                        for mode, values in samples.items()}}


if __name__ == '__main__':
    print(json.dumps({'date': '2026-10-09', 'productionApplied': False,
        'rows': [run(1000, 100), run(5000, 500), run(10000, 1000)],
        'scope': 'Rotating15 per tier same actualsnapshot/index/runtime-skipped/graph acrossdefaultslots/constructor/tuple/directstate strategies. Every completevalue/cache/fields equal. Bench-only temporaryclassmethod patch, restoredfinally. Separatetracedencode/decode samples aboveexistingsnapshot, excludesactualIPC/wholeprocess/Node/globalstartup. Hostuncontrolled; pairednotstablepercentproof.'}, indent=2))
