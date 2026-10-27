"""Configured large-workspace startup and same-daemon model/helper saves."""
import argparse
import gzip
import json
import os
import py_compile
import tempfile
import time
from pathlib import Path

from benchmarks.bench_daemon_lifecycle import Client
from benchmarks.bench_reindex import generate_synthetic_project


def archive(path, value):
    with gzip.open(path, 'wt') as stream:
        json.dump(value, stream, sort_keys=True)
        stream.write('\n')
    return str(path)


def assert_surface(full, models, prefix, manager, output_kind):
    surface = full['surfaceIndex']
    assert len(surface) == models
    for number in range(models):
        label = f'app{number // 50}.Model{number}'
        for field in range(15):
            assert f'field_{field}' in surface[label]['instance']
        for relation in range(2):
            target = (number + relation + 1) % models
            assert surface[label]['instance'][f'fk_{relation}'][1] == f'app{target // 50}.Model{target}'
    target = surface['app0.Model0']
    for kind in ('instance', 'model_class', 'manager', 'queryset', 'related_manager'):
        names = (prefix + '_instance', prefix + '_class') if kind in ('instance', 'model_class') else (prefix + '_query',)
        for name in names:
            assert target[kind][name][1] == 'app0.Model0', (kind, name)
    assert manager in target['model_class']
    catalogue = full['lookupCatalog']
    field_type = catalogue['types'][catalogue['fields']['app0.Model0']['field_0']]
    assert catalogue['types'][field_type['transforms']['field_size']]['fieldKind'] == output_kind
    health = full['health']
    assert health['runtime']['modelCount'] == models
    assert len(health['runtime']['modelPreview']) == min(10, models)
    preview = next(model for model in health['runtime']['modelPreview'] if model['label'] == 'app0.Model0')
    assert preview['managerNames'] == ['objects', manager], preview
    assert health['semanticGraph']['runtimeModelCount'] == models


def check_members(client, prefix, manager):
    rows = []
    for kind in ('instance', 'model_class', 'manager', 'queryset', 'related_manager'):
        name = prefix + ('_instance' if kind in ('instance', 'model_class') else '_query')
        result, elapsed = client.request('resolveOrmMember', {'modelLabel': 'app0.Model0',
            'receiverKind': kind, 'name': name})
        assert result['resolved'] and result['item']['returnModelLabel'] == 'app0.Model0', result
        rows.append({'receiverKind': kind, 'rpcMs': elapsed, 'name': name})
    for kind in ('manager', 'queryset', 'related_manager'):
        result, elapsed = client.request('resolveOrmMemberChain', {'modelLabel': 'app0.Model0',
            'receiverKind': kind, 'managerName': manager, 'chain': [prefix + '_query']})
        assert result['resolved'] and result['receiverKind'] == 'queryset', result
        rows.append({'receiverKind': kind, 'managerName': manager, 'rpcMs': elapsed})
    return rows


def create_fixture(root, models, file_count, *, empty_custom_app=False):
    files = generate_synthetic_project(root, models)
    apps = sorted({file.parent.name for file in files})
    (root / 'bench_lookups.py').write_text('from django.db import models\n'
        'class FieldSize(models.Transform):\n    lookup_name="field_size"\n'
        '    @property\n    def output_field(self):\n'
        '        return models.DateField() if self.lhs.output_field.max_length==10 else models.CharField()\n')
    for app in apps:
        imports = ['from bench_lookups import FieldSize']
        for file in files:
            if file.parent.name != app:
                continue
            name = f'Model{int(file.stem.split("_")[-1])}'
            imports += [f'from .{file.stem} import {name}',
                f'{name}._meta.get_field("field_0").register_lookup(FieldSize)']
        (root / app / 'models.py').write_text('\n'.join(imports) + '\n')
    if empty_custom_app:
        package = root / 'lateapp'
        package.mkdir()
        (package / '__init__.py').write_text('')
        (package / 'apps.py').write_text('from django.apps import AppConfig\n'
            'class LateConfig(AppConfig):\n    name="lateapp"\n    label="late_custom"\n')
        (package / 'models.py').write_text('')
        apps.append('lateapp')
    (root / 'bench_settings.py').write_text(f'INSTALLED_APPS={apps!r}\nSECRET_KEY="async-member"\n'
        'DEFAULT_AUTO_FIELD="django.db.models.BigAutoField"\n'
        'DATABASES={"default":{"ENGINE":"django.db.backends.sqlite3","NAME":":memory:"}}\n')
    helper = root / 'bench_runtime.py'
    helper.write_text('from django.db import models\n'
        'class ProjectQuerySet(models.QuerySet):\n    pass\n'
        'def attached_query(self) -> models.QuerySet:\n    return self\n'
        'ProjectQuerySet.attached_query=attached_query\n'
        'class ProjectManager(models.Manager.from_queryset(ProjectQuerySet)):\n    pass\n')
    source = files[0]
    source.write_text(source.read_text().replace('from django.db import models',
        'from django.db import models\nfrom bench_runtime import ProjectManager').replace(
            'class Model0(models.Model):', 'class Model0(models.Model):\n'
            '    objects = ProjectManager()\n    special = ProjectManager()')
        + '\ndef attached_instance(self) -> Model0:\n    return self\n'
        'def attached_class(cls) -> Model0:\n    return cls()\n'
        'Model0.attached_instance=attached_instance\nModel0.attached_class=classmethod(attached_class)\n')
    bytecode = {Path(py_compile.compile(str(path), doraise=True)): None for path in (source, helper)}
    bytecode = {path: path.read_bytes() for path in bytecode}
    generated = len(list(root.rglob('*.py')))
    assert file_count >= generated
    padding = root / 'helpers'
    padding.mkdir()
    for number in range(file_count - generated):
        (padding / f'helper_{number}.py').write_text(f'value={number}\n')
    assert len(list(root.rglob('*.py'))) == file_count
    return source, helper, bytecode


def run(models, file_count, output_dir, worker_module='django_orm_intellisense'):
    output_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    with tempfile.TemporaryDirectory(prefix='djls-large-async-member-') as temporary:
        root = Path(temporary).resolve() / 'project'
        root.mkdir()
        cache = root.parent / 'cache'
        source, helper, bytecode = create_fixture(root, models, file_count)
        for lifecycle in ('cold', 'cached'):
            client = Client(root, cache, request_timeout_seconds=120, keep_log=True, worker_module=worker_module)
            try:
                initialized, initialize_ms = client.request('initialize', {'workspaceRoot': str(root),
                    'settingsModule': 'bench_settings', 'deferRuntime': False})
                assert initialized['health']['runtime']['bootstrapStatus'] == 'ready'
                full = initialized if len(initialized.get('surfaceIndex') or {}) == models else client.wait_for_notification(
                    'surfaceIndexChanged', lambda value: len(value.get('surfaceIndex') or {}) == models, 120)
                ready_ms = (time.perf_counter() - client.started) * 1000
                assert_surface(full, models, 'attached', 'special', 'CharField')
                custom, lookup_ms = client.request('resolveLookupPath', {'baseModelLabel': 'app0.Model0',
                    'value': 'field_0__field_size__exact', 'method': 'filter'})
                assert custom['resolved'], custom
                deadline = time.perf_counter() + 30
                while 'runtime_field_registry(background) ready' not in Path(client.log.name).read_text():
                    assert time.perf_counter() < deadline, 'Parent runtime registry did not finish'
                    time.sleep(0.01)
                both_ready_ms = (time.perf_counter() - client.started) * 1000
                member_checks = check_members(client, 'attached', 'special')
                rows.append({'phase': lifecycle, 'initializeRpcMs': initialize_ms,
                    'fullSurfaceReadyFromStartMs': ready_ms, 'surfaceAndParentRegistryReadyFromStartMs': both_ready_ms,
                    'firstPostReadyCustomLookupRpcMs': lookup_ms, 'memberQueries': member_checks,
                    'completeModelsScalarFkAndCustomMetadata': True,
                    'payload': archive(output_dir / f'{lifecycle}-payload.json.gz', full)})
                if lifecycle == 'cached':
                    previous, previous_manager, previous_length = 'attached', 'special', '255'
                    for prefix, manager, length, output_kind in (
                            ('modified', 'another', '10 ', 'DateField'), ('replaced', 'revised', '255', 'CharField')):
                        for path in (source, helper):
                            stamp = path.stat()
                            text = path.read_text().replace(previous + '_', prefix + '_')
                            text = text.replace(previous_manager + ' = ProjectManager()', manager + ' = ProjectManager()')
                            text = text.replace('field_0 = models.CharField(max_length=' + previous_length + ')',
                                'field_0 = models.CharField(max_length=' + length + ')')
                            assert len(text.encode()) == stamp.st_size
                            path.write_text(text)
                            os.utime(path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
                        edit_started = time.perf_counter()
                        replies, edit_times = [], []
                        for path in (source, helper):
                            reply, elapsed = client.request('reindexFile', {'filePath': str(path)})
                            assert reply['runtimeMembersPending'] is True
                            pending = reply['surfaceIndexDelta']['app0.Model0']
                            for kind in ('instance', 'model_class', 'manager', 'queryset', 'related_manager'):
                                for suffix in ('_instance', '_class', '_query'):
                                    assert previous + suffix not in pending.get(kind, {})
                            replies.append(reply)
                            edit_times.append({'file': path.name, 'rpcMs': elapsed})
                        def current(value):
                            entry = (value.get('surfaceIndex') or {}).get('app0.Model0') or {}
                            return value.get('runtimeMembersPending') is False and prefix + '_query' in entry.get('queryset', {})
                        full = client.wait_for_notification('surfaceIndexChanged', current, 120)
                        refreshed_ms = (time.perf_counter() - edit_started) * 1000
                        assert_surface(full, models, prefix, manager, output_kind)
                        assert previous_manager not in full['surfaceIndex']['app0.Model0']['model_class']
                        for kind in ('instance', 'model_class', 'manager', 'queryset', 'related_manager'):
                            for suffix in ('_instance', '_class', '_query'):
                                assert previous + suffix not in full['surfaceIndex']['app0.Model0'].get(kind, {})
                        member_checks = check_members(client, prefix, manager)
                        custom, lookup_ms = client.request('resolveLookupPath', {'baseModelLabel': 'app0.Model0',
                            'value': 'field_0__field_size__exact', 'method': 'filter'})
                        assert custom['resolved'], custom
                        for path, original in bytecode.items():
                            assert path.read_bytes() == original
                        rows.append({'phase': prefix, 'editRpcTimes': edit_times, 'asyncReadyFromFirstEditMs': refreshed_ms,
                            'memberQueries': member_checks, 'postRefreshCustomLookupRpcMs': lookup_ms,
                            'sameSizeRestoredMtimeAndStalePycPreserved': True,
                            'completeModelsScalarFkAndCustomMetadata': True,
                            'pendingPayload': archive(output_dir / f'{prefix}-pending.json.gz', replies),
                            'payload': archive(output_dir / f'{prefix}-ready.json.gz', full)})
                        previous, previous_manager, previous_length = prefix, manager, length
            finally:
                client.close()
                log = output_dir / f'{lifecycle}-daemon.log'
                log.write_bytes(Path(client.log.name).read_bytes())
            assert client.process.returncode == 0
            for row in rows:
                if 'daemonExitCode' not in row:
                    row.update(daemonExitCode=client.process.returncode, daemonLog=str(log))
    return {'models': models, 'pythonFiles': file_count, 'workerModule': worker_module, 'rows': rows,
        'scope': 'Sequential actual cold/cached CLI daemons; two pairs of model/helper saves in the cached daemon. '
            'All models, scalar fields, foreign keys, parameterized transform outputs and all five runtime receivers '
            'checked; named manager chains, restored mtime, equal file size and retained original pyc included. '
            'Uncontrolled observations, no paired speedup, stable SLO/editor or aggregate-memory proof.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', type=int, default=500)
    parser.add_argument('--files', type=int, default=5000)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--worker-module', default='django_orm_intellisense')
    args = parser.parse_args()
    print(json.dumps(run(args.models, args.files, args.output_dir, args.worker_module), indent=2))
