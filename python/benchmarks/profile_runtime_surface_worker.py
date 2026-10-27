"""Diagnostic actual runtime and spawned surface CPU/call profiles."""
import cProfile
import functools
import json
import os
import pstats
import sys
import time

from django_orm_intellisense.server import app
from django_orm_intellisense.__main__ import main


def instrument(name):
    original = getattr(app, name)

    @functools.wraps(original)
    def measured(*args, **kwargs):
        profiler = cProfile.Profile()
        wall, cpu = time.perf_counter_ns(), time.process_time_ns()
        try:
            return profiler.runcall(original, *args, **kwargs)
        finally:
            stats = pstats.Stats(profiler)
            rows = [{'file': filename, 'line': line, 'name': function, 'calls': calls,
                     'primitiveCalls': primitive, 'selfMs': total * 1000,
                     'cumulativeMs': cumulative * 1000}
                    for (filename, line, function), (primitive, calls, total, cumulative, _)
                    in stats.stats.items()]
            print('[runtime-surface:cprofile] ' + json.dumps({
                'phase': name, 'pid': os.getpid(), 'wallMs': (time.perf_counter_ns() - wall) / 1e6,
                'processCpuMs': (time.process_time_ns() - cpu) / 1e6,
                'totalCalls': stats.total_calls, 'totalSelfMs': stats.total_tt * 1000,
                'topCumulative': sorted(rows, key=lambda row: row['cumulativeMs'], reverse=True)[:80],
                'topSelf': sorted(rows, key=lambda row: row['selfMs'], reverse=True)[:40],
                'scope': 'cProfile instrumented runtime/surface call on its executing process/thread. '
                         'Includes instrumentation and schedule delay; nested cumulative rows must '
                         'not be summed. Not ordinary latency, stable SLO or aggregate memory.'}),
                file=sys.stderr, flush=True)

    setattr(app, name, measured)


for phase in ['inspect_runtime', 'prebuild_member_surface_cache']:
    instrument(phase)

if __name__ == '__main__':
    main()
