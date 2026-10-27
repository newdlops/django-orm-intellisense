"""Measure evidence retained for cheaper current-source revalidation."""
import gc
import importlib.util
import json
import statistics
import sys
import tempfile
import time
import tracemalloc
from pathlib import Path

from django_orm_intellisense.discovery import workspace


def previous_module():
    source = Path(workspace.__file__).read_text()
    start = source.index('    previous_identities = None', source.index('def snapshot_python_sources('))
    end = source.index('        # For files outside workspace root', start)
    source = source[:start] + '''    def _stat_one(python_file: Path):
        try:
            stat_result = python_file.stat()
        except OSError:
            return None
''' + source[end:]
    source = source.replace('            identity,\n', '')
    start = source.index('    identities = []', source.index('def snapshot_python_sources('))
    end = source.index('    directory_fingerprints = _build_directory_fingerprints(entries)', start)
    source = source[:start] + '''    def _stat_batch(batch):
        return [result for python_file in batch if (result := _stat_one(python_file)) is not None]

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        batches = (python_files[offset:offset + 64] for offset in range(0, len(python_files), 64))
        for batch in executor.map(_stat_batch, batches):
            for python_file, entry in batch:
                files.append(python_file)
                entries.append(entry)

''' + source[end:]
    source = source.replace('        _file_identities=tuple(identities),\n', '')
    name = 'django_orm_intellisense.discovery._previous_snapshot_identity'
    spec = importlib.util.spec_from_file_location(name, workspace.__file__)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    exec(compile(source, str(workspace.__file__) + ':previous_identity', 'exec'), module.__dict__)
    return module


def run(file_count, repetitions=9):
    previous = previous_module()
    with tempfile.TemporaryDirectory(prefix='djls-snapshot-identity-overhead-') as temporary:
        root = Path(temporary).resolve()
        for number in range(file_count):
            directory = root / f'app{number // 500}'
            directory.mkdir(exist_ok=True)
            (directory / f'helper_{number}.py').write_text(f'value={number}\n')
        baseline = previous.snapshot_python_sources(root)
        expected = baseline.to_cache_dict()
        modes = {'previous-no-identity-retention': previous, 'current-identity-retention': workspace}
        samples = {name: [] for name in modes}
        allocation = {}
        for revision in range(repetitions):
            order = list(modes) if revision % 2 == 0 else list(reversed(modes))
            for name in order:
                gc.collect()
                cpu, wall = time.process_time_ns(), time.perf_counter_ns()
                result = modes[name].snapshot_python_sources(root)
                sample = {'wallMs': (time.perf_counter_ns() - wall) / 1e6,
                          'cpuMs': (time.process_time_ns() - cpu) / 1e6}
                assert result.to_cache_dict() == expected and result.files == baseline.files
                sample['completeSnapshotEqual'] = True
                samples[name].append(sample)
                del result
        for name in modes:
            gc.collect()
            tracemalloc.start(1)
            result = modes[name].snapshot_python_sources(root)
            retained, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
            assert result.to_cache_dict() == expected
            allocation[name] = {'retainedBytes': retained, 'peakBytes': peak}
            del result
        return {'pythonFiles': file_count, 'repetitions': repetitions, 'samples': samples,
            'summary': {mode: {'wallMedianMs': statistics.median(row['wallMs'] for row in values),
                              'cpuMedianMs': statistics.median(row['cpuMs'] for row in values),
                              **allocation[mode]} for mode, values in samples.items()}}


if __name__ == '__main__':
    print(json.dumps({'date': '2026-10-09', 'rows': [run(count) for count in [1000, 5000, 10000]],
        'scope': 'Previous source reconstructed by removing new identity retention/reuse branches; current full freshsnapshot with evidence retained. Alternating9 allsource snapshot calls/tier fullwire/files equal. Separate tracedallocationincludesnewidentity tuples, not existingfixture/runtime/daemon/Node/aggregatepeak. Quantifies cold snapshot evidence overhead; hostuncontrolled, not wholestartup or stablepercentage.'}, indent=2))
