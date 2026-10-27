"""Configured cold/cached/current-source startup with diagnostic phase costs."""
import argparse
import hashlib
import json
import tempfile
import time
from pathlib import Path

from benchmarks.bench_daemon_lifecycle import Client
from benchmarks.bench_reindex import generate_synthetic_project


def run(models, file_count, output_dir, worker_module, interleaved_rpcs=0):
    def wait_for_log_marker(log_path, marker, timeout=15):
        deadline = time.perf_counter() + timeout
        while time.perf_counter() < deadline:
            try:
                if marker in log_path.read_text():
                    return True
            except OSError:
                pass
            time.sleep(0.001)
        return False

    with tempfile.TemporaryDirectory(prefix='djls-ready-startup-') as temporary:
        root = Path(temporary).resolve() / 'project'
        root.mkdir()
        files = generate_synthetic_project(root, models)
        apps = sorted({file.parent.name for file in files})
        (root / 'bench_settings.py').write_text(f'INSTALLED_APPS = {apps!r}\nSECRET_KEY="startup"\n'
            'DEFAULT_AUTO_FIELD="django.db.models.BigAutoField"\n'
            'DATABASES={"default":{"ENGINE":"django.db.backends.sqlite3","NAME":":memory:"}}\n')
        (root / 'bench_lookups.py').write_text('from django.db import models\n'
            'class FieldSize(models.Transform):\n    lookup_name="field_size"\n'
            '    @property\n    def output_field(self):\n'
            '        return models.DateField() if self.lhs.output_field.max_length==10 else models.CharField()\n')
        for app in apps:
            imports = ['from bench_lookups import FieldSize']
            for file in files:
                if file.parent.name != app: continue
                name = f'Model{int(file.stem.split("_")[-1])}'
                imports += [f'from .{file.stem} import {name}', f'{name}._meta.get_field("field_0").register_lookup(FieldSize)']
            (root / app / 'models.py').write_text('\n'.join(imports) + '\n')
        generated = len(list(root.rglob('*.py')))
        helpers = root / 'helpers'
        helpers.mkdir()
        for number in range(file_count - generated):
            (helpers / f'helper_{number}.py').write_text(f'value={number}\n')
        assert len(list(root.rglob('*.py'))) == file_count
        output_dir.mkdir(parents=True, exist_ok=True)
        cache = root.parent / 'cache'
        rows = []
        for lifecycle in ['cold', 'cached', 'same_size_source_edit']:
            if lifecycle == 'same_size_source_edit':
                text = files[0].read_text()
                old = 'field_0 = models.CharField(max_length=255)'
                new = 'field_0 = models.CharField(max_length=10 )'
                assert old in text and len(old) == len(new)
                files[0].write_text(text.replace(old, new))
            client = Client(root, cache, request_timeout_seconds=120, keep_log=True, worker_module=worker_module)
            try:
                initialized, rpc_ms = client.request('initialize', {'workspaceRoot': str(root),
                    'settingsModule': 'bench_settings', 'deferRuntime': False})
                assert initialized['health']['runtime']['bootstrapStatus'] == 'ready'
                assert len(initialized['modelNames']) == models
                assert len(initialized['lookupCatalog']['fields']) == models
                label = 'app0.Model0'
                initial_type = initialized['lookupCatalog']['types'][initialized['lookupCatalog']['fields'][label]['field_0']]
                expected = 'DateField' if lifecycle == 'same_size_source_edit' else 'CharField'
                assert initial_type['fieldKind'] == 'CharField'
                assert initialized['lookupCatalog']['types'][initial_type['transforms']['field_size']]['fieldKind'] == expected
                client.request('resolveOrmMember', {'modelLabel': label, 'receiverKind': 'instance', 'name': 'field_0'})
                interleaved_rpc_ms = []
                setup_rpc_ms = []
                surface_build_rpc_ms = []
                log_path = Path(client.log.name)
                surface_request_started = False
                surface_build_started = False

                def issue_rpcs(count, output):
                    for _ in range(count):
                        _, elapsed_ms = client.request('resolveOrmMember', {
                            'modelLabel': label, 'receiverKind': 'instance', 'name': 'field_0'})
                        output.append(elapsed_ms)
                        interleaved_rpc_ms.append(elapsed_ms)

                if interleaved_rpcs and lifecycle != 'cached':
                    surface_request_started = wait_for_log_marker(log_path,
                        '[surface-load:phase-start] request_surface_index_load')
                    if surface_request_started:
                        # Run an initial burst while workspace/member preparation is underway.
                        time.sleep(0.01)
                        setup_count = min(25, interleaved_rpcs)
                        issue_rpcs(setup_count, setup_rpc_ms)
                        # Distinguish actual surface generation from its earlier setup/serialization.
                        surface_build_started = wait_for_log_marker(log_path,
                            '[surface-worker:phase-start] build_surface_index_cache')
                        if surface_build_started:
                            time.sleep(0.005)
                            issue_rpcs(interleaved_rpcs - setup_count, surface_build_rpc_ms)
                        else:
                            issue_rpcs(interleaved_rpcs - setup_count, setup_rpc_ms)
                    else:
                        issue_rpcs(interleaved_rpcs, setup_rpc_ms)
                elif interleaved_rpcs:
                    issue_rpcs(interleaved_rpcs, setup_rpc_ms)
                initialized_surface = initialized.get('surfaceIndex')
                if isinstance(initialized_surface, dict) and len(initialized_surface) == models:
                    # Current cached startup can return the complete warm surface
                    # inline. Waiting unconditionally for a later notification
                    # timed out even though the full state was already ready.
                    full = initialized
                    surface_delivery = 'initialize'
                else:
                    full = client.wait_for_notification('surfaceIndexChanged',
                        lambda params: len(params.get('surfaceIndex') or {}) == models, timeout_seconds=120)
                    surface_delivery = 'notification'
                ready_ms = (time.perf_counter() - client.started) * 1000
                for number in range(models):
                    model_label = f'app{number // 50}.Model{number}'
                    for field in range(15):
                        assert f'field_{field}' in full['surfaceIndex'][model_label]['instance']
                    for relation in range(2):
                        target = (number + relation + 1) % models
                        assert full['surfaceIndex'][model_label]['instance'][f'fk_{relation}'][1] == f'app{target // 50}.Model{target}'
                assert full['surfaceIndex'][label]['instance']['field_0'][3] == 'CharField'
                root_type = full['lookupCatalog']['types'][full['lookupCatalog']['fields'][label]['field_0']]
                assert full['lookupCatalog']['types'][root_type['transforms']['field_size']]['fieldKind'] == expected
                encoded = json.dumps(full).encode()
                payload = output_dir / f'{file_count}-{lifecycle}-payload.json'
                payload.write_bytes(encoded)
                log = output_dir / f'{file_count}-{lifecycle}-daemon.log'
                log.write_bytes(Path(client.log.name).read_bytes())
                phase_lines = [json.loads(line.removeprefix('[initialize:phase-cost] '))
                    for line in log.read_text().splitlines() if line.startswith('[initialize:phase-cost] ')]
                rows.append({'phase': lifecycle, 'initializeRpcMs': rpc_ms,
                    'fullSurfaceReadyFromClientStartMs': ready_ms,
                    'firstResponseFieldKind': 'CharField', 'firstResponseTransformOutputKind': expected,
                    'firstResponseCurrentSource': True,
                    'completeModelScalarAndFkMetadata': True, 'surfaceDelivery': surface_delivery,
                    'payload': str(payload),
                    'payloadBytes': len(encoded), 'sha256': hashlib.sha256(encoded).hexdigest(),
                    'daemonLog': str(log), 'phaseCosts': phase_lines,
                    'interleavedRpcMs': interleaved_rpc_ms,
                    'prebuildRequestObserved': surface_request_started,
                    'surfaceBuildOverlapStarted': surface_build_started,
                    'prebuildSetupRpcMs': setup_rpc_ms,
                    'surfaceBuildRpcMs': surface_build_rpc_ms})
            finally:
                client.close()
        return {'models': models, 'pythonFiles': file_count, 'workerModule': worker_module, 'rows': rows,
            'scope': 'Sequential actual configured ready cold/cached/source-edit fresh daemons on same source/cache fixture. Full model/scalar/FK/catalogue and first-response field-kind assertions. Diagnostic phase worker timing ifselected; includes main phase wall/threadCPU/processCPU and wholeRPC/fullready wall. Nested catalogue rows must notbesummed. Host uncontrolled; sourceedit valid currentkind test, not all race/platform/cached budgets or aggregate memory.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', type=int, default=500)
    parser.add_argument('--files', type=int, default=5000)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--worker-module', default='benchmarks.profile_startup_phases_worker')
    parser.add_argument('--interleaved-rpcs', type=int, default=0)
    args = parser.parse_args()
    print(json.dumps(run(args.models, args.files, args.output_dir, args.worker_module,
        args.interleaved_rpcs), indent=2))
