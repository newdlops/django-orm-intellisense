"""Measure edit RPCs after Django setup, including lookup catalogue deltas."""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from benchmarks.bench_daemon_lifecycle import Client
from benchmarks.bench_reindex import generate_synthetic_project
from django_orm_intellisense.cache.store import CACHE_SCHEMA_VERSION
from django_orm_intellisense.runtime.lookup_catalog import apply_model_catalog_delta


def run(model_count: int, file_count: int | None, repetitions: int, profile: Path | None,
        local_constants: bool = False, request_timeout_seconds: float = 30):
    with tempfile.TemporaryDirectory(prefix='djls-ready-runtime-') as temporary:
        folder = Path(temporary)
        root = folder / 'project'
        root.mkdir()
        files = generate_synthetic_project(root, model_count)
        if local_constants:
            for path in files:
                source = path.read_text().replace('max_length=255', 'max_length=FIELD_MAX_LENGTH')
                path.write_text(source.replace('from django.db import models\n',
                    'from django.db import models\nFIELD_MAX_LENGTH = 255\n'))
        length_option = 'FIELD_MAX_LENGTH = ' if local_constants else 'max_length='
        apps = sorted({path.parent.name for path in files})
        (root / 'bench_settings.py').write_text(
            f'INSTALLED_APPS = {apps!r}\nSECRET_KEY = "benchmark"\n'
            'DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"\n'
            'DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}}\n')
        (root / 'bench_lookups.py').write_text(
            'from django.db import models\n'
            'class FieldSize(models.Transform):\n'
            '    lookup_name = "field_size"\n'
            '    @property\n'
            '    def output_field(self):\n'
            '        return models.DateField() if self.lhs.output_field.max_length == 10 else models.CharField()\n')
        for app in apps:
            lines = ['from bench_lookups import FieldSize']
            for path in files:
                if path.parent.name == app:
                    name = f'Model{int(path.stem.split("_")[-1])}'
                    lines += [f'from .{path.stem} import {name}',
                              f'{name}._meta.get_field("field_0").register_lookup(FieldSize)']
            (root / app / 'models.py').write_text('\n'.join(lines) + '\n')
        generated = len(list(root.rglob('*.py')))
        if file_count is not None:
            if file_count < generated:
                raise ValueError(f'--files must be at least {generated}')
            padding = root / 'bench_helpers'
            padding.mkdir()
            for number in range(file_count - generated):
                (padding / f'helper_{number}.py').write_text(f'value = {number}\n')
        client = Client(root, folder / 'cache', profile, request_timeout_seconds)
        try:
            result, initialize_ms = client.request('initialize', {
                'workspaceRoot': str(root), 'settingsModule': 'bench_settings', 'deferRuntime': False})
            assert len(result['modelNames']) == model_count, result['health']
            catalog = result['lookupCatalog']
            assert len(catalog.get('fields', {})) == model_count, result['health']
            samples = []
            delta_sizes = []
            for number, path in enumerate(files):
                label = f'{path.parent.name}.Model{number}'
                path.write_text(path.read_text().replace(f'{length_option}255', f'{length_option}10'))
                reply, elapsed = client.request('reindexFile', {'filePath': str(path)})
                delta = reply.get('lookupCatalogDelta') or {}
                assert set(delta) == {label}, f'Unexpected catalogue delta: {set(delta)}'
                assert 'lookupCatalog' not in reply, 'Edit resent full lookup catalogue'
                catalog = apply_model_catalog_delta(catalog, delta)
                descriptor = catalog['types'][catalog['fields'][label]['field_0']]
                output = catalog['types'][descriptor['transforms']['field_size']]
                assert output['fieldKind'] == 'DateField', output
                samples.append(elapsed)
                delta_sizes.append(len(json.dumps(delta).encode()))
            type_count = len(catalog['types'])
            repeated = []
            first = files[0]
            for revision in range(repetitions):
                length = 255 if revision % 2 == 0 else 10
                first.write_text(first.read_text().replace(f'{length_option}{10 if length == 255 else 255}', f'{length_option}{length}'))
                reply, elapsed = client.request('reindexFile', {'filePath': str(first)})
                catalog = apply_model_catalog_delta(catalog, reply['lookupCatalogDelta'])
                expected = 'CharField' if length == 255 else 'DateField'
                descriptor = catalog['types'][catalog['fields']['app0.Model0']['field_0']]
                assert catalog['types'][descriptor['transforms']['field_size']]['fieldKind'] == expected
                repeated.append(elapsed)
            # Compare the same final declaration, even for an odd number of
            # repetitions; changing its capabilities can change chunk size.
            if repetitions % 2:
                first.write_text(first.read_text().replace(f'{length_option}255', f'{length_option}10'))
                reply, _ = client.request('reindexFile', {'filePath': str(first)})
                catalog = apply_model_catalog_delta(catalog, reply['lookupCatalogDelta'])
            assert len(catalog['types']) == type_count, 'Edit history retained old descriptors'
            for label in ('app0.Model0', f'{files[-1].parent.name}.Model{model_count - 1}'):
                value, _ = client.request('resolveLookupPath', {
                    'baseModelLabel': label, 'value': 'field_0__field_size__year__gte', 'method': 'filter'})
                assert value['resolved'], value
                assert value['terminalType']['outputFieldKind'] == 'IntegerField', value
            def current_snapshot(payload):
                published = payload.get('lookupCatalog') or {}
                try:
                    for number, path in enumerate(files):
                        label = f'{path.parent.name}.Model{number}'
                        descriptor = published['types'][published['fields'][label]['field_0']]
                        if published['types'][descriptor['transforms']['field_size']]['fieldKind'] != 'DateField':
                            return False
                    return len(payload.get('surfaceIndex') or {}) == model_count
                except KeyError:
                    return False
            client.wait_for_notification('surfaceIndexChanged', current_snapshot)
            log = Path(client.log.name).read_text()
            return {
                'timestamp': datetime.now(timezone.utc).isoformat(), 'python': sys.version,
                'cacheSchemaVersion': CACHE_SCHEMA_VERSION,
                'requestTimeoutSeconds': request_timeout_seconds,
                'initializeExceedsDefault30sDeadline': initialize_ms >= 30000,
                'declarationMode': 'module-local constant' if local_constants else 'literal constructor option',
                'models': model_count, 'pythonFiles': len(list(root.rglob('*.py'))),
                'fieldsPerModel': 15, 'foreignKeysPerModel': 2,
                'initializeReadyRpcMs': initialize_ms,
                'allModelEdits': summarize(samples), 'repeatedFirstModelEdits': summarize(repeated),
                'maxCatalogDeltaBytes': max(delta_sizes), 'catalogTypesAfterAllModelEdits': type_count,
                'retentionStableAfterRepeatedEdits': True, 'lookupResolvedForFirstAndLastModels': True,
                'currentFullNotificationVerified': True,
                'firstAndLastLookupPath': 'field_0__field_size__year__gte',
                'firstAndLastLookupOutputKind': 'IntegerField',
                'allEditRpcBudgetsPassed': all(value < 20 for value in samples + repeated),
                'scope': 'Full ready-runtime daemon RPC including commit, serialization, compression and transport; no SQL execution or editor rendering',
                'serverTimings': [line for line in log.splitlines() if line.startswith('[initialize]')],
                'surfaceAdoptionTimings': [json.loads(line.removeprefix('[surface:adopt] '))
                    for line in log.splitlines() if line.startswith('[surface:adopt] ')],
                'ipcPhaseTimings': [json.loads(line.removeprefix('[ipc:profile] '))
                    for line in log.splitlines() if line.startswith('[ipc:profile] ')],
                'reindexPhaseTimings': [json.loads(line.removeprefix('[reindex:phases] '))
                    for line in log.splitlines() if line.startswith('[reindex:phases] ')],
            }
        finally:
            client.close()


def summarize(samples: list[float]):
    ordered = sorted(samples)
    return {'count': len(samples), 'p50Ms': statistics.median(samples),
            'p95Ms': ordered[min(len(samples) - 1, int(len(samples) * .95))],
            'maxMs': ordered[-1], 'over20Ms': sum(value >= 20 for value in samples)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', type=int, default=1000)
    parser.add_argument('--files', type=int)
    parser.add_argument('--repetitions', type=int, default=100)
    parser.add_argument('--profile', type=Path)
    parser.add_argument('--local-constants', action='store_true')
    parser.add_argument('--request-timeout', type=float, default=30,
        help='Diagnostic request wait in seconds; budgets remain unchanged (default: 30)')
    args = parser.parse_args()
    if args.models < 1 or args.repetitions < 1:
        parser.error('Model count and repetitions must be positive')
    if args.request_timeout <= 0:
        parser.error('Request timeout must be positive')
    print(json.dumps(run(args.models, args.files, args.repetitions, args.profile,
                         args.local_constants, args.request_timeout), indent=2))
