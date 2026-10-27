"""Benchmark worker: cProfile the first configured initialization only."""
import cProfile
import json
import pstats
import sys

from django_orm_intellisense.server.app import DaemonServer
from django_orm_intellisense.__main__ import main

original = DaemonServer._initialize
profiled = False


def initialize(self, params):
    global profiled
    if profiled:
        return original(self, params)
    profiled = True
    profiler = cProfile.Profile()
    try:
        return profiler.runcall(original, self, params)
    finally:
        stats = pstats.Stats(profiler)
        rows = []
        for (filename, line, name), (primitive, calls, total, cumulative, _) in stats.stats.items():
            rows.append({'file': filename, 'line': line, 'name': name, 'calls': calls,
                'primitiveCalls': primitive, 'totalMs': total * 1000, 'cumulativeMs': cumulative * 1000})
        rows.sort(key=lambda row: row['cumulativeMs'], reverse=True)
        selected = [row for row in rows if row['name'] in {
            'snapshot_python_sources', 'build_static_index', 'inspect_runtime',
            'collect_lookup_catalog', '_collect_custom_lookups', 'save_static_index',
            'load_cached_static_index', '_decode_cache_payload', 'build_model_graph',
        }]
        print('[initialize:cprofile] ' + json.dumps({'settingsModule': params.get('settingsModule'),
            'deferRuntime': params.get('deferRuntime'), 'totalCalls': stats.total_calls,
            'totalProfileSeconds': stats.total_tt, 'topCumulative': rows[:30],
            'selectedFunctions': selected}), file=sys.stderr, flush=True)


DaemonServer._initialize = initialize
if __name__ == '__main__':
    main()
