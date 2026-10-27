"""Pair exact source snapshots using pathlib vs cached POSIX components."""
import importlib.util
import json
import statistics
import sys
import tempfile
import time
from pathlib import Path
from unittest import mock

from django_orm_intellisense.discovery import workspace


def previous_module():
    source = Path(workspace.__file__).read_text()
    start = source.index('        if root_parts is not None:', source.index('def snapshot_python_sources('))
    end = source.index('        fingerprint = _file_fingerprint(', start)
    source = source[:start] + '''        try:
            relative_path = python_file.relative_to(root).as_posix()
        except ValueError:
            relative_path = str(python_file)
''' + source[end:]
    source = source.replace("    root_parts = root.parts if os.name == 'posix' else None\n", '')
    name = 'django_orm_intellisense.discovery._previous_snapshot_relative'
    spec = importlib.util.spec_from_file_location(name, workspace.__file__)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    exec(compile(source, str(workspace.__file__) + ':previous', 'exec'), module.__dict__)
    return module


def run(file_count, repetitions=9):
    with tempfile.TemporaryDirectory(prefix='djls-snapshot-relative-cost-') as temporary:
        root = Path(temporary).resolve()
        for number in range(file_count):
            directory = root / f'app{number // 500}'
            directory.mkdir(exist_ok=True)
            (directory / f'helper_{number}.py').write_text(f'value={number}\n')
        previous = previous_module()
        modes = {'previous-pathlib': previous, 'current-posix-parts': workspace}
        expected = previous.snapshot_python_sources(root).to_cache_dict()
        expected_files = previous.snapshot_python_sources(root).files
        samples = {mode: [] for mode in modes}
        for round in range(repetitions):
            for mode in list(modes) if round % 2 == 0 else list(reversed(modes)):
                cpu, started = time.process_time_ns(), time.perf_counter_ns()
                result = modes[mode].snapshot_python_sources(root)
                row = {'wallMs': (time.perf_counter_ns() - started) / 1e6,
                    'cpuMs': (time.process_time_ns() - cpu) / 1e6}
                assert result.to_cache_dict() == expected and result.files == expected_files
                row['allFilesIdentityAndDirectoryFingerprintsEqual'] = True
                samples[mode].append(row)
        counts = {}
        original = Path.relative_to
        for mode, module in modes.items():
            calls = [0]
            def relative(path, other, *args, **kwargs):
                calls[0] += 1
                return original(path, other, *args, **kwargs)
            with mock.patch.object(Path, 'relative_to', relative):
                result = module.snapshot_python_sources(root)
            counts[mode] = calls[0]
        assert counts['previous-pathlib'] == file_count and counts['current-posix-parts'] == 0
        return {'pythonFiles': file_count, 'repetitions': repetitions, 'samples': samples,
            'relativeToCalls': counts,
            'summary': {mode: {'wallMedianMs': statistics.median(row['wallMs'] for row in values),
                              'cpuMedianMs': statistics.median(row['cpuMs'] for row in values)}
                        for mode, values in samples.items()}}


if __name__ == '__main__':
    print(json.dumps({'date': '2026-10-09', 'rows': [run(count) for count in [1000, 5000, 10000]],
        'scope': 'Alternating9 complete source snapshot calls per tier with identical realfiles,8workers/64batches/full statidentity format2. Everyfile/order/entry/directory/rootfingerprint compares equal, relative_toNto0 count separate. Isolated snapshot wall/processCPU includes scan/stat/path/hash/threads, excludes parser/runtime/daemon/RPC/wholeheap/platform/slowFS/stablepercentage. Host uncontrolled.'}, indent=2))
