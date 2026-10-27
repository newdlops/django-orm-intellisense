"""Diagnostic worker tradeoff with artificially delayed source metadata."""
import json
import statistics
import tempfile
import time
from pathlib import Path
from unittest import mock

from django_orm_intellisense.discovery.workspace import snapshot_python_sources


with tempfile.TemporaryDirectory(prefix='djls-slow-stat-revalidate-') as temporary:
    root = Path(temporary).resolve()
    for number in range(1000):
        (root / f'helper_{number}.py').write_text(f'value={number}\n')
    previous = snapshot_python_sources(root)
    expected = previous.to_cache_dict()
    stat = Path.stat
    samples = {str(workers): [] for workers in [8, 2, 1]}

    def delayed(path, *args, **kwargs):
        time.sleep(0.0002)
        return stat(path, *args, **kwargs)

    for revision in range(3):
        modes = [8, 2, 1][revision:] + [8, 2, 1][:revision]
        for workers in modes:
            with mock.patch.object(Path, 'stat', delayed):
                cpu, wall = time.process_time_ns(), time.perf_counter_ns()
                result = snapshot_python_sources(root, previous_snapshot=previous, max_workers=workers)
                sample = {'wallMs': (time.perf_counter_ns() - wall) / 1e6,
                          'cpuMs': (time.process_time_ns() - cpu) / 1e6}
            assert result is previous and result.to_cache_dict() == expected
            sample['completeSnapshotEqual'] = True
            samples[str(workers)].append(sample)
    print(json.dumps({'pythonFiles': 1000, 'syntheticDelaySecondsPerStat': 0.0002,
        'repetitions': 3, 'samples': samples,
        'summary': {mode: {'wallMedianMs': statistics.median(row['wallMs'] for row in values),
                          'cpuMedianMs': statistics.median(row['cpuMs'] for row in values)}
                    for mode, values in samples.items()},
        'scope': 'Synthetic0.2ms sleep eachstat, fullcurrentstat/inventory unchangedwire. Diagnosticworker tradeoff, not real networkFS/platform/wholeRPC/CPUshare. No productionpolicyderivedwithoutrecordinglatencytradeoff.'}, indent=2))
