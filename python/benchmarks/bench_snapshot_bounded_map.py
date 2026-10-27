"""Complete unchanged source scans with the same membership and stat code."""
import argparse
import gc
import json
import statistics
import tempfile
import time
import tracemalloc
from pathlib import Path
from unittest import mock

from benchmarks.snapshot_bounded_map_candidate import candidate_module
from django_orm_intellisense.discovery import workspace


def run(count, repetitions, delay):
    with tempfile.TemporaryDirectory(prefix='djls-bounded-stat-map-') as temporary:
        root = Path(temporary).resolve()
        for number in range(count):
            folder = root / f'app{number//500}'
            folder.mkdir(exist_ok=True)
            (folder / f'helper_{number}.py').write_text(f'value={number}\n')
        previous = workspace.snapshot_python_sources(root)
        expected = previous.to_cache_dict()
        candidate = candidate_module()
        modes = {'current-eager-map': workspace.snapshot_python_sources,
            'candidate-bounded-map': candidate.snapshot_python_sources}
        original = workspace.os.stat

        def stat(path, *args, **kwargs):
            if delay and str(path).endswith('.py'):
                time.sleep(delay)
            return original(path, *args, **kwargs)

        samples = {mode: [] for mode in modes}
        allocations = {}
        with mock.patch.object(workspace.os, 'stat', stat):
            for revision in range(repetitions):
                for mode in list(modes) if revision%2==0 else list(reversed(modes)):
                    gc.collect()
                    cpu, started = time.process_time_ns(), time.perf_counter_ns()
                    result = modes[mode](root, previous_snapshot=previous)
                    row = {'wallMs': (time.perf_counter_ns()-started)/1e6,
                        'cpuMs': (time.process_time_ns()-cpu)/1e6}
                    assert result is previous and result.to_cache_dict() == expected and result.files == previous.files
                    row['completeCurrentStatAndOwnerEqual'] = True
                    samples[mode].append(row)
            if not delay:
                for mode, call in modes.items():
                    gc.collect()
                    tracemalloc.start()
                    result = call(root, previous_snapshot=previous)
                    retained, peak = tracemalloc.get_traced_memory()
                    tracemalloc.stop()
                    assert result is previous
                    allocations[mode] = {'retainedBytes': retained, 'peakBytes': peak}
        return {'pythonFiles': count, 'delaySecondsPerSourceStat': delay, 'samples': samples,
            'summary': {mode: {**{key: statistics.median(row[key] for row in values) for key in ['wallMs', 'cpuMs']},
                **allocations.get(mode, {})} for mode, values in samples.items()}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--files', type=int, nargs='+', default=[1000, 5000, 10000])
    parser.add_argument('--repetitions', type=int, default=9)
    parser.add_argument('--delay', type=float, default=0)
    args = parser.parse_args()
    print(json.dumps({'date': '2026-10-10', 'productionApplied': False,
        'rows': [run(count, args.repetitions, args.delay) for count in args.files],
        'scope': 'Alternating9fullunchangedrevalidations/tier, originalinventory/freshPath.stat/64filebatch/fingerprint/order/reuse code, onlyeagermapversusmax16pendingbatchfutureschanged. Fullsnapshot/currentowneridentity equalityeachcall. Separatetracedfunctionallocation. Optionalsynthetic0.2msstatdelay, no realnetworkFS/actualstartup/changedsource/platform/trueaggregatepeak proof.'}, indent=2))
