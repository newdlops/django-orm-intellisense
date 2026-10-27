"""Hold actual Django preparation until all first cached queries finish."""
from pathlib import Path
import inspect
import json
import os
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

from django_orm_intellisense.cache import store
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.features import orm_members
from django_orm_intellisense.runtime import inspector
from django_orm_intellisense.runtime.source_imports import current_workspace_source_imports
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.server import app
from django_orm_intellisense.static_index.indexer import build_static_index

QUERIES = [
    {'modelLabel': 'readyapp.Model0', 'receiverKind': 'instance', 'name': 'attached_instance'},
    {'modelLabel': 'readyapp.Model0', 'receiverKind': 'model_class', 'name': 'attached_class'},
    {'modelLabel': 'readyapp.Model0', 'receiverKind': 'manager', 'name': 'attached_manager'},
    {'modelLabel': 'readyapp.Model0', 'receiverKind': 'manager', 'name': 'special_only', 'managerName': 'special'},
    {'modelLabel': 'readyapp.Model0', 'receiverKind': 'queryset', 'name': 'attached_queryset', 'managerName': 'special'},
    {'modelLabel': 'readyapp.Model0', 'receiverKind': 'related_manager', 'name': 'special_only', 'managerName': 'special'},
    {'modelLabel': 'readyapp.Model0', 'receiverKind': 'instance', 'name': 'absent'},
]
CHAIN = {'modelLabel': 'readyapp.Model0', 'receiverKind': 'instance',
    'chain': ['attached_instance', 'attached_second']}

def calls(static, runtime, graph):
    kwargs = {'static_index': static, 'runtime': runtime, 'model_graph': graph}
    singles = [orm_members.resolve_orm_member(**kwargs, model_label=query['modelLabel'],
        receiver_kind=query['receiverKind'], name=query['name'], manager_name=query.get('managerName')) for query in QUERIES]
    chain = orm_members.resolve_orm_member_chain(**kwargs, model_label=CHAIN['modelLabel'],
        receiver_kind=CHAIN['receiverKind'], chain=CHAIN['chain'])
    return {'singles': singles, 'batch': {'results': singles}, 'chain': chain}

def seed(root, *, legacy=False, through_server=False):
    sys.path.insert(0, str(root))
    if through_server:
        output = sys.stdout
        try:
            server = app.DaemonServer(root)
        finally:
            sys.stdout = output
        server._write_notification = lambda *args, **kwargs: None
        try:
            server._initialize({'workspaceRoot': str(root), 'settingsModule': 'readiness_settings', 'deferRuntime': False})
            server._request_surface_index_load(reason='actual-cold-persistence')
            worker = server._surface_prebuild_future
            if worker is not None:
                worker.join(15)
                assert not worker.is_alive()
            assert server._last_surface_index and server.static_index._runtime_member_snapshot is not None
            expected = calls(server.static_index, server.runtime_inspection, server.model_graph)
            (root.parent / 'expected.json').write_text(json.dumps(expected, indent=2) + '\n')
            assert json.loads((store._workspace_cache_dir(root) / store.SURFACE_INDEX_CACHE_NAME).read_text())['metadata']['runtimeMembersVersion'] == 1
            return
        finally:
            server._stopping.set()
            server._cancel_surface_index_idle_load()
            server._cancel_runtime_member_refresh()
            worker = server._registry_prewarm_thread
            if worker is not None:
                worker.join(5)
                assert not worker.is_alive()
    with current_workspace_source_imports((root,)):
        runtime = inspector.inspect_runtime('readiness_settings')
        assert runtime.bootstrap_status == 'ready'
        static = build_static_index(root)
        graph = build_model_graph(static, runtime)
        captured = orm_members.capture_current_runtime_members(static, runtime, graph)
        surface = orm_members.prebuild_member_surface_cache(static, runtime, graph, runtime_members=captured.items)
        expected = calls(static, runtime, graph)
    assert all(result['resolved'] for result in expected['singles'][:-1]), expected
    assert not expected['singles'][-1]['resolved']
    assert expected['chain']['resolved'], expected['chain']
    snapshot = snapshot_python_sources(root, max_workers=1)
    source = app._runtime_source_fingerprint(source_snapshot=snapshot, static_index=static,
        settings_module=runtime.settings_module)
    fingerprint = app._runtime_cache_fingerprint(runtime, source_fingerprint=source)
    store.save_static_index(root, snapshot, static)
    store.save_runtime_inspection(root, source, runtime.settings_module, runtime)
    store.save_model_graph(root, snapshot.fingerprint, fingerprint, graph)
    # The same test also exercises the original producer, which has no full
    # catalog parameter. Its legacy cache demonstrates the first-query gap.
    extra = {'runtime_members': captured} if not legacy and 'runtime_members' in inspect.signature(store.save_surface_index).parameters else {}
    store.save_surface_index(root, snapshot.fingerprint, fingerprint, surface,
        surface_fingerprints=orm_members.fingerprint_surface_index(surface), **extra)
    (root.parent / 'expected.json').write_text(json.dumps(expected, indent=2) + '\n')

def actual(folder, *, through_server=False, legacy=False):
    folder.mkdir()
    root = folder / 'fixture'
    package = root / 'readyapp'
    package.mkdir(parents=True)
    (package / '__init__.py').write_text('')
    (root / 'readiness_settings.py').write_text("SECRET_KEY='test'\nINSTALLED_APPS=['readyapp']\n"
        "DATABASES={'default':{'ENGINE':'django.db.backends.sqlite3','NAME':':memory:'}}\n"
        "DEFAULT_AUTO_FIELD='django.db.models.AutoField'\n")
    (package / 'models.py').write_text('from django.db import models\n'
        'class SpecialQuerySet(models.QuerySet):\n    pass\n'
        'class SpecialManager(models.Manager.from_queryset(SpecialQuerySet)):\n    pass\n'
        'class Model0(models.Model):\n    key = models.UUIDField(primary_key=True)\n'
        '    value = models.CharField(max_length=10)\n    objects = models.Manager()\n    special = SpecialManager()\n'
        'def attached_instance(self) -> Model0:\n    return self\n'
        'def attached_class(cls) -> Model0:\n    return cls()\n'
        'def attached_manager(self) -> SpecialQuerySet:\n    return self.get_queryset()\n'
        'def special_only(self) -> SpecialQuerySet:\n    return self.get_queryset()\n'
        'def attached_queryset(self) -> SpecialQuerySet:\n    return self\n'
        'Model0.attached_instance = attached_instance\n'
        'Model0.attached_second = attached_instance\n'
        'Model0.attached_class = classmethod(attached_class)\n'
        'models.Manager.attached_manager = attached_manager\n'
        'SpecialManager.special_only = special_only\n'
        'SpecialQuerySet.attached_queryset = attached_queryset\n')
    assert os.environ['DJANGO_ORM_INTELLISENSE_CACHE_DIR'] == str(folder / 'cache')
    seed_mode = '--seed-server' if through_server else '--seed-legacy' if legacy else '--seed'
    seeded = subprocess.run([sys.executable, '-B', __file__, seed_mode, str(root)],
        capture_output=True, text=True, timeout=30)
    (folder / 'seed.stdout').write_text(seeded.stdout)
    (folder / 'seed.stderr').write_text(seeded.stderr)
    assert seeded.returncode == 0, seeded.stderr
    expected = json.loads((folder / 'expected.json').read_text())
    cache_path = store._workspace_cache_dir(root) / store.SURFACE_INDEX_CACHE_NAME
    cache_version_before = json.loads(cache_path.read_text())['metadata'].get('runtimeMembersVersion')
    sys.path.insert(0, str(root))
    entered, release = threading.Event(), threading.Event()
    import django
    from django.apps import apps
    assert not apps.ready and not apps.models_ready
    real_setup = django.setup
    def blocked(*args, **kwargs):
        entered.set()
        assert release.wait(15), 'preparation gate was never released'
        return real_setup(*args, **kwargs)
    output = sys.stdout
    try:
        server = app.DaemonServer(root)
    finally:
        sys.stdout = output
    server._write_notification = lambda *args, **kwargs: None
    first, completed_held = {}, False
    with mock.patch.object(django, 'setup', side_effect=blocked) as setups:
        initialized = server._initialize({'workspaceRoot': str(root),
            'settingsModule': 'readiness_settings', 'deferRuntime': True})
        initial_fingerprints = initialized['surfaceFingerprints']
        initial_fingerprints_expected = orm_members.fingerprint_surface_index(initialized['surfaceIndex'])
        assert entered.wait(5)
        worker = server._registry_prewarm_thread
        assert not apps.ready and not apps.models_ready
        def queries():
            singles = [server._resolve_orm_member(query) for query in QUERIES]
            batch = server._resolve_orm_member_batch({'items': QUERIES})
            batch.pop('_batch_size', None)
            return {'singles': singles, 'batch': batch, 'chain': server._resolve_orm_member_chain(CHAIN)}
        started = time.perf_counter()
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(queries)
            try:
                first = future.result(timeout=3)
                completed_held = (not release.is_set() and not apps.ready and not apps.models_ready
                    and not inspector.runtime_field_registry_is_ready('readiness_settings'))
            finally:
                release.set()
                worker.join(10)
                assert not worker.is_alive()
        elapsed = (time.perf_counter() - started) * 1000
        if legacy:
            assert initialized['surfaceIndex'] == {}, 'Legacy cache exposed a complete surface without its full catalog'
            server._request_surface_index_load(reason='actual-legacy-migration')
            load = server._surface_prebuild_future
            if load is not None:
                load.join(15)
                assert not load.is_alive()
            assert server._last_surface_index and server.static_index._runtime_member_snapshot is not None
        later = queries()
    record = {'djangoVersion': server.runtime_inspection.django_version,
        'first': first, 'expected': expected, 'later': later,
        'completedAllQueriesBeforeRegistryRelease': completed_held,
        'initialSurfaceModels': len(initialized['surfaceIndex']),
        'initialSurfaceFingerprints': initial_fingerprints,
        'initialSurfaceFingerprintsExpected': initial_fingerprints_expected,
        'cachedSnapshotPresent': server.static_index._runtime_member_snapshot is not None,
        'wholeObservationMsIncludingReleasedPreparation': elapsed,
        'sameGeneration': server._state_generation, 'runtimePreparationStarted': entered.is_set(),
        'actualDjangoSetupWasHeld': True, 'setupCalls': setups.call_count,
        'producer': 'actual-background-persistence' if through_server else 'manual-legacy' if legacy else 'manual-catalog',
        'cacheVersionBefore': cache_version_before,
        'cacheVersionAfter': json.loads(cache_path.read_text())['metadata'].get('runtimeMembersVersion'),
        'sourceFiles': {path.relative_to(root).as_posix(): path.read_text() for path in root.rglob('*.py')}}
    (folder / 'result.json').write_text(json.dumps(record, indent=2) + '\n')
    server._stopping.set()
    server._cancel_surface_index_idle_load()
    server._cancel_runtime_member_refresh()
    assert completed_held, record
    assert initial_fingerprints == initial_fingerprints_expected, (initial_fingerprints, initial_fingerprints_expected)
    assert later == expected, (later, expected)
    if legacy:
        assert first != expected and initialized['surfaceIndex'] == {}
        assert record['cacheVersionBefore'] is None and record['cacheVersionAfter'] == 1
    else:
        assert first == expected, (first, expected)
    print(json.dumps(record))

if __name__ == '__main__':
    mode = sys.argv[1]
    if mode.startswith('--seed'):
        seed(Path(sys.argv[2]), legacy=mode == '--seed-legacy', through_server=mode == '--seed-server')
    else:
        actual(Path(sys.argv[2]), legacy=mode == '--actual-legacy', through_server=mode == '--actual-server')
