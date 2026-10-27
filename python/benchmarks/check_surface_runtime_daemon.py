"""Actual daemon restarts retain dynamic members and bypass stale timestamp pycs."""
import argparse
import json
import os
import py_compile
import tempfile
from pathlib import Path

from benchmarks.bench_daemon_lifecycle import Client
from benchmarks.check_surface_worker_runtime_fidelity import SOURCE


def run(output_dir, process_pool=False):
    output_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    with tempfile.TemporaryDirectory(prefix='djls-runtime-surface-daemon-') as temporary:
        folder = Path(temporary)
        root, cache = folder / 'project', folder / 'cache'
        package = root / 'runtime_surface'
        package.mkdir(parents=True)
        (package / '__init__.py').write_text('')
        source = package / 'models.py'
        source.write_text(SOURCE)
        (root / 'runtime_surface_settings.py').write_text(
            'INSTALLED_APPS = ["runtime_surface"]\nSECRET_KEY = "runtime-surface-daemon"\n'
            'DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"\n'
            'DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}}\n')
        bytecode = Path(py_compile.compile(str(source), doraise=True))
        stale_bytecode = bytecode.read_bytes()
        for phase in ('cold', 'cached-hit', 'cached-forced-miss', 'same-size-restored-mtime-edit',
                      'edited-cached-forced-miss'):
            if phase.endswith('forced-miss'):
                paths = list(cache.rglob('surface-index.json'))
                assert len(paths) == 1 and paths[0].resolve().is_relative_to(cache.resolve())
                paths[0].unlink()
            edited = phase.startswith('same-size') or phase.startswith('edited-')
            if phase.startswith('same-size'):
                before = source.stat()
                current = source.read_text().replace('attached_instance', 'modified_instance')
                assert len(current.encode()) == before.st_size
                source.write_text(current)
                os.utime(source, ns=(before.st_atime_ns, before.st_mtime_ns))
            client = Client(root, cache, keep_log=True,
                worker_environment={'DJLS_BG_PROCESS_POOL': '1' if process_pool else '0'})
            try:
                response, elapsed = client.request('initialize', {'workspaceRoot': str(root),
                    'settingsModule': 'runtime_surface_settings', 'deferRuntime': False})
                if response.get('surfaceIndex'):
                    published = response
                else:
                    published = client.wait_for_notification('surfaceIndexChanged',
                        lambda payload: 'runtime_surface.Post' in (payload.get('surfaceIndex') or {}))
                surface = published['surfaceIndex']['runtime_surface.Post']
                instance = 'modified_instance' if edited else 'attached_instance'
                for kind in ('instance', 'model_class'):
                    assert surface[kind][instance][0:2] == ['instance', 'runtime_surface.Post']
                    assert surface[kind]['attached_class'][0:2] == ['instance', 'runtime_surface.Post']
                    if edited:
                        assert 'attached_instance' not in surface[kind]
                for kind in ('manager', 'queryset', 'related_manager'):
                    assert surface[kind]['attached_query'][0] == 'queryset'
                assert surface['instance']['title'][3] == 'CharField'
                destination = output_dir / f'{phase}-payload.json'
                destination.write_text(json.dumps(published, sort_keys=True) + '\n')
                rows.append({'phase': phase, 'initializeRpcMs': elapsed,
                    'completeDynamicMemberAndScalarChecks': True, 'payload': str(destination),
                    'expectedInstanceMethod': instance})
            finally:
                client.close()
                log = output_dir / f'{phase}-daemon.log'
                log.write_bytes(Path(client.log.name).read_bytes())
            rows[-1]['daemonExitCode'] = client.process.returncode
            rows[-1]['daemonLog'] = str(log)
            assert client.process.returncode == 0
            if phase.endswith('forced-miss'):
                assert 'load_cached_runtime_inspection' in log.read_text()
            if phase == 'cached-hit':
                assert 'load_cached_surface_index(background)' in log.read_text()
            assert bytecode.read_bytes() == stale_bytecode, 'Fixture did not preserve the original timestamp pyc'
    return {'rows': rows, 'allFiveFreshDaemonsPassed': True, 'persistentProcessPool': process_pool,
        'staleTimestampBytecodePreservedAcrossEqualSizeEditAndRestart': True,
        'scope': 'Actual configured daemon cold, cached hit, forced surface-only miss, same-size '
            'restored-mtime source edit, then edited cached runtime with another surface-only miss. '
            'All dynamic instance/class/queryset receivers and scalar metadata checked; actual '
            'startup replies/publications and terminal exits. Original timestamp pyc remains '
            'unchanged. One model fixture, no performance/editor/broad source-race claim.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--process-pool', action='store_true')
    args = parser.parse_args()
    print(json.dumps(run(args.output_dir, args.process_pool), indent=2))
