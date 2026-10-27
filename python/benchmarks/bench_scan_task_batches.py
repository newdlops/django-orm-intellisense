"""Compare per-file futures and small grouped tasks with the same parser."""
import argparse
import importlib.util
import json
import statistics
import sys
import tempfile
import time
from pathlib import Path

from benchmarks.bench_reindex import generate_synthetic_project
from django_orm_intellisense.static_index import indexer


def candidate_module(batch_size):
    source = Path(indexer.__file__).read_text()
    old = '''                for result in executor.map(_parse_file, source_files[offset:offset + 64]):
                    _record_result(result)'''
    assert old in source
    new = f'''                window = source_files[offset:offset + 64]
                def parse_group(group):
                    return [_parse_file(file) for file in group]
                groups = [window[start:start + {batch_size}] for start in range(0, len(window), {batch_size})]
                for results in executor.map(parse_group, groups):
                    for result in results:
                        _record_result(result)'''
    source = source.replace(old, new)
    name = f'django_orm_intellisense.static_index._batch_candidate_{batch_size}'
    spec = importlib.util.spec_from_file_location(name, indexer.__file__)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    exec(compile(source, str(indexer.__file__) + f':batch{batch_size}', 'exec'), module.__dict__)
    return module


def run(file_count, repetitions):
    with tempfile.TemporaryDirectory(prefix='djls-scan-task-batches-') as temporary:
        root = Path(temporary).resolve()
        generate_synthetic_project(root, file_count // 10)
        count = len(list(root.rglob('*.py')))
        helper = root / 'helpers'
        helper.mkdir()
        for number in range(file_count - count):
            (helper / f'helper_{number}.py').write_text(f'value={number}\n')
        files = tuple(sorted(root.rglob('*.py')))
        modes = {'per-file-futures': indexer}
        modes.update({f'group-{size}': candidate_module(size) for size in [4, 8]})
        expected = indexer.build_static_index(root, files).to_cache_dict()
        samples = {mode: [] for mode in modes}
        for round in range(repetitions):
            names = list(modes)
            names = names[round % len(names):] + names[:round % len(names)]
            for mode in names:
                cpu, started = time.process_time_ns(), time.perf_counter_ns()
                actual = modes[mode].build_static_index(root, files)
                row = {'wallMs': (time.perf_counter_ns() - started) / 1e6,
                       'processCpuMs': (time.process_time_ns() - cpu) / 1e6}
                assert actual.to_cache_dict() == expected
                row['completeStaticWireEqual'] = True
                samples[mode].append(row)
        return {'pythonFiles': file_count, 'models': file_count // 10, 'repetitions': repetitions,
            'samples': samples, 'summary': {mode: {
                'wallMedianMs': statistics.median(row['wallMs'] for row in values),
                'cpuMedianMs': statistics.median(row['processCpuMs'] for row in values)}
                for mode, values in samples.items()}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--files', type=int, nargs='+', default=[1000, 5000, 10000])
    parser.add_argument('--repetitions', type=int, default=5)
    args = parser.parse_args()
    print(json.dumps({'date': '2026-10-09', 'productionApplied': False,
        'rows': [run(count, args.repetitions) for count in args.files],
        'scope': 'Rotating5 same complete static source fixture parses per mode/tier; same8threads/64filewindow/source ordering, only future task grouping4/8changes. Full index wire equality each call. Source files reused between runs, hostuncontrolled, no runtime/cache/startup/RPC/wholememory/platform/slowfilesystem stability proof.'}, indent=2))
