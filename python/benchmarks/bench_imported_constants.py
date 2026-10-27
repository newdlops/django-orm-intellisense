"""Measure imported literal helper edits through the complete ready-runtime RPC."""
from __future__ import annotations
import argparse
import json
import sys
import tempfile
from pathlib import Path

from benchmarks.bench_daemon_lifecycle import Client
from benchmarks.bench_reindex import generate_synthetic_project
from benchmarks.bench_ready_runtime import summarize
from django_orm_intellisense.cache.store import CACHE_SCHEMA_VERSION
from django_orm_intellisense.runtime.lookup_catalog import apply_model_catalog_delta


def run(count, file_count, repetitions, mixed_containers=False, profile=None):
    with tempfile.TemporaryDirectory(prefix='djls-imported-constant-rpc-') as temporary:
        folder = Path(temporary)
        root = folder / 'project'
        root.mkdir()
        files = generate_synthetic_project(root, count)
        helpers = []
        sources = []
        def helper_source(value):
            return f'FIELD_SIZE = {value}\n' + ('CODE = "a"\nLABEL = "Alpha"\n' if mixed_containers else '')
        for number, path in enumerate(files):
            helper = path.with_name(f'options_{number}.py')
            helper.write_text(helper_source(255))
            source = path.read_text().replace('max_length=255', 'max_length=FIELD_SIZE')
            source = source.replace('from django.db import models\n',
                f'from django.db import models\nfrom .options_{number} import FIELD_SIZE' +
                (', CODE, LABEL' if mixed_containers else '') + '\n')
            if mixed_containers:
                source = source.replace('max_length=FIELD_SIZE)',
                    'max_length=FIELD_SIZE, choices=[(CODE, LABEL), ("b", "Beta")])')
            path.write_text(source)
            helpers.append(helper)
            sources.append(source)
        apps = sorted({path.parent.name for path in files})
        (root / 'bench_settings.py').write_text(f'INSTALLED_APPS = {apps!r}\nSECRET_KEY = "benchmark"\n'
            'DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}}\n')
        (root / 'bench_lookups.py').write_text('from django.db import models\n'
            'class FieldSize(models.Transform):\n    lookup_name = "field_size"\n'
            '    @property\n    def output_field(self):\n'
            '        return models.DateField() if self.lhs.output_field.max_length == 10 else models.CharField()\n')
        for app in apps:
            lines = ['from bench_lookups import FieldSize']
            for number, path in enumerate(files):
                if path.parent.name == app:
                    lines += [f'from .{path.stem} import Model{number}',
                              f'Model{number}._meta.get_field("field_0").register_lookup(FieldSize)']
            (root / app / 'models.py').write_text('\n'.join(lines) + '\n')
        current_files = len(list(root.rglob('*.py')))
        if file_count < current_files:
            raise ValueError(f'--files must be at least {current_files}')
        padding = root / 'helpers'
        padding.mkdir()
        for number in range(file_count - current_files):
            (padding / f'helper_{number}.py').write_text(f'value = {number}\n')
        client = Client(root, folder / 'cache', profile)
        try:
            reply, initialize_ms = client.request('initialize',
                {'workspaceRoot': str(root), 'settingsModule': 'bench_settings', 'deferRuntime': False})
            assert len(reply['modelNames']) == count
            catalog = reply['lookupCatalog']
            samples, repeated, delta_bytes = [], [], []
            def edit(number, value):
                nonlocal catalog
                helpers[number].write_text(helper_source(value))
                reply, elapsed = client.request('reindexFile', {'filePath': str(helpers[number])})
                delta = reply.get('lookupCatalogDelta') or {}
                label = f'{files[number].parent.name}.Model{number}'
                assert set(delta) == {label}, set(delta)
                assert 'lookupCatalog' not in reply
                catalog = apply_model_catalog_delta(catalog, delta)
                descriptor = catalog['types'][catalog['fields'][label]['field_0']]
                output = catalog['types'][descriptor['transforms']['field_size']]
                assert output['fieldKind'] == ('DateField' if value == 10 else 'CharField'), output
                assert files[number].read_text() == sources[number], 'Model declaration changed'
                delta_bytes.append(len(json.dumps(delta).encode()))
                return elapsed
            for number in range(count):
                samples.append(edit(number, 10))
            type_count = len(catalog['types'])
            for revision in range(repetitions):
                repeated.append(edit(0, 255 if revision % 2 == 0 else 10))
            if repetitions % 2:
                edit(0, 10)
            assert len(catalog['types']) == type_count
            for number in (0, count - 1):
                result, _ = client.request('resolveLookupPath', {
                    'baseModelLabel': f'{files[number].parent.name}.Model{number}',
                    'value': 'field_0__field_size__year__gte', 'method': 'filter'})
                assert result['resolved'] and result['terminalType']['outputFieldKind'] == 'IntegerField', result
            def current_snapshot(payload):
                published = payload.get('lookupCatalog') or {}
                try:
                    for number, path in enumerate(files):
                        label = f'{path.parent.name}.Model{number}'
                        descriptor = published['types'][published['fields'][label]['field_0']]
                        if published['types'][descriptor['transforms']['field_size']]['fieldKind'] != 'DateField':
                            return False
                    return len(payload.get('surfaceIndex') or {}) == count
                except KeyError:
                    return False
            client.wait_for_notification('surfaceIndexChanged', current_snapshot)
            log = Path(client.log.name).read_text()
            return {'cacheSchemaVersion': CACHE_SCHEMA_VERSION, 'models': count, 'pythonFiles': file_count,
                    'mixedImportedContainers': mixed_containers,
                    'python': sys.version, 'initializeReadyRpcMs': initialize_ms,
                    'allHelperEdits': summarize(samples), 'repeatedHelperEdits': summarize(repeated),
                    'maxCatalogDeltaBytes': max(delta_bytes), 'retentionStable': True,
                    'modelDeclarationsUnchanged': True, 'firstAndLastLookupResolved': True,
                    'currentFullNotificationVerified': True,
                    'allEditRpcBudgetsPassed': all(value < 20 for value in samples + repeated),
                    'surfaceAdoptionTimings': [json.loads(line.removeprefix('[surface:adopt] '))
                        for line in log.splitlines() if line.startswith('[surface:adopt] ')],
                    'ipcPhaseTimings': [json.loads(line.removeprefix('[ipc:profile] '))
                        for line in log.splitlines() if line.startswith('[ipc:profile] ')],
                    'reindexPhaseTimings': [json.loads(line.removeprefix('[reindex:phases] '))
                        for line in log.splitlines() if line.startswith('[reindex:phases] ')],
                    'scope': 'Configured ready-runtime full daemon helper-edit RPC including commit/serialization/compression/transport; real installed Django, no SQL or editor rendering.'}
        finally:
            client.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', type=int, default=100)
    parser.add_argument('--files', type=int, default=1000)
    parser.add_argument('--repetitions', type=int, default=30)
    parser.add_argument('--mixed-containers', action='store_true')
    parser.add_argument('--profile', type=Path)
    args = parser.parse_args()
    if args.models < 1 or args.repetitions < 1:
        parser.error('Models and repetitions must be positive')
    print(json.dumps(run(args.models, args.files, args.repetitions, args.mixed_containers, args.profile), indent=2))
