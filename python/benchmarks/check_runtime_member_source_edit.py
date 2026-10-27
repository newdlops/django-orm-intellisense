"""Check actual same-daemon runtime member edits, without reloading Django classes."""
import argparse
import json
import os
import tempfile
from pathlib import Path

from benchmarks.bench_daemon_lifecycle import Client
from benchmarks.check_surface_worker_runtime_fidelity import SOURCE


def run(output_dir):
    output_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='djls-runtime-member-edit-') as temporary:
        base = Path(temporary)
        root, cache = base / 'project', base / 'cache'
        package = root / 'runtime_surface'
        package.mkdir(parents=True)
        (package / '__init__.py').write_text('')
        source = package / 'models.py'
        source.write_text(SOURCE)
        (root / 'runtime_surface_settings.py').write_text(
            'INSTALLED_APPS=["runtime_surface"]\nSECRET_KEY="runtime-edit"\n'
            'DEFAULT_AUTO_FIELD="django.db.models.BigAutoField"\n'
            'DATABASES={"default":{"ENGINE":"django.db.backends.sqlite3","NAME":":memory:"}}\n')
        client = Client(root, cache, keep_log=True)
        try:
            initialized, initialize_ms = client.request('initialize', {'workspaceRoot': str(root),
                'settingsModule': 'runtime_surface_settings', 'deferRuntime': False})
            full = initialized if initialized.get('surfaceIndex') else client.wait_for_notification(
                'surfaceIndexChanged', lambda value: 'runtime_surface.Post' in (value.get('surfaceIndex') or {}))
            old_surface = full['surfaceIndex']['runtime_surface.Post']
            changes = {'attached_instance': 'modified_instance', 'attached_class': 'modified_class',
                'attached_query': 'modified_query'}
            original = source.stat()
            edited = SOURCE
            for old, new in changes.items():
                assert old in edited and len(old) == len(new)
                edited = edited.replace(old, new)
            assert len(edited.encode()) == original.st_size
            source.write_text(edited)
            os.utime(source, ns=(original.st_atime_ns, original.st_mtime_ns))
            result, edit_ms = client.request('reindexFile', {'filePath': str(source)})
            surface = result['surfaceIndexDelta']['runtime_surface.Post']
            receivers = {}
            for kind in ('instance', 'model_class', 'manager', 'queryset', 'related_manager'):
                selected = list(changes)[:2] if kind in ('instance', 'model_class') else ['attached_query']
                assert all(name in old_surface[kind] for name in selected)
                receivers[kind] = {'oldNamesStillPresent': [name for name in selected if name in surface[kind]],
                    'newNamesMissing': [changes[name] for name in selected if changes[name] not in surface[kind]]}
            checks = {kind: not row['oldNamesStillPresent'] and not row['newNamesMissing']
                for kind, row in receivers.items()}
            for name, value in [('before', full), ('edited', result)]:
                (output_dir / f'{name}-payload.json').write_text(json.dumps(value, sort_keys=True) + '\n')
        finally:
            client.close()
            log = output_dir / 'daemon.log'
            log.write_bytes(Path(client.log.name).read_bytes())
        assert client.process.returncode == 0
        return {'initializeRpcMs': initialize_ms, 'editRpcMs': edit_ms,
            'sameDaemonProcess': True, 'sameSizeRestoredMtimeEdit': True,
            'allEditedRuntimeNamesCurrent': all(checks.values()), 'receiverChecks': checks,
            'differences': receivers, 'daemonExitCode': client.process.returncode,
            'beforePayload': str(output_dir / 'before-payload.json'),
            'editedPayload': str(output_dir / 'edited-payload.json'), 'daemonLog': str(log),
            'scope': 'Actual configured daemon initial full surface followed by one source edit '
                'and reindexFile in the same process. Instance/class/queryset dynamic assignment '
                'renames for all five receivers; source size and mtime restored. '
                'Does not restart/reload Django or assert broad decorators or latency budgets.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    value = run(args.output_dir)
    print(json.dumps(value, indent=2), flush=True)
    if not value['allEditedRuntimeNamesCurrent']:
        raise SystemExit(1)
