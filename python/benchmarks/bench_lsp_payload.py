"""Export actual configured daemon metadata for separate Node LSP profiling."""
import argparse
import hashlib
import json
import tempfile
import time
from pathlib import Path

from benchmarks.bench_daemon_lifecycle import Client
from benchmarks.bench_reindex import generate_synthetic_project


def run(models, file_count, output, delta_output=None, worker_module='django_orm_intellisense'):
    with tempfile.TemporaryDirectory(prefix='djls-lsp-payload-') as temporary:
        root = Path(temporary).resolve() / 'project'
        root.mkdir()
        files = generate_synthetic_project(root, models)
        apps = sorted({file.parent.name for file in files})
        (root / 'bench_settings.py').write_text(
            f'INSTALLED_APPS = {apps!r}\nSECRET_KEY = "heap-benchmark"\n'
            'DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"\n'
            'DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}}\n')
        (root / 'bench_lookups.py').write_text(
            'from django.db import models\n'
            'class FieldSize(models.Transform):\n    lookup_name = "field_size"\n'
            '    @property\n    def output_field(self):\n'
            '        return models.DateField() if self.lhs.output_field.max_length == 10 else models.CharField()\n')
        for app in apps:
            lines = ['from bench_lookups import FieldSize']
            for file in files:
                if file.parent.name == app:
                    name = f'Model{int(file.stem.split("_")[-1])}'
                    lines += [f'from .{file.stem} import {name}',
                              f'{name}._meta.get_field("field_0").register_lookup(FieldSize)']
            (root / app / 'models.py').write_text('\n'.join(lines) + '\n')
        generated = len(list(root.rglob('*.py')))
        assert generated <= file_count
        helpers = root / 'helpers'
        helpers.mkdir()
        for number in range(file_count - generated):
            (helpers / f'helper_{number}.py').write_text(f'value = {number}\n')
        assert len(list(root.rglob('*.py'))) == file_count
        client = Client(root, root.parent / 'cache', request_timeout_seconds=120, keep_log=True,
            worker_module=worker_module)
        try:
            initialized, elapsed = client.request('initialize',
                {'workspaceRoot': str(root), 'settingsModule': 'bench_settings', 'deferRuntime': False})
            assert len(initialized['modelNames']) == models
            assert initialized['health']['runtime']['bootstrapStatus'] == 'ready'
            assert len(initialized['lookupCatalog']['fields']) == models
            client.request('resolveOrmMember', {'modelLabel': 'app0.Model0',
                'receiverKind': 'instance', 'name': 'field_0'})
            full = client.wait_for_notification('surfaceIndexChanged',
                lambda params: len(params.get('surfaceIndex') or {}) == models, timeout_seconds=120)
            full_surface_ready_ms = (time.perf_counter() - client.started) * 1000
            keys = ['surfaceIndex', 'surfaceFingerprints', 'modelNames', 'customLookups',
                    'lookupCatalog', 'customLookupsFingerprint', 'staticFallback', 'staticFallbackFingerprint']
            payload = {key: full[key] for key in keys if key in full}
            assert len(payload['surfaceIndex']) == models
            assert len(payload['lookupCatalog']['fields']) == models
            for number in range(models):
                label = f'app{number // 50}.Model{number}'
                for field in range(15):
                    entry = payload['surfaceIndex'][label]['instance'][f'field_{field}']
                    assert entry[0] == 'scalar' and entry[2] == 'field'
                for relation in range(2):
                    target = (number + relation + 1) % models
                    assert payload['surfaceIndex'][label]['instance'][f'fk_{relation}'][1] == f'app{target // 50}.Model{target}'
            encoded = json.dumps(payload).encode()
            output.write_bytes(encoded)
            delta_report = None
            if delta_output:
                deltas = []
                first = files[0]
                for revision in range(20):
                    length = 10 if revision % 2 == 0 else 255
                    old = 255 if length == 10 else 10
                    source = first.read_text()
                    needle = f'field_0 = models.CharField(max_length={old})'
                    assert needle in source
                    first.write_text(source.replace(needle, f'field_0 = models.CharField(max_length={length})'))
                    reply, rpc_ms = client.request('reindexFile', {'filePath': str(first)})
                    assert set(reply['lookupCatalogDelta']) == {'app0.Model0'}
                    chunk = reply['lookupCatalogDelta']['app0.Model0']
                    descriptor = chunk['types'][chunk['fields']['app0.Model0']['field_0']]
                    expected = 'DateField' if length == 10 else 'CharField'
                    assert chunk['types'][descriptor['transforms']['field_size']]['fieldKind'] == expected
                    resolved, _ = client.request('resolveLookupPath', {'baseModelLabel': 'app0.Model0',
                        'value': 'field_0__field_size__year__gte' if length == 10 else 'field_0__field_size__icontains',
                        'method': 'filter'})
                    assert resolved['resolved'], resolved
                    allowed = ['surfaceIndexDelta', 'surfaceFingerprints', 'addedLabels', 'changedLabels',
                        'removedLabels', 'lookupCatalogDelta', 'staticFallback', 'staticFallbackDelta',
                        'removedStaticFallbackLabels', 'staticFallbackFingerprint']
                    deltas.append({'expectedOutputKind': expected, 'pythonReindexRpcMs': rpc_ms,
                        'params': {key: reply[key] for key in allowed if key in reply}})
                delta_encoded = json.dumps(deltas).encode()
                delta_output.write_bytes(delta_encoded)
                delta_report = {'path': str(delta_output), 'bytes': len(delta_encoded),
                    'sha256': hashlib.sha256(delta_encoded).hexdigest(), 'revisions': len(deltas),
                    'scope': 'Actual configured ready daemon reindex replies after20 same-kind CharField option edits; dynamic transform output alternates DateField/CharField, resolved after every save. Full source/daemon20ms budget not inferred from Node replay.'}
            log = output.with_suffix('.daemon.log')
            log.write_text(Path(client.log.name).read_text())
            return {'models': models, 'pythonFiles': file_count, 'runtimeReady': True,
                    'workerModule': worker_module,
                    'surfaceModels': len(payload['surfaceIndex']),
                    'catalogFieldModels': len(payload['lookupCatalog']['fields']),
                    'catalogTypes': len(payload['lookupCatalog']['types']),
                    'payloadBytes': len(encoded), 'sha256': hashlib.sha256(encoded).hexdigest(),
                    'payload': str(output), 'daemonLog': str(log), 'initializeRpcMs': elapsed,
                    'fullSurfaceReadyFromClientStartMs': full_surface_ready_ms,
                    'saveDeltas': delta_report,
                    'scope': 'Actual configured Django6 daemon full surface and complete lookup catalogue, including instance-specific dynamic transform. Every scalar and FK model entry retained; runtime ready. Synthetic 10-percent model source fixture. Payload export timing not a Node-memory/ordinary startup comparison.'}
        finally:
            client.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', type=int, default=100)
    parser.add_argument('--files', type=int, default=1000)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--delta-output', type=Path)
    parser.add_argument('--worker-module', default='django_orm_intellisense')
    args = parser.parse_args()
    print(json.dumps(run(args.models, args.files, args.output, args.delta_output, args.worker_module), indent=2))
