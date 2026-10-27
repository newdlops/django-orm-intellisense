"""Compare complete surface-cache reads from archived/current packages.

The supplied cache is read only. Every read is checked against its complete
canonical JSON payload. Timing and tracemalloc run in separate fresh processes;
memory numbers cover this restore only, not the editor or aggregate workers.
"""
from __future__ import annotations

import argparse
import gc
import hashlib
import json
import os
import statistics
import subprocess
import sys
import time
import tracemalloc
from pathlib import Path


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def payload_sha(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
        separators=(',', ':')).encode()).hexdigest()


def measure(manifest_path, memory):
    from django_orm_intellisense.cache import store

    manifest = json.loads(manifest_path.read_text())
    root = Path(manifest['root'])
    cache_path = store._workspace_cache_dir(root) / store.SURFACE_INDEX_CACHE_NAME
    assert str(cache_path) == manifest['surfaceCache']
    assert sha(cache_path) == manifest['surfaceCacheSha256']
    package = Path(store.__file__).resolve().parents[1]
    hashes = {path.relative_to(package).as_posix(): sha(path) for path in sorted(package.rglob('*.py'))}

    def load():
        result = store.load_cached_surface_index(root, manifest['sourceFingerprint'], manifest['runtimeFingerprint'])
        assert result is not None
        return result

    def verify(result):
        assert payload_sha(result) == manifest['payloadSha256'], 'Complete payload differs'
        assert len(result) == manifest['models']

    samples, cpu_samples = [], []
    if memory:
        gc.collect()
        tracemalloc.start()
        result = load()
        live, peak = tracemalloc.get_traced_memory()
        # Capture restore peak before allocating the JSON verification text.
        verify(result)
        del result
        released, _ = tracemalloc.get_traced_memory()
        gc.collect()
        collected, _ = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        costs = {'restoreLiveBytes': live, 'restorePeakBytes': peak,
            'afterReleaseBytes': released, 'afterCollectionBytes': collected}
    else:
        for index in range(manifest['iterations'] + 1):
            gc.collect()
            cpu_started = time.thread_time_ns()
            started = time.perf_counter_ns()
            result = load()
            elapsed = (time.perf_counter_ns() - started) / 1e6
            cpu_elapsed = (time.thread_time_ns() - cpu_started) / 1e6
            verify(result)
            del result
            if index:
                samples.append(elapsed)
                cpu_samples.append(cpu_elapsed)
        costs = {'warmupExcluded': True, 'samplesMs': samples, 'medianMs': statistics.median(samples),
            'threadCpuSamplesMs': cpu_samples, 'threadCpuMedianMs': statistics.median(cpu_samples)}
    assert sha(cache_path) == manifest['surfaceCacheSha256'], 'Read-only cache changed'
    assert all(sha(package / name) == digest for name, digest in hashes.items())
    return {'python': sys.version, 'pid': os.getpid(), 'workerPackageSha256': hashes,
        'driverSha256': sha(Path(__file__)), 'memory': memory, 'completePayloadSha256': manifest['payloadSha256'],
        'models': manifest['models'], 'surfaceCacheUnchanged': True, **costs}


def run(args):
    repo = Path(__file__).resolve().parents[2]
    args.output_dir.mkdir(parents=True, exist_ok=False)
    source_manifest = json.loads(args.manifest.read_text())
    baseline = json.loads(args.baseline.read_text())
    baseline_python = Path(baseline['pythonBaseline']['pythonPath'])
    for name, digest in baseline['pythonBaseline']['files'].items():
        assert sha(baseline_python / 'django_orm_intellisense' / name) == digest
    cache_paths = list(Path(source_manifest['cache']).glob('*/surface-index.json'))
    assert len(cache_paths) == 1, cache_paths
    cache_path = cache_paths[0]
    raw = json.loads(cache_path.read_text())
    common = {'root': source_manifest['root'], 'surfaceCache': str(cache_path),
        'surfaceCacheSha256': sha(cache_path), 'payloadSha256': payload_sha(raw['payload']),
        'sourceFingerprint': raw['metadata']['sourceFingerprint'],
        'runtimeFingerprint': raw['metadata']['runtimeFingerprint'],
        'models': len(raw['payload']), 'iterations': args.iterations,
        'driverSha256': sha(Path(__file__))}
    del raw
    rows = []
    for index, letter in enumerate(args.order):
        variant = 'baseline' if letter == 'A' else 'current'
        folder = args.output_dir / f'{index}-{variant}'
        folder.mkdir()
        python_path = baseline_python if variant == 'baseline' else repo / 'python'
        manifest = {**common, 'variant': variant, 'pythonPath': str(python_path)}
        path = folder / 'manifest.json'
        path.write_text(json.dumps(manifest, indent=2) + '\n')
        env = {**os.environ, 'PYTHONPATH': os.pathsep.join(dict.fromkeys([str(python_path), str(repo / 'python')])),
            'DJANGO_ORM_INTELLISENSE_CACHE_DIR': source_manifest['cache']}
        row = {'index': index, 'variant': variant, 'manifest': str(path)}
        for memory in [False, True]:
            command = [sys.executable, '-m', 'benchmarks.bench_surface_cache_compaction', '--measure', str(path)]
            if memory:
                command.append('--memory')
            completed = subprocess.run(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            label = 'memory' if memory else 'timing'
            (folder / (label + '-stderr.log')).write_text(completed.stderr)
            (folder / (label + '-stdout.log')).write_text(completed.stdout)
            assert completed.returncode == 0, (folder, label, completed.stderr)
            result = json.loads(completed.stdout)
            (folder / (label + '-result.json')).write_text(json.dumps(result, indent=2) + '\n')
            row[label] = result
        rows.append(row)
        print(f'[surface-cache-compaction] {index} {variant} timing+memory terminalExit0', file=sys.stderr, flush=True)
    return {'order': args.order, 'manifest': str(args.manifest), 'manifestSha256': sha(args.manifest),
        'baseline': str(args.baseline), 'baselineSha256': sha(args.baseline),
        'driverSha256': sha(Path(__file__)), **common, 'rows': rows,
        'scope': 'Same complete read-only surface cache; per-read canonical JSON equality. '
            'Fresh ordinary processes for timing and separate tracemalloc diagnostics. '
            'Warm filesystem; host load uncontrolled. Restore-only memory excludes static/runtime/graph, '
            'other processes and editor; no aggregate-memory or overall startup claim.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--baseline', type=Path, default=Path('bench/cached-startup-phases-baseline.json'))
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--iterations', type=int, default=7)
    parser.add_argument('--order', choices=['ABBA', 'BAAB'], default='ABBA')
    parser.add_argument('--measure', type=Path)
    parser.add_argument('--memory', action='store_true')
    args = parser.parse_args()
    if args.measure:
        result = measure(args.measure, args.memory)
    else:
        assert args.manifest and args.output_dir and args.iterations > 0
        args.manifest, args.baseline, args.output_dir = (p.resolve() for p in (args.manifest, args.baseline, args.output_dir))
        result = run(args)
    print(json.dumps(result, indent=2))
