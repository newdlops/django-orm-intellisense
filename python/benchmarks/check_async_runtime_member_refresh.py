"""Actual same-daemon consecutive runtime method/named-manager source edits."""
import argparse
import json
import os
import py_compile
import tempfile
import time
from pathlib import Path

from benchmarks.bench_daemon_lifecycle import Client
from benchmarks.check_surface_worker_runtime_fidelity import SOURCE


def run(output_dir, process_pool=False, custom_app_label=False, dynamic_manager=False):
    output_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    with tempfile.TemporaryDirectory(prefix='djls-async-runtime-members-') as temporary:
        base = Path(temporary)
        root, cache = base / 'project', base / 'cache'
        package = root / 'runtime_surface'
        package.mkdir(parents=True)
        (package / '__init__.py').write_text('')
        app_label = 'custom_runtime' if custom_app_label else 'runtime_surface'
        label = app_label + '.Post'
        (package / 'apps.py').write_text('from django.apps import AppConfig\n'
            'class RuntimeSurfaceConfig(AppConfig):\n    name="runtime_surface"\n'
            f'    label="{app_label}"\n')
        source = package / 'models.py'
        assert SOURCE.count('    objects = ProjectManager()') == 1
        original = (SOURCE + '\nPost.add_to_class("special", ProjectManager())\n' if dynamic_manager
            else SOURCE.replace('    objects = ProjectManager()',
                '    objects = ProjectManager()\n    special = ProjectManager()'))
        source.write_text(original)
        bytecode = Path(py_compile.compile(str(source), doraise=True))
        stale_bytecode = bytecode.read_bytes()
        (root / 'runtime_surface_settings.py').write_text(
            'INSTALLED_APPS=["runtime_surface"]\nSECRET_KEY="async-runtime-edit"\n'
            'DEFAULT_AUTO_FIELD="django.db.models.BigAutoField"\n'
            'DATABASES={"default":{"ENGINE":"django.db.backends.sqlite3","NAME":":memory:"}}\n')
        client = Client(root, cache, keep_log=True,
            worker_environment={'DJLS_BG_PROCESS_POOL': '1' if process_pool else '0'})
        try:
            initialized, initialize_ms = client.request('initialize', {'workspaceRoot': str(root),
                'settingsModule': 'runtime_surface_settings', 'deferRuntime': False})
            full = initialized if initialized.get('surfaceIndex') else client.wait_for_notification(
                'surfaceIndexChanged', lambda value: label in (value.get('surfaceIndex') or {}))
            initial_surface = full['surfaceIndex'][label]
            assert 'special' in initial_surface['model_class'], (label, 'missing runtime manager')
            for kind in ('instance', 'model_class', 'manager', 'queryset', 'related_manager'):
                names = ('attached_instance', 'attached_class') if kind in ('instance', 'model_class') else ('attached_query',)
                for name in names:
                    assert name in initial_surface[kind], (label, kind, name)
                    resolved, _ = client.request('resolveOrmMember', {'modelLabel': label,
                        'receiverKind': kind, 'name': name})
                    assert resolved['resolved'], resolved
            initial_path = output_dir / 'initial-payload.json'
            initial_path.write_text(json.dumps(full, sort_keys=True) + '\n')
            previous_prefix, previous_manager = 'attached', 'special'
            for prefix, manager in [('modified', 'another'), ('replaced', 'revised')]:
                stamp = source.stat()
                edited = source.read_text().replace(previous_prefix + '_', prefix + '_')
                edited = edited.replace(previous_manager + ' = ProjectManager()', manager + ' = ProjectManager()')
                edited = edited.replace('"' + previous_manager + '"', '"' + manager + '"')
                assert len(edited.encode()) == stamp.st_size
                source.write_text(edited)
                os.utime(source, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
                started = time.perf_counter()
                reply, rpc_ms = client.request('reindexFile', {'filePath': str(source)})
                assert reply['runtimeMembersPending'] is True
                pending_surface = reply['surfaceIndexDelta'][label]
                for kind in ('instance', 'model_class'):
                    assert previous_prefix + '_instance' not in pending_surface[kind]
                    assert previous_prefix + '_class' not in pending_surface[kind]
                for kind in ('manager', 'queryset', 'related_manager'):
                    assert previous_prefix + '_query' not in pending_surface[kind]
                def current(value):
                    surface = (value.get('surfaceIndex') or {}).get(label) or {}
                    return (value.get('runtimeMembersPending') is False
                        and prefix + '_instance' in surface.get('instance', {})
                        and manager in surface.get('model_class', {}))
                full = client.wait_for_notification('surfaceIndexChanged', current)
                ready_ms = (time.perf_counter() - started) * 1000
                surface = full['surfaceIndex'][label]
                assert previous_manager not in surface['model_class']
                assert surface['instance']['title'][3] == 'CharField'
                health = full['health']
                preview = next(model for model in health['runtime']['modelPreview'] if model['label'] == label)
                assert manager in preview['managerNames'], (manager, preview['managerNames'])
                assert previous_manager not in preview['managerNames'], preview
                current_health, _ = client.request('health', {})
                assert current_health == health, (current_health, health)
                checks = []
                for kind in ('instance', 'model_class', 'manager', 'queryset', 'related_manager'):
                    new_names = [prefix + '_instance', prefix + '_class'] if kind in ('instance', 'model_class') else [prefix + '_query']
                    old_names = [previous_prefix + '_instance', previous_prefix + '_class'] if kind in ('instance', 'model_class') else [previous_prefix + '_query']
                    for name in new_names:
                        assert name in surface[kind]
                        resolved, elapsed = client.request('resolveOrmMember', {'modelLabel': label,
                            'receiverKind': kind, 'name': name})
                        assert resolved['resolved'], resolved
                        checks.append({'receiverKind': kind, 'name': name, 'rpcMs': elapsed, 'resolved': True})
                    for name in old_names:
                        assert name not in surface[kind]
                        resolved, _ = client.request('resolveOrmMember', {'modelLabel': label,
                            'receiverKind': kind, 'name': name})
                        assert not resolved['resolved'], resolved
                for kind in ('manager', 'queryset', 'related_manager'):
                    resolved, elapsed = client.request('resolveOrmMember', {'modelLabel': label,
                        'receiverKind': kind, 'managerName': manager, 'name': prefix + '_query'})
                    assert resolved['resolved'], resolved
                    checks.append({'receiverKind': kind, 'managerName': manager,
                        'name': prefix + '_query', 'rpcMs': elapsed, 'resolved': True})
                    chain, _ = client.request('resolveOrmMemberChain', {'modelLabel': label,
                        'receiverKind': kind, 'managerName': manager, 'chain': [prefix + '_query']})
                    assert chain['resolved'] and chain['receiverKind'] == 'queryset', chain
                assert bytecode.read_bytes() == stale_bytecode
                pending_path = output_dir / f'{prefix}-pending-payload.json'
                pending_path.write_text(json.dumps(reply, sort_keys=True) + '\n')
                path = output_dir / f'{prefix}-ready-payload.json'
                path.write_text(json.dumps(full, sort_keys=True) + '\n')
                rows.append({'phase': prefix, 'editRpcMs': rpc_ms, 'asyncReadyFromEditMs': ready_ms,
                    'allFiveReceiverNamesCurrent': True, 'oldNamesExcludedWhilePending': True,
                    'namedManagerAndChainsCurrent': True, 'changedManagerName': manager,
                    'healthManagerPreviewCurrent': True, 'healthRpcMatchesPublishedSnapshot': True,
                    'sameSizeRestoredMtimeAndStalePycPreserved': True,
                    'onDemandQueries': checks, 'pendingPayload': str(pending_path), 'payload': str(path)})
                previous_prefix, previous_manager = prefix, manager
        finally:
            client.close()
            log = output_dir / 'daemon.log'
            log.write_bytes(Path(client.log.name).read_bytes())
        assert client.process.returncode == 0
    return {'productionApplied': True, 'sameDaemonConsecutiveEdits': True,
        'customAppLabel': custom_app_label, 'modelLabel': label,
        'dynamicallyAttachedManager': dynamic_manager,
        'initialAllFiveReceiverNamesPresent': True, 'initialPayload': str(initial_path),
        'persistentProcessPool': process_pool, 'initializeRpcMs': initialize_ms,
        'daemonExitCode': client.process.returncode, 'daemonLog': str(log), 'rows': rows,
        'scope': 'Actual configured same daemon across two dynamic method/named-manager renames. '
            'Equal-size/restored-mtime source with original timestamp pyc retained. Pending reply '
            'excludes stale methods, complete current notification then default/named-manager '
            'on-demand and chain lookups checked across all five receivers. Timings observed, '
            'not stable RPC/editor/startup or aggregate-memory proof.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--process-pool', action='store_true')
    parser.add_argument('--custom-app-label', action='store_true')
    parser.add_argument('--dynamic-manager', action='store_true')
    args = parser.parse_args()
    print(json.dumps(run(args.output_dir, args.process_pool, args.custom_app_label, args.dynamic_manager), indent=2))
