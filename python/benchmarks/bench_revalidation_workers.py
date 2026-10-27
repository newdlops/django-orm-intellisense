"""Compare worker counts for full stat-only source identity revalidation."""
import gc
import json
import statistics
import tempfile
import time
from pathlib import Path

from django_orm_intellisense.discovery.workspace import snapshot_python_sources


def run(file_count, repetitions=9):
    with tempfile.TemporaryDirectory(prefix='djls-revalidate-workers-') as temporary:
        root = Path(temporary).resolve()
        for number in range(file_count):
            directory = root / f'app{number // 500}'
            directory.mkdir(exist_ok=True)
            (directory / f'helper_{number}.py').write_text(f'value={number}\n')
        previous = snapshot_python_sources(root)
        expected = previous.to_cache_dict()
        modes = {'full-8': (8, None), 'reuse-8': (8, previous), 'reuse-4': (4, previous),
                 'reuse-2': (2, previous), 'reuse-1': (1, previous)}
        samples = {mode: [] for mode in modes}
        for revision in range(repetitions):
            order = list(modes)[revision % len(modes):] + list(modes)[:revision % len(modes)]
            for mode in order:
                workers, old = modes[mode]
                gc.collect()
                cpu, wall = time.process_time_ns(), time.perf_counter_ns()
                result = snapshot_python_sources(root, previous_snapshot=old, max_workers=workers)
                sample = {'wallMs': (time.perf_counter_ns() - wall) / 1e6,
                          'cpuMs': (time.process_time_ns() - cpu) / 1e6}
                assert result.to_cache_dict() == expected and result.files == previous.files
                assert (result is previous) == (old is previous)
                sample['completeSnapshotEqual'] = True
                samples[mode].append(sample)
                del result
        return {'pythonFiles': file_count, 'repetitions': repetitions, 'samples': samples,
            'summary': {mode: {'wallMedianMs': statistics.median(row['wallMs'] for row in values),
                              'cpuMedianMs': statistics.median(row['cpuMs'] for row in values)}
                        for mode, values in samples.items()}}


if __name__ == '__main__':
    print(json.dumps({'date': '2026-10-09', 'productionWorkerCountChanged': False,
        'rows': [run(count) for count in [1000, 5000, 10000]],
        'scope': 'Rotating9 per tier current inventory/fullstat identity calls. Comparefull8 andverifiedreuse8/4/2/1 withsame64filebatches. Allsourcewire/files/order identical eachcall; onlyworker countcandidate. No slowfilesystem/platform/daemon/fullstartup/peak/CPUpercentageproof, hostuncontrolled.'}, indent=2))
