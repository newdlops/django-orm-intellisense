"""ABBA observations of a normal save on one 500-model/5000-file fixture."""
import argparse
import gzip
import hashlib
import json
import os
import shutil
import tempfile
import time
from pathlib import Path

from benchmarks.bench_async_runtime_member_refresh import create_fixture, assert_surface
from benchmarks.bench_daemon_lifecycle import Client
PREFIX = '[async-member:phase] '


def run(output_dir, baseline_manifest):
    output_dir.mkdir(parents=True, exist_ok=True)
    output_dir = output_dir.resolve()
    repo = Path(__file__).resolve().parents[2]
    baseline = json.loads(baseline_manifest.read_text())
    rows = []
    with tempfile.TemporaryDirectory(prefix='djls-model-refresh-cost-') as temporary:
        base = Path(temporary).resolve()
        original_code = base / 'baseline-python'
        for name in ('django_orm_intellisense', 'benchmarks'):
            shutil.copytree(repo / 'python' / name, original_code / name, ignore=shutil.ignore_patterns('__pycache__'))
        original_hashes = {}
        for source, entry in baseline['sources'].items():
            if not source.startswith('python/django_orm_intellisense/'):
                continue
            raw = gzip.decompress((repo / entry['archive']).read_bytes())
            assert hashlib.sha256(raw).hexdigest() == entry['sourceSha256'], source
            target = original_code / Path(source).relative_to('python')
            target.write_bytes(raw)
            original_hashes[source] = entry['sourceSha256']
        extra = 'python/django_orm_intellisense/features/lookup_paths.py'
        raw = gzip.decompress((repo / 'bench/runtime-new-model-baseline-python__django_orm_intellisense__features__lookup_paths.py.gz').read_bytes())
        (original_code / Path(extra).relative_to('python')).write_bytes(raw)
        original_hashes[extra] = hashlib.sha256(raw).hexdigest()
        root = base / 'project'
        root.mkdir()
        source, helper, bytecode = create_fixture(root, 500, 5000)
        initial = {path: (path.read_bytes(), path.stat()) for path in (source, helper)}
        with gzip.open(output_dir / 'fixture-sources.json.gz', 'wt') as stream:
            json.dump({str(path.relative_to(root)): path.read_text() for path in sorted(root.rglob('*.py'))}, stream, sort_keys=True)
        for order, variant in enumerate(('baseline', 'candidate', 'candidate', 'baseline')):
            for path, (content, stamp) in initial.items():
                path.write_bytes(content)
                os.utime(path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
            pythonpath = original_code if variant == 'baseline' else repo / 'python'
            client = Client(root, base / f'cache-{order}', keep_log=True, request_timeout_seconds=120,
                worker_module='benchmarks.profile_runtime_member_refresh_worker',
                worker_environment={'PYTHONPATH': str(pythonpath)})
            prefix = f'{order}-{variant}'
            try:
                initialized, initialize_ms = client.request('initialize', {'workspaceRoot': str(root),
                    'settingsModule': 'bench_settings', 'deferRuntime': False})
                full = initialized if len(initialized.get('surfaceIndex') or {}) == 500 else client.wait_for_notification(
                    'surfaceIndexChanged', lambda value: len(value.get('surfaceIndex') or {}) == 500, 120)
                assert_surface(full, 500, 'attached', 'special', 'CharField')
                deadline = time.perf_counter() + 30
                while 'runtime_field_registry(background) ready' not in Path(client.log.name).read_text():
                    assert time.perf_counter() < deadline
                    time.sleep(0.01)
                client.notifications.clear()
                for path, (content, stamp) in initial.items():
                    changed = content.decode().replace('attached_', 'modified_').replace('special = ProjectManager()', 'another = ProjectManager()')
                    changed = changed.replace('field_0 = models.CharField(max_length=255)', 'field_0 = models.CharField(max_length=10 )')
                    assert len(changed.encode()) == len(content)
                    path.write_text(changed)
                    os.utime(path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
                started = time.perf_counter()
                replies = [client.request('reindexFile', {'filePath': str(path)}) for path in (source, helper)]
                assert all(reply['runtimeMembersPending'] for reply, _ in replies)
                full = client.wait_for_notification('surfaceIndexChanged', lambda value:
                    value.get('runtimeMembersPending') is False and 'modified_query' in value.get('surfaceIndex', {}).get('app0.Model0', {}).get('queryset', {}), 120)
                ready_ms = (time.perf_counter() - started) * 1000
                assert_surface(full, 500, 'modified', 'another', 'DateField')
                assert all(path.read_bytes() == raw for path, raw in bytecode.items())
                with gzip.open(output_dir / (prefix + '-payload.json.gz'), 'wt') as stream:
                    json.dump(full, stream, sort_keys=True)
            finally:
                client.close()
                log = Path(client.log.name).read_text()
                (output_dir / (prefix + '-daemon.log')).write_text(log)
            assert client.process.returncode == 0
            phases = [json.loads(line[len(PREFIX):]) for line in log.splitlines() if line.startswith(PREFIX)]
            rows.append({'order': order, 'variant': variant, 'initializeRpcMs': initialize_ms,
                'saveToCompleteNotificationMs': ready_ms, 'reindexRpcMs': [elapsed for _, elapsed in replies],
                'completeMetadataChecked': True, 'daemonExitCode': client.process.returncode, 'phases': phases})
            (output_dir / 'progress.json').write_text(json.dumps(rows, indent=2) + '\n')
    return {'models': 500, 'pythonFiles': 5000, 'order': 'ABBA', 'rows': rows, 'baselineSourceHashes': original_hashes,
        'scope': 'One identical source fixture, four isolated cold caches, sequential ordinary model/helper saves; '
            'restored size/mtime and original pyc, same benchmark phase wrapper. All models/scalars/FKs/custom output '
            'and current health checked after each save. Timers include diagnostic overhead; uncontrolled host, '
            'two observations per variant, no stable speedup, foreground/editor latency or aggregate-memory proof.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--baseline-manifest', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.output_dir, args.baseline_manifest), indent=2))
