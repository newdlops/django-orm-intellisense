"""Measure complete venv discovery with accurate editable metadata enumeration."""
from __future__ import annotations
import argparse
import cProfile
import json
import pstats
import statistics
import tempfile
import time
from pathlib import Path
from unittest import mock

from django_orm_intellisense.discovery import workspace
from django_orm_intellisense.discovery.workspace import resolve_venv_info


def _text_stream_reader(path, *, directory_fd=None):
    """Previous reader for controlled comparison, never a production fallback."""
    descriptor = workspace._metadata_descriptor(path, directory_fd)
    try:
        with open(descriptor, encoding='utf-8', closefd=False) as metadata:
            return json.load(metadata)
    finally:
        workspace.os.close(descriptor)


def _reader_payload_comparison():
    import tracemalloc
    with tempfile.TemporaryDirectory(prefix='djls-metadata-payload-') as temporary:
        path = Path(temporary) / 'direct_url.json'
        expected = {'extra': '한글' * 100000, 'dir_info': {'editable': True}, 'url': 'file:///source'}
        path.write_text(json.dumps(expected, ensure_ascii=False), encoding='utf-8')
        rows = []
        for name, reader in [('text-stream', _text_stream_reader),
                             ('descriptor-bytes', workspace._read_direct_url_metadata)]:
            tracemalloc.start()
            try:
                result = reader(str(path))
                current, peak = tracemalloc.get_traced_memory()
            finally:
                tracemalloc.stop()
            assert result == expected
            rows.append({'reader': name, 'payloadBytes': path.stat().st_size,
                         'currentBytes': current, 'peakBytes': peak, 'equivalent': True})
        return {'rows': rows, 'scope': 'Tracemalloc reader allocations for one full large UTF-8 metadata object. Fixture/expected value created outside tracing; excludes whole process/workspace/Node heap.'}


def run(repetitions, compare_backends=False, compare_readers=False):
    rows = []
    for count in (0, 500, 2000):
        with tempfile.TemporaryDirectory(prefix='djls-venv-metadata-') as temporary:
            root = Path(temporary)
            venv = root / '.venv'
            packages = venv / 'lib/python3.12/site-packages'
            packages.mkdir(parents=True)
            (venv / 'pyvenv.cfg').write_text('version = 3.12.13\ninclude-system-site-packages = false\n')
            source = root / 'editable source'
            source.mkdir()
            expected = [('legacy', str(source), 'egg-link')]
            (packages / 'legacy.egg-link').write_text(str(source) + '\n.')
            for number in range(count):
                metadata = packages / f'package_{number}-1.0.dist-info'
                metadata.mkdir()
                if number % 29 == 0:
                    (metadata / 'direct_url.json').write_text(json.dumps({'url': source.as_uri(),
                        'dir_info': {'editable': True}}))
                    expected.append((f'package_{number}', str(source), 'direct-url'))
                elif number % 17 == 0:
                    (metadata / 'direct_url.json').write_text('{invalid')
                elif number % 11 == 0:
                    (metadata / 'direct_url.json').write_text(json.dumps({'url': source.as_uri(),
                        'dir_info': {'editable': False}}))
            samples = []
            for _ in range(repetitions):
                started = time.perf_counter()
                result = resolve_venv_info(root)
                samples.append((time.perf_counter() - started) * 1000)
                assert sorted((entry.name, entry.path, entry.kind) for entry in result.editable_installs) == sorted(expected)
            profiler = cProfile.Profile()
            profiler.runcall(resolve_venv_info, root)
            functions = [{'file': key[0], 'function': key[2], 'calls': value[1],
                          'selfMs': value[2] * 1000, 'cumulativeMs': value[3] * 1000}
                         for key, value in pstats.Stats(profiler).stats.items()]
            functions.sort(key=lambda row: row['cumulativeMs'], reverse=True)
            row = {'metadataDirectories': count, 'editableInstalls': len(expected),
                         'samplesMs': samples, 'medianMs': statistics.median(samples),
                         'maxMs': max(samples), 'budgetMs': 5, 'pass': max(samples) < 5,
                         'profileFunctions': functions[:12]}
            if compare_backends:
                paired = {'portable': [], 'relative': []}
                if workspace._RELATIVE_METADATA_SUPPORTED:
                    for revision in range(repetitions):
                        order = ('portable', 'relative') if revision % 2 == 0 else ('relative', 'portable')
                        for backend in order:
                            with mock.patch.object(workspace, '_RELATIVE_METADATA_SUPPORTED', backend == 'relative'):
                                started = time.perf_counter()
                                result = resolve_venv_info(root)
                                elapsed = (time.perf_counter() - started) * 1000
                            assert sorted((entry.name, entry.path, entry.kind) for entry in result.editable_installs) == sorted(expected)
                            paired[backend].append(elapsed)
                    row['backendComparison'] = {backend: {'samplesMs': values,
                        'medianMs': statistics.median(values), 'maxMs': max(values), 'equivalent': True}
                        for backend, values in paired.items()}
                else:
                    row['backendComparison'] = {'available': False}
            if compare_readers:
                current_reader = workspace._read_direct_url_metadata
                readers = {'text-stream': _text_stream_reader, 'descriptor-bytes': current_reader}
                wall = {name: [] for name in readers}
                cpu = {name: [] for name in readers}
                for revision in range(repetitions):
                    order = list(readers) if revision % 2 == 0 else list(reversed(readers))
                    for name in order:
                        with mock.patch.object(workspace, '_read_direct_url_metadata', readers[name]):
                            started_cpu = time.process_time()
                            started = time.perf_counter()
                            result = resolve_venv_info(root)
                            wall[name].append((time.perf_counter() - started) * 1000)
                            cpu[name].append((time.process_time() - started_cpu) * 1000)
                        assert sorted((entry.name, entry.path, entry.kind) for entry in result.editable_installs) == sorted(expected)
                row['readerComparison'] = {name: {'samplesMs': wall[name],
                    'medianMs': statistics.median(wall[name]), 'maxMs': max(wall[name]),
                    'cpuSamplesMs': cpu[name], 'cpuMedianMs': statistics.median(cpu[name]),
                    'equivalent': True} for name in readers}
            rows.append(row)
    report = {'repetitions': repetitions, 'rows': rows,
            'scope': 'Complete synchronous resolve_venv_info with 0/500/2000 metadata directories. Accurate legacy and modern editables, ordinary/malformed metadata and missing direct_url files. No cross-request cache or recursive source discovery.',
            'allBudgetsPassed': all(row['pass'] for row in rows)}
    if compare_readers:
        report['readerPayloadComparison'] = _reader_payload_comparison()
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--repetitions', type=int, default=7)
    parser.add_argument('--compare-backends', action='store_true')
    parser.add_argument('--compare-readers', action='store_true')
    args = parser.parse_args()
    if args.repetitions < 1:
        parser.error('Repetitions must be positive')
    print(json.dumps(run(args.repetitions, args.compare_backends, args.compare_readers), indent=2))
