"""Pair complete unchanged source revalidation at exact real file counts."""
import argparse
import gc
import json
import statistics
import tempfile
import time
import tracemalloc
from pathlib import Path
from unittest import mock

from benchmarks.snapshot_scandir_candidate import snapshot_scandir, snapshot_scandir_parallel, snapshot_scandir_bounded
from django_orm_intellisense.discovery import workspace


def run(count, repetitions):
    with tempfile.TemporaryDirectory(prefix='djls-snapshot-scandir-') as temporary:
        root = Path(temporary).resolve()
        for number in range(count):
            folder = root / f'app{number // 500}'
            folder.mkdir(exist_ok=True)
            (folder / f'helper_{number}.py').write_text(f'value={number}\n')
        previous = workspace.snapshot_python_sources(root)
        expected = previous.to_cache_dict()
        modes = {'previous-walk-stat': workspace.snapshot_python_sources, 'candidate-scandir-stat': snapshot_scandir,
            'candidate-scandir-parallel': snapshot_scandir_parallel, 'candidate-scandir-bounded': snapshot_scandir_bounded}
        samples = {name: [] for name in modes}
        allocations = {}
        for round in range(repetitions):
            for mode in list(modes) if round % 2 == 0 else list(reversed(modes)):
                gc.collect()
                cpu, started = time.process_time_ns(), time.perf_counter_ns()
                current = modes[mode](root, previous_snapshot=previous)
                row = {'wallMs': (time.perf_counter_ns()-started)/1e6, 'cpuMs': (time.process_time_ns()-cpu)/1e6}
                assert current is previous and current.to_cache_dict() == expected and current.files == previous.files
                row['completeCurrentIdentityEqual'] = True
                samples[mode].append(row)
        for mode, call in modes.items():
            gc.collect()
            tracemalloc.start()
            current = call(root, previous_snapshot=previous)
            retained, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
            assert current is previous
            allocations[mode] = {'additionalRetainedBytes': retained, 'additionalPeakBytes': peak}
        return {'pythonFiles': count, 'repetitions': repetitions, 'samples': samples,
            'summary': {mode: {'wallMedianMs': statistics.median(row['wallMs'] for row in values),
                'cpuMedianMs': statistics.median(row['cpuMs'] for row in values), **allocations[mode]}
                for mode, values in samples.items()}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--files', type=int, nargs='+', default=[1000, 5000, 10000])
    parser.add_argument('--repetitions', type=int, default=9)
    args = parser.parse_args()
    print(json.dumps({'productionApplied': False, 'rows': [run(count, args.repetitions) for count in args.files],
        'scope': 'Nine rotating complete unchanged all-file identity/membership revalidations per tier. Candidates sequential freshos.stat, full raw-source parallel batches, or bounded max16pending64-file batches; no directory symlink descent and changed/unsafe fullscan fallback. Previous uses8worker stat pass after os.walk membership. Every snapshot value and owner identity checked; separate allocation above owners. Local POSIX only, no slow filesystem/changed race/actual startup/platform/global budget proof.'}, indent=2))
