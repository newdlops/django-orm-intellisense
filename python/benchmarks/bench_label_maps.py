"""Isolate label joins; synthetic headers, no Django setup, files, RPC or SQL."""
from __future__ import annotations

import argparse
import cProfile
import dataclasses
import json
import pstats
import time

from django_orm_intellisense.runtime.inspector import RuntimeModelSummary, create_pending_runtime_inspection
from django_orm_intellisense.semantic.graph import (
    ModelGraph, ModelGraphNode, _build_runtime_graph_maps, _join_static_graph_labels, _runtime_graph_maps,
)
from django_orm_intellisense.static_index.indexer import ModelCandidate, StaticIndex


def profile_calls(callback, repetitions):
    profiler = cProfile.Profile()
    started = time.perf_counter()
    profiler.enable()
    for _ in range(repetitions):
        callback()
    profiler.disable()
    return {
        'profiledMs': (time.perf_counter() - started) * 1000,
        'calls': [{'function': key[2], 'count': value[1], 'cumulativeMs': value[3] * 1000}
                  for key, value in pstats.Stats(profiler).stats.items()
                  if key[2] in {'_build_runtime_graph_maps', '_runtime_graph_maps',
                                '_join_static_graph_labels', 'static_to_graph_labels'}],
    }


def run(count, repetitions):
    candidates, summaries, nodes = [], [], {}
    for number in range(count):
        name = f'Model{number}'
        candidate = ModelCandidate(app_label='source', object_name=name, label=f'source.{name}',
            module=f'source.model_{number}', file_path=f'/synthetic/model_{number}.py', line=1,
            column=1, is_abstract=False, base_class_refs=(), source='static')
        summary = RuntimeModelSummary(label=f'runtime.{name}', module=candidate.module,
            field_names=[], relation_names=[], reverse_relation_names=[], fields=[], relations=[],
            manager_names=['objects'])
        candidates.append(candidate)
        summaries.append(summary)
        nodes[summary.label] = ModelGraphNode(label=summary.label, app_label='runtime', object_name=name,
            module=candidate.module, import_path=f'{candidate.module}.{name}', file_path=candidate.file_path,
            line=1, column=1, field_names=(), relation_names=(), reverse_relation_names=(),
            manager_names=('objects',), model_candidate=candidate, runtime_model=summary)
    index = StaticIndex(python_file_count=0, package_init_count=0, reexport_module_count=0,
        star_import_count=0, explicit_all_count=0, modules={}, model_candidates=candidates)
    runtime = dataclasses.replace(create_pending_runtime_inspection(None), bootstrap_status='ready',
        model_catalog=tuple(summaries), model_count=count)
    graph = ModelGraph(fields_by_model_label={}, nodes_by_label=nodes,
        nodes_by_object_name={node.object_name: (node,) for node in nodes.values()},
        node_by_import_path={node.import_path: node for node in nodes.values()}, edges_by_source_label={})
    expected_runtime = _build_runtime_graph_maps(index, runtime)
    expected_graph = _join_static_graph_labels(index, graph)
    uncached = profile_calls(lambda: (_build_runtime_graph_maps(index, runtime),
                                      _join_static_graph_labels(index, graph)), repetitions)
    first = time.perf_counter()
    actual_runtime = _runtime_graph_maps(index, runtime)
    actual_graph = graph.static_to_graph_labels(index)
    warm_ms = (time.perf_counter() - first) * 1000
    assert actual_runtime == expected_runtime and actual_graph == expected_graph
    cached = profile_calls(lambda: (_runtime_graph_maps(index, runtime),
                                    graph.static_to_graph_labels(index)), repetitions)
    assert _runtime_graph_maps(index, runtime) is actual_runtime
    assert graph.static_to_graph_labels(index) is actual_graph
    assert len(actual_graph) == count
    return {'models': count, 'repetitions': repetitions, 'warmupMs': warm_ms,
            'uncached': uncached, 'cached': cached, 'matchingResults': True,
            'scope': 'Synthetic immutable model headers; profile both label joins only. Excludes project discovery, Django inspection, fields, RPC, serialization, UI and SQL. Not full-RPC budget evidence.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', type=int, default=1000)
    parser.add_argument('--repetitions', type=int, default=1000)
    args = parser.parse_args()
    if args.models < 1 or args.repetitions < 1:
        parser.error('Model count and repetitions must be positive')
    print(json.dumps(run(args.models, args.repetitions), indent=2))
