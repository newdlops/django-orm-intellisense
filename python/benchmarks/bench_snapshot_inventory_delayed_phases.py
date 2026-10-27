"""Separate inventory CPU/wall from unchanged delayed source stat stages."""
import gc
import json
import os
import statistics
import tempfile
import time
from pathlib import Path
from unittest import mock

from benchmarks.snapshot_inventory_marks_candidate import candidate_module
from django_orm_intellisense.discovery import workspace


with tempfile.TemporaryDirectory(prefix='djls-inventory-delayed-phases-') as temporary:
    root = Path(temporary).resolve()
    for number in range(1000):
        folder = root / f'app{number//500}'
        folder.mkdir(exist_ok=True)
        (folder / f'helper_{number}.py').write_text(f'value={number}\n')
    previous = workspace.snapshot_python_sources(root)
    expected = previous.to_cache_dict()
    candidate = candidate_module()
    final = os.environ.get('DJLS_BENCH_CURRENT_INVENTORY_MARKS') == '1'
    modes = {'previous-two-sets': candidate_module(previous=True), 'current-marks': workspace} if final else {'current-two-sets': workspace, 'candidate-marks': candidate}
    samples = {mode: [] for mode in modes}
    original_stat = workspace.os.stat

    def delayed(path, *args, **kwargs):
        if str(path).endswith('.py'):
            time.sleep(0.0002)
        return original_stat(path, *args, **kwargs)

    for revision in range(15):
        for mode in list(modes) if revision%2==0 else list(reversed(modes)):
            owner = modes[mode]
            original_inventory = owner._unchanged_source_inventory
            phases = []

            def inventory(*args, **kwargs):
                cpu, started = time.thread_time_ns(), time.perf_counter_ns()
                try: return original_inventory(*args, **kwargs)
                finally:
                    phases.append({'inventoryWallMs': (time.perf_counter_ns()-started)/1e6,
                        'inventoryThreadCpuMs': (time.thread_time_ns()-cpu)/1e6})

            with mock.patch.object(owner, '_unchanged_source_inventory', inventory), mock.patch.object(workspace.os, 'stat', delayed):
                gc.collect()
                cpu, started = time.process_time_ns(), time.perf_counter_ns()
                result = owner.snapshot_python_sources(root, previous_snapshot=previous)
                row = {'wallMs': (time.perf_counter_ns()-started)/1e6,
                    'cpuMs': (time.process_time_ns()-cpu)/1e6}
            assert result is previous and result.to_cache_dict() == expected and len(phases) == 1
            row.update(phases[0])
            row['postInventoryWallMs'] = row['wallMs']-row['inventoryWallMs']
            row['fullCurrentOwnerEqual'] = True
            samples[mode].append(row)
    print(json.dumps({'date': '2026-10-10', 'productionApplied': final, 'pythonFiles': 1000,
        'delaySecondsPerStat': 0.0002, 'samples': samples,
        'summary': {mode: {key: statistics.median(row[key] for row in values)
            for key in ['wallMs', 'cpuMs', 'inventoryWallMs', 'inventoryThreadCpuMs', 'postInventoryWallMs']} for mode, values in samples.items()},
        'scope': '15alternating1000file unchangedsameowner scanswith0.2mssyntheticstatdelay. Inventorywall/mainthreadCPU timed separatelyfrompostinventorythreadcreation/stat/collect/shutdown. Allcurrentmembership/stat/owner equal; profiling/hostuncontrolled, notrealnetworkFS/stableallstartup/truepeak proof.'}, indent=2))
