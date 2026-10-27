"""Candidate-only fresh-process capture for edits while parent Django stays loaded."""
import argparse
import json
import multiprocessing
import os
import sys
import tempfile
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from unittest import mock

from benchmarks.check_surface_worker_runtime_fidelity import SOURCE, _member_wire
from django_orm_intellisense.features import orm_members
from django_orm_intellisense.runtime.inspector import inspect_runtime
from django_orm_intellisense.runtime.source_imports import current_workspace_source_imports
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.server import app
from django_orm_intellisense.static_index.indexer import build_static_index, reindex_single_file


def fresh_capture(root):
    static, runtime, graph = app._worker_static_index, app._worker_runtime, app._worker_model_graph
    cpu, wall = time.process_time_ns(), time.perf_counter_ns()
    with current_workspace_source_imports([root]):
        members = orm_members.capture_runtime_member_surface(static, runtime)
    capture_wall = (time.perf_counter_ns() - wall) / 1e6
    capture_cpu = (time.process_time_ns() - cpu) / 1e6
    surface = orm_members.prebuild_member_surface_cache(static, runtime, graph)
    from django.apps import apps
    return {'members': members, 'surface': surface,
        'wire': _member_wire(orm_members._surface_cache), 'djangoAppsReady': apps.ready,
        'captureIncludingDjangoSetupWallMs': capture_wall,
        'captureIncludingDjangoSetupCpuMs': capture_cpu, 'pid': os.getpid()}


def snapshot_build(static, runtime, graph, members):
    original = orm_members._MemberSurfaceCache
    caches = []
    def create():
        value = original()
        caches.append(value)
        return value
    with mock.patch.object(orm_members, '_MemberSurfaceCache', create):
        surface = orm_members.prebuild_member_surface_cache(static, runtime, graph, runtime_members=members)
    return surface, _member_wire(caches[-1])


def run(output_dir):
    output_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    with tempfile.TemporaryDirectory(prefix='djls-runtime-refresh-candidate-') as temporary:
        root = Path(temporary).resolve()
        package = root / 'runtime_surface'
        package.mkdir()
        (package / '__init__.py').write_text('')
        source = package / 'models.py'
        source.write_text(SOURCE)
        (root / 'runtime_surface_settings.py').write_text(
            'INSTALLED_APPS=["runtime_surface"]\nSECRET_KEY="runtime-refresh-candidate"\n'
            'DEFAULT_AUTO_FIELD="django.db.models.BigAutoField"\n'
            'DATABASES={"default":{"ENGINE":"django.db.backends.sqlite3","NAME":":memory:"}}\n')
        sys.path.insert(0, str(root))
        static = build_static_index(root)
        runtime = inspect_runtime('runtime_surface_settings')
        assert runtime.bootstrap_status == 'ready', runtime.bootstrap_error
        graph = build_model_graph(static, runtime)
        original_surface = orm_members.prebuild_member_surface_cache(static, runtime, graph)
        from django.apps import apps
        parent_class = apps.get_model('runtime_surface', 'Post')
        parent_method = parent_class.attached_instance
        previous_names = ['attached_instance', 'attached_class', 'attached_query']
        for prefix in ('modified', 'replaced'):
            new_names = [prefix + '_instance', prefix + '_class', prefix + '_query']
            stamp = source.stat()
            current_source = source.read_text()
            for old, new in zip(previous_names, new_names):
                assert len(old) == len(new) and old in current_source
                current_source = current_source.replace(old, new)
            assert len(current_source.encode()) == stamp.st_size
            source.write_text(current_source)
            os.utime(source, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
            static, _, _ = reindex_single_file(root, source, static)
            graph = build_model_graph(static, runtime)
            stale = orm_members.prebuild_member_surface_cache(static, runtime, graph)
            assert 'attached_instance' in stale['runtime_surface.Post']['instance']
            started = time.perf_counter_ns()
            with app.surface_worker_state_file(static, runtime, graph) as path:
                with ProcessPoolExecutor(max_workers=1, mp_context=multiprocessing.get_context('spawn'),
                        initializer=app._init_bg_worker_from_file, initargs=(path,)) as pool:
                    fresh = pool.submit(fresh_capture, str(root)).result(timeout=30)
            round_trip_ms = (time.perf_counter_ns() - started) / 1e6
            surface, wire = snapshot_build(static, runtime, graph, fresh['members'])
            assert surface == fresh['surface'] and wire == fresh['wire']
            assert fresh['djangoAppsReady'] and fresh['pid'] != os.getpid()
            assert apps.get_model('runtime_surface', 'Post') is parent_class
            assert parent_class.attached_instance is parent_method
            assert not hasattr(parent_class, new_names[0])
            for kind in ('instance', 'model_class', 'manager', 'queryset', 'related_manager'):
                selected = new_names[:2] if kind in ('instance', 'model_class') else new_names[2:]
                old = ['attached_instance', 'attached_class'] if kind in ('instance', 'model_class') else ['attached_query']
                assert all(name in surface['runtime_surface.Post'][kind] for name in selected)
                assert all(name not in surface['runtime_surface.Post'][kind] for name in old + previous_names)
            payload = output_dir / f'{prefix}-candidate-payload.json'
            payload.write_text(json.dumps({'surface': surface, 'everyBoundMemberWire': wire}, sort_keys=True) + '\n')
            rows.append({'phase': prefix, 'completeSurfaceEqualToFreshRuntime': True,
                'everyBoundMemberWireEqualToFreshRuntime': True,
                'allFiveReceiverNamesCurrent': True, 'parentDjangoClassesUnchanged': True,
                'sameSizeRestoredMtimeEdit': True, 'freshWorkerPid': fresh['pid'],
                'captureIncludingDjangoSetupWallMs': fresh['captureIncludingDjangoSetupWallMs'],
                'captureIncludingDjangoSetupCpuMs': fresh['captureIncludingDjangoSetupCpuMs'],
                'freshSpawnValidationAndShutdownWallMs': round_trip_ms,
                'runtimeMemberRecords': sum(map(len, fresh['members'].values())), 'payload': str(payload)})
            previous_names = new_names
        assert len({row['freshWorkerPid'] for row in rows}) == 2
        assert 'attached_instance' in original_surface['runtime_surface.Post']['instance']
    return {'productionApplied': False, 'daemonIntegrationImplemented': False, 'rows': rows,
        'scope': 'One-model configured parent keeps original Django classes across two source '
            'renames with equal size/restored mtime. Each separate fresh spawn initializes current '
            'Django under the current-source loader and captures runtime-only records. Parent '
            'snapshot surface and every bound wire equal the fresh worker full reflection result. '
            'Round-trip includes private-state write, spawn/setup/capture, full validation surface, '
            'transport and shutdown. Not edit RPC/editor latency, aggregate memory, broad dynamic '
            'coverage, race/owner publication proof or a production fix; synchronous costs must '
            'not be moved into ordinary edit RPCs without addressing the20ms budget.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.output_dir), indent=2))
