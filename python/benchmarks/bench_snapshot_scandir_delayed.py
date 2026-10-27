"""Controlled slow metadata comparison; no automatic production policy claim."""
import json
import statistics
import tempfile
import time
from pathlib import Path
from unittest import mock

from benchmarks.snapshot_scandir_candidate import snapshot_scandir, snapshot_scandir_parallel, snapshot_scandir_bounded
from django_orm_intellisense.discovery import workspace


with tempfile.TemporaryDirectory(prefix='djls-scandir-delayed-stat-') as temporary:
    root = Path(temporary).resolve()
    for number in range(1000):
        (root / f'helper_{number}.py').write_text(f'value={number}\n')
    previous = workspace.snapshot_python_sources(root)
    expected = previous.to_cache_dict()
    original_stat = workspace.os.stat
    modes = {'previous-walk-stat': workspace.snapshot_python_sources,
        'candidate-scandir-stat': snapshot_scandir, 'candidate-scandir-parallel': snapshot_scandir_parallel,
        'candidate-scandir-bounded': snapshot_scandir_bounded}
    samples = {mode: [] for mode in modes}

    def delayed(source, *args, **kwargs):
        if str(source).endswith('.py'):
            time.sleep(0.0002)
        return original_stat(source, *args, **kwargs)

    for round in range(3):
        names = list(modes)
        for mode in names[round:] + names[:round]:
            with mock.patch.object(workspace.os, 'stat', delayed):
                cpu, started = time.process_time_ns(), time.perf_counter_ns()
                actual = modes[mode](root, previous_snapshot=previous)
                row = {'wallMs': (time.perf_counter_ns()-started)/1e6, 'cpuMs': (time.process_time_ns()-cpu)/1e6}
            assert actual is previous and actual.to_cache_dict() == expected
            row['fullCurrentSourceEqual'] = True
            samples[mode].append(row)
    print(json.dumps({'candidateOnly': True, 'pythonFiles': 1000, 'delaySecondsPerStat': 0.0002,
        'samples': samples, 'summary': {mode: {'wallMedianMs': statistics.median(row['wallMs'] for row in rows),
            'cpuMedianMs': statistics.median(row['cpuMs'] for row in rows)} for mode, rows in samples.items()},
        'scope': 'Three rotating unchanged fullsource revalidations per candidate with0.2ms sleep injected into fresh os.stat of each .py. All values/current stat/owner equal; actual parallel8workers retained. Synthetic metadata latency tradeoff, no actual network filesystem/global startup/peak proof.'}, indent=2))
