"""Benchmark worker: profile the first actual compute-reindex call only."""
import cProfile
import json
import pstats
import sys

from django_orm_intellisense.server.app import DaemonServer
from django_orm_intellisense.__main__ import main

original = DaemonServer._compute_reindex
profiled = False


def compute(self, **kwargs):
    global profiled
    if profiled:
        return original(self, **kwargs)
    profiled = True
    profiler = cProfile.Profile()
    try:
        return profiler.runcall(original, self, **kwargs)
    finally:
        stats = pstats.Stats(profiler)
        rows = []
        for (filename, line, name), (primitive, calls, total, cumulative, _) in stats.stats.items():
            rows.append({'file': filename, 'line': line, 'name': name, 'calls': calls,
                'primitiveCalls': primitive, 'totalMs': total * 1000, 'cumulativeMs': cumulative * 1000})
        rows.sort(key=lambda row: row['cumulativeMs'], reverse=True)
        selected = [row for row in rows if row['name'] in {
            'source_dependents', 'constructor_dependents', '_import_dependents',
            '_workspace_files', '_canonical_workspace_source_path', 'resolve', 'realpath',
            'collect_model_lookup_catalog', 'collect_lookup_catalog', 'field_from_source',
        }]
        print('[reindex:cprofile] ' + json.dumps({'file': str(kwargs['file_path']),
            'totalCalls': stats.total_calls, 'totalCpuSeconds': stats.total_tt,
            'topCumulative': rows[:25], 'selectedFunctions': selected}), file=sys.stderr, flush=True)


DaemonServer._compute_reindex = compute
if __name__ == '__main__':
    main()
