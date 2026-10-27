"""Regression: lookup completion collapsed to ``id`` / ``pk`` only.

Two daemon-side gaps left the client with a model whose only fields were the
synthesized primary key names:

1. ``_build_static_fallback`` skipped every label present in the surface index,
   even when that surface entry carried no instance fields. A field-less entry
   therefore hid the model's real fields from the client.
2. Runtime warm-up rebuilt the static fallback from the runtime graph but only
   sent ``healthChanged``. The client kept the static-only fallback (no
   inherited fields, static labels) until the lazy surface prebuild finished.
"""
from __future__ import annotations

import contextlib
import os
import sys
import tempfile
import textwrap
import threading
import unittest
from pathlib import Path
from unittest import mock

from django_orm_intellisense.features.orm_members import (
    build_surface_index,
    fingerprint_surface_index,
)
from django_orm_intellisense.runtime.inspector import (
    RuntimeFieldSummary,
    RuntimeInspection,
    RuntimeModelSummary,
    create_pending_runtime_inspection,
)
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.server import app as server_app
from django_orm_intellisense.static_index.indexer import (
    ModelCandidate,
    StaticIndex,
    build_static_index,
)


def _make_server(workspace_root: Path) -> server_app.DaemonServer:
    real_stdout = sys.stdout
    try:
        server = server_app.DaemonServer(workspace_root)
    finally:
        # DaemonServer redirects sys.stdout to stderr for the daemon process.
        sys.stdout = real_stdout
    return server


def _write_blog_models(root: Path) -> None:
    app_dir = root / 'blog'
    app_dir.mkdir(parents=True)
    (app_dir / '__init__.py').write_text('')
    (app_dir / 'models.py').write_text(textwrap.dedent(
        '''
        from django.db import models


        class Post(models.Model):
            title = models.CharField(max_length=100)
        '''
    ))


def _inheritance_only_static_index() -> StaticIndex:
    # A concrete model whose fields all come from a base the static indexer
    # cannot see (e.g. an abstract model shipped in an installed package).
    candidate = ModelCandidate(
        app_label='blog',
        object_name='Post',
        label='blog.Post',
        module='blog.models',
        file_path='/workspace/blog/models.py',
        line=10,
        column=0,
        is_abstract=False,
        base_class_refs=(),
        source='static',
    )
    return StaticIndex(
        python_file_count=1,
        package_init_count=0,
        reexport_module_count=0,
        star_import_count=0,
        explicit_all_count=0,
        modules={},
        model_candidates=[candidate],
    )


def _runtime_model(
    label: str,
    module: str,
    fields: list[tuple[str, str]],
) -> RuntimeModelSummary:
    return RuntimeModelSummary(
        label=label,
        module=module,
        field_names=[name for name, _kind in fields],
        relation_names=[],
        reverse_relation_names=[],
        fields=[
            RuntimeFieldSummary(
                name=name,
                field_kind=kind,
                is_relation=False,
                related_model_label=None,
                direction=None,
            )
            for name, kind in fields
        ],
        relations=[],
        manager_names=['objects'],
    )


def _ready_runtime_with(*models: RuntimeModelSummary) -> RuntimeInspection:
    return RuntimeInspection(
        python_executable=sys.executable,
        django_importable=True,
        django_version='5.2',
        bootstrap_status='ready',
        settings_module='project.settings',
        bootstrap_error=None,
        app_count=len(models),
        model_count=len(models),
        field_count=sum(len(model.fields) for model in models),
        relation_count=0,
        reverse_relation_count=0,
        manager_count=len(models),
        model_catalog=list(models),
        model_preview=list(models),
    )


def _ready_runtime() -> RuntimeInspection:
    return _ready_runtime_with(
        _runtime_model(
            'blog.Post',
            'blog.models',
            [('id', 'BigAutoField'), ('title', 'CharField')],
        )
    )


def _warmup_patches(server: server_app.DaemonServer, notifications: list):
    return [
        mock.patch.object(server_app, 'save_runtime_inspection'),
        mock.patch.object(
            server_app, 'build_semantic_graph', return_value=mock.Mock(),
        ),
        mock.patch.object(
            server_app, 'build_health_snapshot', return_value={'phase': 'ready'},
        ),
        mock.patch.object(server, '_schedule_surface_index_idle_load'),
        mock.patch.object(
            server,
            '_write_notification',
            side_effect=lambda event, params: notifications.append((event, params)),
        ),
    ]


# Candidate `zuzu.Company` (module segment) is registered by Django under the
# AppConfig label `db`, so the graph/surface key is `db.Company`.
_ZUZU_MODELS = textwrap.dedent(
    '''
    from django.db import models


    class Company(models.Model):
        name = models.CharField(max_length=100)
    '''
)
_ZUZU_MODELS_WITH_CODE = _ZUZU_MODELS + '    code = models.CharField(max_length=5)\n'


def _label_split_server(root: Path) -> tuple[server_app.DaemonServer, Path]:
    app_dir = root / 'zuzu'
    app_dir.mkdir(parents=True)
    (app_dir / '__init__.py').write_text('')
    models_path = app_dir / 'models.py'
    models_path.write_text(_ZUZU_MODELS)

    static_index = build_static_index(root)
    runtime = _ready_runtime_with(
        _runtime_model(
            'db.Company',
            'zuzu.models',
            [('id', 'BigAutoField'), ('name', 'CharField')],
        )
    )
    graph = build_model_graph(static_index, runtime)
    surface = build_surface_index(static_index, runtime, graph)

    server = _make_server(root)
    server.static_index = static_index
    server.runtime_inspection = runtime
    server.model_graph = graph
    server.source_snapshot = server_app.snapshot_python_sources(root)
    server._source_membership_fingerprint = server_app.source_membership_fingerprint(server.source_snapshot)
    server._runtime_source_cache_fingerprint = server_app._runtime_source_fingerprint(
        source_snapshot=server.source_snapshot, static_index=static_index,
        settings_module=runtime.settings_module,
        membership_fingerprint=server._source_membership_fingerprint)
    server._last_surface_index = surface
    server._last_surface_fingerprints = fingerprint_surface_index(surface)
    server._last_static_fallback = server._build_static_fallback(
        model_graph=graph,
        surface_index=surface,
    )
    return server, models_path


@contextlib.contextmanager
def _persisted_surface_cache(server, surface):
    """Use a complete real cache for the method-free Company fixture."""
    from django_orm_intellisense.cache import store
    from django_orm_intellisense.features.orm_members import RuntimeMemberSnapshot

    runtime = server.runtime_inspection
    labels = frozenset(candidate.label for candidate in server.static_index.model_candidates
        if not candidate.is_abstract)
    members = RuntimeMemberSnapshot(
        (runtime.python_executable, runtime.settings_module, runtime.django_version),
        {}, {label: ('objects',) for label in labels}, labels)
    source = server.source_snapshot.fingerprint
    fingerprint = server_app._runtime_cache_fingerprint(runtime,
        source_fingerprint=server._runtime_source_cache_fingerprint)
    with mock.patch.dict(os.environ, {
            'DJANGO_ORM_INTELLISENSE_CACHE_DIR': str(server.workspace_root / 'test-surface-cache')}):
        store.save_surface_index(server.workspace_root, source, fingerprint, surface,
            surface_fingerprints=fingerprint_surface_index(surface), runtime_members=members)
        loaded = store.load_cached_surface_index(server.workspace_root, source, fingerprint,
            static_index=server.static_index, model_graph=server.model_graph,
            with_fingerprints=True, with_runtime_members=True, runtime_inspection=runtime)
        assert loaded is not None and loaded[0] == surface
        assert loaded[1] == fingerprint_surface_index(surface) and loaded[2] == members
        yield


class StaticFallbackSurfaceGapTest(unittest.TestCase):
    def test_verified_cached_initialize_reuses_full_index_without_reading_an_old_snapshot(self) -> None:
        from django_orm_intellisense.cache import save_static_index
        from django_orm_intellisense.discovery.workspace import snapshot_python_sources
        from django_orm_intellisense.cache import store
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            _write_blog_models(root)
            snapshot = snapshot_python_sources(root, max_workers=1)
            index = build_static_index(root, snapshot.files)
            with mock.patch.dict(os.environ, {'DJANGO_ORM_INTELLISENSE_CACHE_DIR': str(root / 'cache')}):
                save_static_index(root, snapshot, index)
                server = _make_server(root)
                with mock.patch.object(store, 'load_cached_source_snapshot', side_effect=AssertionError('Duplicate cached snapshot read')), \
                        mock.patch.object(server_app, 'snapshot_python_sources', wraps=snapshot_python_sources) as scan, \
                        mock.patch.object(server_app, 'save_source_snapshot') as save, \
                        mock.patch.object(server_app, 'build_static_index', side_effect=AssertionError('Unchanged full index rebuilt')), \
                        mock.patch.object(server, '_start_runtime_warmup'), \
                        mock.patch.object(server, '_start_runtime_field_registry_prewarm'), \
                        mock.patch.object(server, '_schedule_surface_index_idle_load'):
                    result = server._initialize({'workspaceRoot': str(root), 'deferRuntime': True})
                # Initial inventory, pre-runtime stability and pre-publish
                # stability all inspect current identity; the full static
                # index itself is still restored once without a rebuild.
                # Other server instances can finish background work while
                # these global spies are installed. Count this root's work.
                current_scans = [call for call in scan.call_args_list
                                 if call.args and Path(call.args[0]).resolve() == root]
                current_saves = [call for call in save.call_args_list
                                 if call.args and Path(call.args[0]).resolve() == root]
                self.assertEqual(len(current_scans), 3, scan.call_args_list)
                self.assertEqual(current_saves, [], save.call_args_list)
                self.assertEqual(result['staticFallback']['blog.Post']['fieldDetails']['title']['fieldKind'], 'CharField')

    def test_cached_initialize_verifies_source_before_exposing_field_metadata(self) -> None:
        from django_orm_intellisense.cache import save_source_snapshot, save_static_index
        from django_orm_intellisense.discovery.workspace import snapshot_python_sources
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            _write_blog_models(root)
            source = root / 'blog/models.py'
            original = source.read_text()
            stamp = source.stat()
            snapshot = snapshot_python_sources(root, max_workers=1)
            index = build_static_index(root, snapshot.files)
            with mock.patch.dict(os.environ, {'DJANGO_ORM_INTELLISENSE_CACHE_DIR': str(root / 'cache')}):
                save_source_snapshot(root, snapshot)
                save_static_index(root, snapshot, index)
                source.write_text(original.replace('CharField', 'DateField'))
                os.utime(source, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
                server = _make_server(root)
                with mock.patch.object(server, '_start_source_snapshot_verification'), \
                        mock.patch.object(server, '_start_runtime_warmup'), \
                        mock.patch.object(server, '_start_runtime_field_registry_prewarm'), \
                        mock.patch.object(server, '_schedule_surface_index_idle_load'):
                    result = server._initialize({'workspaceRoot': str(root), 'deferRuntime': True})
                self.assertEqual(result['staticFallback']['blog.Post']['fieldDetails']['title']['fieldKind'], 'DateField')

    def test_cached_initialize_includes_new_files_and_retires_deleted_models(self) -> None:
        from django_orm_intellisense.cache import save_source_snapshot, save_static_index
        from django_orm_intellisense.discovery.workspace import snapshot_python_sources
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            _write_blog_models(root)
            snapshot = snapshot_python_sources(root, max_workers=1)
            index = build_static_index(root, snapshot.files)
            with mock.patch.dict(os.environ, {'DJANGO_ORM_INTELLISENSE_CACHE_DIR': str(root / 'cache')}):
                save_source_snapshot(root, snapshot)
                save_static_index(root, snapshot, index)
                (root / 'blog/models.py').unlink()
                (root / 'blog/replacement.py').write_text('from django.db import models\nclass Replacement(models.Model):\n    fresh = models.DateField()\n')
                server = _make_server(root)
                with mock.patch.object(server, '_start_runtime_warmup'), \
                        mock.patch.object(server, '_start_runtime_field_registry_prewarm'), \
                        mock.patch.object(server, '_schedule_surface_index_idle_load'):
                    result = server._initialize({'workspaceRoot': str(root), 'deferRuntime': True})
                self.assertNotIn('Post', result['modelNames'])
                self.assertNotIn('blog.Post', result['staticFallback'])
                self.assertIn('Replacement', result['modelNames'])
                self.assertEqual(result['staticFallback']['blog.Replacement']['fieldDetails']['fresh']['fieldKind'], 'DateField')

    def test_initialize_verifies_editable_source_changes_before_cached_adoption(self) -> None:
        from django_orm_intellisense.cache import save_static_index
        from django_orm_intellisense.discovery.workspace import EditableInstall, VenvInfo, snapshot_python_sources
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            root = base / 'workspace'
            root.mkdir()
            external = base / 'library'
            _write_blog_models(external)
            source = external / 'blog/models.py'
            original = source.read_text()
            stamp = source.stat()
            snapshot = snapshot_python_sources(root, [external], max_workers=1)
            index = build_static_index(root, snapshot.files)
            info = VenvInfo(str(base / 'venv'), None, None, False,
                (EditableInstall('library', str(external), 'direct-url'),))
            with mock.patch.dict(os.environ, {'DJANGO_ORM_INTELLISENSE_CACHE_DIR': str(base / 'cache')}):
                save_static_index(root, snapshot, index)
                source.write_text(original.replace('CharField', 'DateField'))
                os.utime(source, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
                server = _make_server(root)
                with mock.patch.object(server_app, 'resolve_venv_info', return_value=info), \
                        mock.patch.object(server, '_start_runtime_warmup'), \
                        mock.patch.object(server, '_start_runtime_field_registry_prewarm'), \
                        mock.patch.object(server, '_schedule_surface_index_idle_load'):
                    result = server._initialize({'workspaceRoot': str(root), 'deferRuntime': True})
                self.assertEqual(result['staticFallback']['blog.Post']['fieldDetails']['title']['fieldKind'], 'DateField')
                self.assertEqual(result['venvInfo']['editableInstalls'][0]['path'], str(external))

    def test_source_verification_cannot_replace_a_newer_initialization(self) -> None:
        server = _make_server(Path('/workspace'))
        server._state_generation = 7
        initialized_state = mock.Mock()
        initialized_state.source_snapshot.fingerprint = 'old-source'
        verified_snapshot = mock.Mock(fingerprint='changed-source', file_count=1)

        def verify(*args, **kwargs):
            # A second initialization wins while the first snapshot is scanned.
            server._state_generation = 8
            return verified_snapshot

        with mock.patch.object(server, '_snapshot_sources_for_verification', side_effect=verify), \
                mock.patch.object(server_app, 'save_source_snapshot') as save, \
                mock.patch.object(server, '_initialize_from_source_snapshot') as refresh, \
                mock.patch.object(server, '_start_runtime_warmup') as warmup, \
                mock.patch.object(server, '_write_notification') as notify:
            server._verify_source_snapshot_state(generation=7, workspace_root=Path('/workspace'),
                settings_module=None, venv_info=None, editable_roots=[], initialized_state=initialized_state)

        self.assertEqual(server._state_generation, 8)
        save.assert_not_called()
        refresh.assert_not_called()
        warmup.assert_not_called()
        notify.assert_not_called()

    def test_source_verification_retries_after_a_save_during_the_scan(self) -> None:
        server = _make_server(Path('/workspace'))
        server._state_generation = 7
        initialized_state = mock.Mock()
        initialized_state.source_snapshot.fingerprint = 'old-source'

        def verify(*args, **kwargs):
            server._reindex_serial += 1
            return mock.Mock(fingerprint='changed-source', file_count=1)

        with mock.patch.object(server, '_snapshot_sources_for_verification', side_effect=verify), \
                mock.patch.object(server_app, 'save_source_snapshot') as save, \
                mock.patch.object(server, '_initialize_from_source_snapshot') as refresh, \
                mock.patch.object(server, '_retry_source_snapshot_verification') as retry:
            server._verify_source_snapshot_state(generation=7, workspace_root=Path('/workspace'),
                settings_module=None, venv_info=None, editable_roots=[], initialized_state=initialized_state)

        self.assertEqual(server._state_generation, 7)
        save.assert_not_called()
        refresh.assert_not_called()
        retry.assert_called_once()
        self.assertEqual(retry.call_args.kwargs['generation'], 7)

    def test_source_verification_retries_after_a_save_during_the_refresh(self) -> None:
        server = _make_server(Path('/workspace'))
        server._state_generation = 7
        initialized_state = mock.Mock()
        initialized_state.source_snapshot.fingerprint = 'old-source'

        with mock.patch.object(server, '_snapshot_sources_for_verification',
                return_value=mock.Mock(fingerprint='changed-source', file_count=1)), \
                mock.patch.object(server_app, 'save_source_snapshot'), \
                mock.patch.object(server, '_initialize_from_source_snapshot', return_value=None) as refresh, \
                mock.patch.object(server, '_retry_source_snapshot_verification') as retry, \
                mock.patch.object(server, '_write_notification') as notify:
            server._verify_source_snapshot_state(generation=7, workspace_root=Path('/workspace'),
                settings_module=None, venv_info=None, editable_roots=[], initialized_state=initialized_state)

        self.assertEqual(refresh.call_args.kwargs['expected_reindex_serial'], 0)
        self.assertEqual(server._state_generation, 8)
        retry.assert_called_once()
        self.assertEqual(retry.call_args.kwargs['generation'], 8)
        notify.assert_not_called()

    def test_initialize_metadata_built_during_a_save_cannot_replace_latest_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _write_blog_models(root)
            snapshot = server_app.snapshot_python_sources(root)
            profile = server_app.discover_workspace(root)
            index = build_static_index(root)
            runtime = create_pending_runtime_inspection(None)
            graph = build_model_graph(index, runtime)
            server = _make_server(root)
            server._state_generation = 7
            latest_index = mock.Mock()
            server.static_index = latest_index
            server._last_surface_index = {'latest': {}}

            def fallback(**kwargs):
                server._reindex_serial += 1
                return {'blog.Post': {'fields': ['title']}}

            with mock.patch.object(server_app, 'discover_workspace', return_value=profile), \
                    mock.patch.object(server_app, 'load_cached_static_index', return_value=(index, 'full')), \
                    mock.patch.object(server_app, 'load_cached_runtime_inspection', return_value=runtime), \
                    mock.patch.object(server_app, 'load_cached_model_graph', return_value=graph), \
                    mock.patch.object(server, '_build_static_fallback', side_effect=fallback), \
                    mock.patch.object(server, '_schedule_surface_index_idle_load'), \
                    mock.patch.object(server, '_start_runtime_field_registry_prewarm'):
                refreshed = server._initialize_from_source_snapshot(generation=7,
                    initialized_at=server.initialized_at, workspace_root=root,
                    settings_module=None, defer_runtime=False, venv_info=None,
                    source_snapshot=snapshot, started_at=server_app.time.perf_counter(),
                    expected_reindex_serial=0)

            self.assertIsNone(refreshed)
            self.assertIs(server.static_index, latest_index)
            self.assertEqual(server._last_surface_index, {'latest': {}})

    def test_verification_notification_uses_fields_saved_after_refresh(self) -> None:
        server = _make_server(Path('/workspace'))
        server._state_generation = 7
        initialized_state = mock.Mock()
        initialized_state.source_snapshot.fingerprint = 'old-source'
        latest_surface = {'blog.Post': {'instance': {'fresh': ['scalar', None, 'field', 'TextField']}}}

        def refresh(**kwargs):
            server._last_surface_index = latest_surface
            server._reindex_serial += 1
            # Simulate a save after the refresh applies, before notification.
            return mock.Mock(surface_index={'blog.Post': {'instance': {}}})

        with mock.patch.object(server, '_snapshot_sources_for_verification',
                return_value=mock.Mock(fingerprint='changed-source', file_count=1)), \
                mock.patch.object(server_app, 'save_source_snapshot'), \
                mock.patch.object(server, '_initialize_from_source_snapshot', side_effect=refresh), \
                mock.patch.object(server, '_write_notification') as notify:
            server._verify_source_snapshot_state(generation=7, workspace_root=Path('/workspace'),
                settings_module=None, venv_info=None, editable_roots=[], initialized_state=initialized_state)

        notify.assert_called_once()
        self.assertEqual(notify.call_args.args[0], 'surfaceIndexChanged')
        self.assertEqual(notify.call_args.args[1]['surfaceIndex'], latest_surface)

    def test_verification_refresh_preserves_ready_runtime_field_overrides(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _write_blog_models(root)
            path = root / 'blog/models.py'
            path.write_text(path.read_text() + '    body = models.TextField()\n\nclass Archived(models.Model):\n    note = models.TextField()\n')
            original = build_static_index(root)
            runtime = _ready_runtime_with(_runtime_model('blog.Post', 'blog.models',
                [('id', 'BigAutoField'), ('title', 'CharField'), ('body', 'TextField')]),
                _runtime_model('blog.Archived', 'blog.models', [('note', 'TextField')]))
            graph = build_model_graph(original, runtime)
            path.write_text(path.read_text().replace('CharField(max_length=100)', 'DateField()')
                .replace('    body = models.TextField()\n', '').split('\nclass Archived')[0])
            from django_orm_intellisense.static_index.indexer import reindex_single_file
            from django_orm_intellisense.semantic.graph import rebuild_model_graph_for_labels
            edited, _, _ = reindex_single_file(root, path, original)
            graph = rebuild_model_graph_for_labels(graph, old_static_index=original,
                static_index=edited, runtime=runtime, affected_labels={'blog.Post', 'blog.Archived'})
            self.assertEqual(graph.find_field('blog.Post', 'title').field_kind, 'DateField')
            self.assertIsNone(graph.find_field('blog.Post', 'body'))
            self.assertIsNone(graph.node_for_model('blog.Archived'))
            server = _make_server(root)
            server._state_generation = 7
            server.static_index = edited
            server.model_graph = graph
            snapshot = server_app.snapshot_python_sources(root)
            with mock.patch.object(server_app, 'load_cached_static_index', return_value=(edited, 'full')), \
                    mock.patch.object(server_app, 'load_cached_runtime_inspection', return_value=runtime), \
                    mock.patch.object(server_app, 'load_cached_model_graph', return_value=None), \
                    mock.patch.object(server_app, 'save_model_graph') as save_graph, \
                    mock.patch.object(server, '_schedule_surface_index_idle_load'), \
                    mock.patch.object(server, '_start_runtime_field_registry_prewarm'):
                refreshed = server._initialize_from_source_snapshot(generation=7,
                    initialized_at=server.initialized_at, workspace_root=root,
                    settings_module=None, defer_runtime=False, venv_info=None,
                    source_snapshot=snapshot, started_at=server_app.time.perf_counter(),
                    expected_reindex_serial=0)
            self.assertIsNotNone(refreshed)
            self.assertEqual(server.model_graph.find_field('blog.Post', 'title').field_kind, 'DateField')
            self.assertIsNone(server.model_graph.find_field('blog.Post', 'body'))
            self.assertIsNone(server.model_graph.node_for_model('blog.Archived'))
            save_graph.assert_not_called()

    def test_verification_worker_is_spawned_and_scoped_to_one_scan(self) -> None:
        server = _make_server(Path('/workspace'))
        snapshot = mock.Mock()
        with mock.patch.object(server_app, 'ProcessPoolExecutor') as executor:
            worker = executor.return_value.__enter__.return_value
            worker.submit.return_value.result.return_value = snapshot
            actual = server._snapshot_sources_for_verification(Path('/workspace'), [Path('/editable')])
        self.assertIs(actual, snapshot)
        self.assertEqual(executor.call_args.kwargs['max_workers'], 1)
        self.assertEqual(executor.call_args.kwargs['mp_context'].get_start_method(), 'spawn')
        worker.submit.assert_called_once_with(server_app.snapshot_python_sources, Path('/workspace'),
            extra_roots=[Path('/editable')], max_workers=1)
        executor.return_value.__exit__.assert_called_once()

    def test_runtime_warmup_preserves_edits_and_model_deletion_since_initialize(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _write_blog_models(root)
            path = root / 'blog/models.py'
            path.write_text(path.read_text() + '    body = models.TextField()\n\nclass Archived(models.Model):\n    note = models.TextField()\n')
            original = build_static_index(root)
            path.write_text(path.read_text().replace('CharField(max_length=100)', 'DateField()')
                .replace('    body = models.TextField()\n', '').split('\nclass Archived')[0])
            edited = build_static_index(root)
            runtime = _ready_runtime_with(_runtime_model('blog.Post', 'blog.models',
                [('id', 'BigAutoField'), ('title', 'CharField'), ('body', 'TextField')]),
                _runtime_model('blog.Archived', 'blog.models', [('note', 'TextField')]))
            server = _make_server(root)
            server._state_generation = 7
            server.static_index = edited
            server.model_graph = build_model_graph(edited, create_pending_runtime_inspection(None))
            server._source_snapshot_dirty = True
            notifications = []
            patches = _warmup_patches(server, notifications) + [
                mock.patch.object(server_app, 'inspect_runtime', return_value=runtime),
                mock.patch.object(server_app, 'save_model_graph'),
            ]
            with contextlib.ExitStack() as stack:
                mocks = [stack.enter_context(patch) for patch in patches]
                server._warm_runtime_state(generation=7, initialized_at=server.initialized_at,
                    workspace_root=root, workspace_profile=mock.Mock(), static_index=original,
                    runtime_source_fingerprint='initialize-source', settings_module='project.settings',
                    source_snapshot=mock.Mock(fingerprint='initialize-source',
                        files=tuple(Path(module.file_path) for module in original.modules.values())))
            self.assertEqual(server.model_graph.find_field('blog.Post', 'title').field_kind, 'DateField')
            self.assertIsNone(server.model_graph.find_field('blog.Post', 'body'))
            self.assertIsNone(server.model_graph.node_for_model('blog.Archived'))
            mocks[0].assert_not_called()  # The runtime summary does not match the old source fingerprint.
            mocks[-1].assert_not_called()

    def test_verification_falls_back_when_process_creation_is_unavailable(self) -> None:
        server = _make_server(Path('/workspace'))
        with mock.patch.object(server_app, 'ProcessPoolExecutor', side_effect=OSError('no semaphores')), \
                mock.patch.object(server_app, 'snapshot_python_sources', return_value=mock.sentinel.snapshot) as snapshot:
            result = server._snapshot_sources_for_verification(Path('/workspace'), [])
        self.assertIs(result, mock.sentinel.snapshot)
        snapshot.assert_called_once_with(Path('/workspace'), extra_roots=None, max_workers=1)

    def test_fieldless_surface_entry_does_not_hide_static_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_blog_models(root)
            static_index = build_static_index(root)
            graph = build_model_graph(
                static_index,
                create_pending_runtime_inspection('project.settings'),
            )
            server = _make_server(root)

            fallback = server._build_static_fallback(
                model_graph=graph,
                surface_index={
                    'blog.Post': {
                        'model_class': {
                            'objects': ['manager', 'blog.Post', 'manager', None],
                        },
                    },
                },
            )

        self.assertIsNotNone(fallback)
        assert fallback is not None
        self.assertIn('blog.Post', fallback)
        self.assertIn('title', fallback['blog.Post']['fields'])

    def test_populated_surface_entry_still_suppresses_static_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_blog_models(root)
            static_index = build_static_index(root)
            graph = build_model_graph(
                static_index,
                create_pending_runtime_inspection('project.settings'),
            )
            server = _make_server(root)

            fallback = server._build_static_fallback(
                model_graph=graph,
                surface_index={
                    'blog.Post': {
                        'instance': {
                            'title': ['scalar', None, 'field', 'CharField'],
                        },
                    },
                },
            )

        self.assertFalse(fallback and 'blog.Post' in fallback)

    def test_runtime_warmup_pushes_runtime_static_fallback(self) -> None:
        static_index = _inheritance_only_static_index()
        runtime = _ready_runtime()
        workspace_root = Path('/workspace')
        server = _make_server(workspace_root)
        server._state_generation = 7
        server._last_surface_index = {}

        notifications: list[tuple[str, dict]] = []
        source_snapshot = mock.Mock(fingerprint='source-fp',
            files=tuple(Path(module.file_path) for module in static_index.modules.values()))

        with mock.patch.object(server_app, 'inspect_runtime', return_value=runtime), \
                mock.patch.object(server_app, 'save_runtime_inspection'), \
                mock.patch.object(server_app, 'save_model_graph'), \
                mock.patch.object(server_app, 'build_semantic_graph', return_value=mock.Mock()), \
                mock.patch.object(
                    server_app,
                    'build_health_snapshot',
                    return_value={'phase': 'ready'},
                ), \
                mock.patch.object(server, '_schedule_surface_index_idle_load'), \
                mock.patch.object(
                    server,
                    '_write_notification',
                    side_effect=lambda event, params: notifications.append((event, params)),
                ):
            server._warm_runtime_state(
                generation=7,
                initialized_at=server.initialized_at,
                workspace_root=workspace_root,
                workspace_profile=mock.Mock(),
                static_index=static_index,
                runtime_source_fingerprint='runtime-fp',
                settings_module='project.settings',
                source_snapshot=source_snapshot,
            )

        surface_events = [
            params for event, params in notifications
            if event == 'surfaceIndexChanged'
        ]
        self.assertEqual(len(surface_events), 1, notifications)
        payload = surface_events[0]
        self.assertEqual(payload['health'], {'phase': 'ready'})
        self.assertEqual(payload['surfaceIndex'], {})
        static_fallback = payload['staticFallback']
        self.assertIsNotNone(static_fallback)
        self.assertIn('title', static_fallback['blog.Post']['fields'])
        self.assertEqual(
            payload['staticFallbackFingerprint'],
            server._last_static_fallback_fingerprint,
        )

    def test_runtime_only_models_get_flagged_fallback_entries(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            server, _models_path = _label_split_server(root)
        runtime = _ready_runtime_with(
            _runtime_model(
                'db.Company',
                'zuzu.models',
                [('id', 'BigAutoField'), ('name', 'CharField')],
            ),
            _runtime_model(
                'authtoken.Token',
                'rest_framework.authtoken.models',
                [('key', 'CharField'), ('created', 'DateTimeField')],
            ),
        )
        graph = build_model_graph(server.static_index, runtime)

        fallback = server._build_static_fallback(model_graph=graph, surface_index={})

        assert fallback is not None
        self.assertIn('key', fallback['authtoken.Token']['fields'])
        self.assertIs(fallback['authtoken.Token'].get('runtimeOnly'), True)
        self.assertIn('name', fallback['db.Company']['fields'])
        self.assertNotIn('runtimeOnly', fallback['db.Company'])

    def test_runtime_warmup_builds_from_latest_static_index(self) -> None:
        initialize_static_index = _inheritance_only_static_index()
        reindexed_static_index = _inheritance_only_static_index()
        server = _make_server(Path('/workspace'))
        server._state_generation = 7
        server.static_index = reindexed_static_index
        # A reindex during warm-up built this slice against the pending runtime.
        server._last_surface_index = {
            'blog.Post': {
                'instance': {'id': ['scalar', None, 'field', 'BigAutoField']},
            },
        }
        server._source_snapshot_dirty = True
        notifications: list[tuple[str, dict]] = []
        graph_inputs: list[StaticIndex] = []

        def _record_graph(static_index, runtime):
            graph_inputs.append(static_index)
            return build_model_graph(static_index, runtime)

        patches = _warmup_patches(server, notifications) + [
            mock.patch.object(server_app, 'inspect_runtime', return_value=_ready_runtime()),
            mock.patch.object(server_app, 'build_model_graph', side_effect=_record_graph),
            mock.patch.object(server_app, 'save_model_graph'),
        ]
        with contextlib.ExitStack() as stack:
            mocks = [stack.enter_context(patch) for patch in patches]
            save_model_graph = mocks[-1]
            server._warm_runtime_state(
                generation=7,
                initialized_at=server.initialized_at,
                workspace_root=Path('/workspace'),
                workspace_profile=mock.Mock(),
                static_index=initialize_static_index,
                runtime_source_fingerprint='runtime-fp',
                settings_module='project.settings',
                source_snapshot=mock.Mock(fingerprint='source-fp',
                    files=tuple(Path(module.file_path) for module in initialize_static_index.modules.values())),
            )

        self.assertEqual(graph_inputs, [reindexed_static_index])
        self.assertIs(server.static_index, reindexed_static_index)
        self.assertEqual(server._last_surface_index, {})
        # The graph no longer matches the initialize-time source fingerprint.
        save_model_graph.assert_not_called()
        (event, payload), = notifications
        self.assertEqual(event, 'surfaceIndexChanged')
        self.assertEqual(payload['surfaceIndex'], {})
        self.assertIn('title', payload['staticFallback']['blog.Post']['fields'])

    def test_reindex_delta_is_keyed_by_surface_label(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            server, models_path = _label_split_server(root)
            self.assertIn('db.Company', server._last_surface_index)
            models_path.write_text(_ZUZU_MODELS_WITH_CODE)

            result = server._reindex_file({'filePath': str(models_path)})

        self.assertNotIn('unchanged', result)
        self.assertIn('db.Company', result['surfaceIndexDelta'])
        self.assertIn('code', result['surfaceIndexDelta']['db.Company']['instance'])
        self.assertEqual(result['removedLabels'], [])
        self.assertEqual(result['changedLabels'], ['db.Company'])
        self.assertNotIn('zuzu.Company', server._last_surface_index)
        self.assertIn('code', server._last_surface_index['db.Company']['instance'])
        self.assertEqual(server._reindexed_labels.get('zuzu.Company'), 1)
        self.assertTrue(server._source_snapshot_dirty)

    def test_reindex_retries_when_warmup_lands_mid_compute(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            server, models_path = _label_split_server(root)
            models_path.write_text(_ZUZU_MODELS_WITH_CODE)
            warmed_runtime = _ready_runtime_with(
                _runtime_model(
                    'db.Company',
                    'zuzu.models',
                    [('id', 'BigAutoField'), ('name', 'CharField')],
                )
            )
            warmed_graph = build_model_graph(server.static_index, warmed_runtime)
            real_rebuild = server_app.rebuild_surface_for_models
            runtimes_seen: list[RuntimeInspection] = []

            def _rebuild(static_index, runtime, model_graph, labels, existing, **owner_context):
                runtimes_seen.append(runtime)
                if len(runtimes_seen) == 1:
                    # Warm-up applies its state while this reindex computes.
                    server.runtime_inspection = warmed_runtime
                    server.model_graph = warmed_graph
                    server._last_surface_index = {}
                return real_rebuild(static_index, runtime, model_graph, labels, existing, **owner_context)

            with mock.patch.object(server_app, 'rebuild_surface_for_models', side_effect=_rebuild):
                result = server._reindex_file({'filePath': str(models_path)})

        self.assertEqual(len(runtimes_seen), 2)
        self.assertIs(runtimes_seen[1], warmed_runtime)
        self.assertIs(server.runtime_inspection.model_catalog, warmed_runtime.model_catalog)
        self.assertEqual(server.runtime_inspection.bootstrap_status, warmed_runtime.bootstrap_status)
        self.assertIn('db.Company', result['surfaceIndexDelta'])
        self.assertEqual(result['addedLabels'], ['db.Company'])
        self.assertEqual(list(server._last_surface_index), ['db.Company'])

    def test_loaded_surface_keeps_models_reindexed_during_prebuild(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            server, models_path = _label_split_server(root)
            built_from_static_index = server.static_index
            built_from_model_graph = server.model_graph
            prebuilt_surface = dict(server._last_surface_index)

            models_path.write_text(_ZUZU_MODELS_WITH_CODE)
            server._reindex_file({'filePath': str(models_path)})
            with server._state_lock:
                server._commit_loaded_surface_index(
                    prebuilt_surface,
                    surface_fingerprints=fingerprint_surface_index(prebuilt_surface),
                    static_fallback=None,
                    built_from_static_index=built_from_static_index,
                    built_from_model_graph=built_from_model_graph,
                    built_at_serial=0,
                )

        self.assertNotIn('code', prebuilt_surface['db.Company']['instance'])
        self.assertIn('code', server._last_surface_index['db.Company']['instance'])
        self.assertEqual(
            server._last_surface_fingerprints,
            fingerprint_surface_index(server._last_surface_index),
        )

    def test_surface_load_resends_when_a_reindex_commits_meanwhile(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            server, _models_path = _label_split_server(root)
            server._state_generation = 3
            server.source_snapshot = server_app.snapshot_python_sources(root)
            server.health_snapshot = {'phase': 'ready'}
            loaded_surface = dict(server._last_surface_index)
            server._last_surface_index = {}
            notifications: list[dict] = []
            second_sent = threading.Event()

            def _notify(event, params, **send_context):
                notifications.append(params)
                if len(notifications) == 1:
                    # A reindex commits between our snapshot and this write.
                    with server._state_lock:
                        server._reindex_serial += 1
                else:
                    second_sent.set()

            with _persisted_surface_cache(server, loaded_surface), \
                    mock.patch.object(server, '_write_notification', side_effect=_notify):
                server._start_surface_index_prebuild_for_current_state(reason='test')
                self.assertTrue(second_sent.wait(5), notifications)

        self.assertEqual(len(notifications), 2)
        self.assertIn('db.Company', notifications[1]['surfaceIndex'])

    def test_loaded_surface_reuses_already_committed_canonical_entries(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            server, path = _label_split_server(root)
            original_index = server.static_index
            original_graph = server.model_graph
            prebuilt = dict(server._last_surface_index)
            prebuilt_fingerprints = fingerprint_surface_index(prebuilt)
            path.write_text(_ZUZU_MODELS_WITH_CODE)
            server._reindex_file({'filePath': str(path)})
            current_entry = server._last_surface_index['db.Company']
            current_fingerprint = server._last_surface_fingerprints['db.Company']
            with mock.patch.object(server_app, '_rebuild_surface_slice',
                    side_effect=AssertionError('Committed surface rebuilt during adoption')):
                with server._state_lock:
                    server._commit_loaded_surface_index(prebuilt,
                        surface_fingerprints=prebuilt_fingerprints, static_fallback=None,
                        built_from_static_index=original_index, built_from_model_graph=original_graph,
                        built_at_serial=0)
            self.assertIs(server._last_surface_index['db.Company'], current_entry)
            self.assertEqual(server._last_surface_fingerprints['db.Company'], current_fingerprint)
            self.assertNotIn('code', prebuilt['db.Company']['instance'])
            self.assertEqual(server._last_surface_fingerprints,
                             fingerprint_surface_index(server._last_surface_index))

    def test_loaded_surface_does_not_rehash_unchanged_published_lookup_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            server, _ = _label_split_server(Path(tmp).resolve())
            def adopt():
                with server._state_lock:
                    server._commit_loaded_surface_index(dict(server._last_surface_index),
                        surface_fingerprints=dict(server._last_surface_fingerprints),
                        static_fallback=server._last_static_fallback,
                        built_from_static_index=server.static_index,
                        built_from_model_graph=server.model_graph, built_at_serial=server._reindex_serial)
            adopt()
            previous = server._last_custom_lookups_fingerprint
            fingerprint = server_app.fingerprint_json_payload
            def guarded_fingerprint(payload):
                self.assertFalse(isinstance(payload, list) and len(payload) == 2
                    and payload[0] is server.runtime_inspection.custom_lookups
                    and payload[1] is server.runtime_inspection.lookup_catalog,
                    'Unchanged published lookup metadata fully serialized')
                return fingerprint(payload)
            with mock.patch.object(server_app, 'fingerprint_json_payload', guarded_fingerprint):
                adopt()
            self.assertEqual(server._last_custom_lookups_fingerprint, previous)


    def test_loaded_surface_overlay_preserves_rename_and_delete_tombstones(self) -> None:
        for declaration in ('renamed', 'deleted', 'abstract'):
            with self.subTest(declaration=declaration), tempfile.TemporaryDirectory() as tmp:
                server, path = _label_split_server(Path(tmp).resolve())
                original_index, original_graph = server.static_index, server.model_graph
                prebuilt = dict(server._last_surface_index)
                if declaration == 'renamed':
                    path.write_text(_ZUZU_MODELS.replace('class Company(', 'class Renamed('))
                elif declaration == 'deleted':
                    path.unlink()
                else:
                    path.write_text(_ZUZU_MODELS + '\n    class Meta:\n        abstract = True\n')
                server._reindex_file({'filePath': str(path)})
                expected = dict(server._last_surface_index)
                expected_fingerprints = dict(server._last_surface_fingerprints)
                with mock.patch.object(server_app, '_rebuild_surface_slice',
                        side_effect=AssertionError('Published rename/delete rebuilt')):
                    with server._state_lock:
                        server._commit_loaded_surface_index(prebuilt,
                            surface_fingerprints=fingerprint_surface_index(prebuilt),
                            static_fallback=None, built_from_static_index=original_index,
                            built_from_model_graph=original_graph, built_at_serial=0)
                self.assertEqual(server._last_surface_index, expected)
                self.assertEqual(server._last_surface_fingerprints, expected_fingerprints)
                self.assertNotIn('db.Company', server._last_surface_index)
                self.assertEqual(server._last_surface_fingerprints,
                                 fingerprint_surface_index(server._last_surface_index))

    def test_loaded_surface_rebuilds_missing_or_unfingerprinted_committed_entries(self) -> None:
        for missing in ('surface', 'fingerprint'):
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as tmp:
                server, path = _label_split_server(Path(tmp).resolve())
                original_index, original_graph = server.static_index, server.model_graph
                prebuilt = dict(server._last_surface_index)
                path.write_text(_ZUZU_MODELS_WITH_CODE)
                server._reindex_file({'filePath': str(path)})
                expected = dict(server._last_surface_index)
                if missing == 'surface':
                    # Runtime warm-up drops entries computed while pending.
                    server._last_surface_index = {}
                    server._last_surface_fingerprints = {}
                else:
                    server._last_surface_fingerprints = {}
                with mock.patch.object(server_app, '_rebuild_surface_slice',
                        wraps=server_app._rebuild_surface_slice) as rebuild:
                    with server._state_lock:
                        server._commit_loaded_surface_index(prebuilt,
                            surface_fingerprints=fingerprint_surface_index(prebuilt),
                            static_fallback=None, built_from_static_index=original_index,
                            built_from_model_graph=original_graph, built_at_serial=0)
                self.assertEqual(rebuild.call_count, 1)
                self.assertEqual(server._last_surface_index, expected)
                self.assertEqual(server._last_surface_fingerprints,
                                 fingerprint_surface_index(server._last_surface_index))

    def test_loaded_surface_retains_a_published_empty_concrete_entry(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            server, path = _label_split_server(Path(tmp).resolve())
            original_index, original_graph = server.static_index, server.model_graph
            prebuilt = dict(server._last_surface_index)
            path.write_text(_ZUZU_MODELS_WITH_CODE)
            server._reindex_file({'filePath': str(path)})
            server._last_surface_index = {'db.Company': {}}
            server._last_surface_fingerprints = fingerprint_surface_index(server._last_surface_index)
            entry = server._last_surface_index['db.Company']
            with mock.patch.object(server_app, '_rebuild_surface_slice',
                    side_effect=AssertionError('Valid empty entry rebuilt')):
                with server._state_lock:
                    server._commit_loaded_surface_index(prebuilt,
                        surface_fingerprints=fingerprint_surface_index(prebuilt),
                        static_fallback=None, built_from_static_index=original_index,
                        built_from_model_graph=original_graph, built_at_serial=0)
            self.assertIs(server._last_surface_index['db.Company'], entry)
            self.assertIn('code', server._last_static_fallback['db.Company']['fields'])

    def test_lookup_fingerprint_retires_replaced_metadata_and_preserves_commit_revision(self) -> None:
        from dataclasses import replace
        with tempfile.TemporaryDirectory() as tmp:
            server, path = _label_split_server(Path(tmp).resolve())
            server._refresh_lookup_fingerprint()
            first = server._last_custom_lookups_fingerprint
            server.runtime_inspection = replace(server.runtime_inspection,
                lookup_catalog={'types': {'new': {'fieldKind': 'TextField'}}})
            server._refresh_lookup_fingerprint()
            second = server._last_custom_lookups_fingerprint
            self.assertNotEqual(second, first)
            server.runtime_inspection = replace(server.runtime_inspection,
                custom_lookups={'CharField': ['new_lookup']})
            server._refresh_lookup_fingerprint()
            self.assertNotEqual(server._last_custom_lookups_fingerprint, second)
            previous_index, previous_graph = server.static_index, server.model_graph
            previous_surface = server._last_surface_index
            path.write_text(_ZUZU_MODELS_WITH_CODE)
            outcome = server._compute_reindex(file_path=path, static_index=previous_index,
                runtime=server.runtime_inspection, previous_model_graph=previous_graph,
                existing_surface=previous_surface, previous_static_fallback=server._last_static_fallback)
            outcome.lookup_catalog_delta = {'db.Company': {'types': {},
                'fields': {'db.Company': {}}, 'expressionFields': {}, 'relationPaths': {}}}
            with server._state_lock:
                server._commit_reindex(outcome)
            revision = server._last_custom_lookups_fingerprint
            with mock.patch.object(server_app, 'fingerprint_json_payload',
                    side_effect=AssertionError('Current catalogue revision rehashed')):
                server._refresh_lookup_fingerprint()
            self.assertEqual(server._last_custom_lookups_fingerprint, revision)

    def test_foreground_response_can_write_while_surface_compression_is_pending(self) -> None:
        import io
        from concurrent.futures import ThreadPoolExecutor
        from django_orm_intellisense.server.ipc_encoding import _JsonGzipSink
        server = _make_server(Path('/workspace'))
        server._real_stdout = io.StringIO()
        compressing = threading.Event()
        resume = threading.Event()
        response_written = threading.Event()
        compress = _JsonGzipSink._compress
        def delayed_compress(sink, text):
            compressing.set()
            self.assertTrue(resume.wait(5))
            return compress(sink, text)
        def response():
            server._write_response(42, {'foreground': True})
            response_written.set()
        with mock.patch.object(server_app, '_IPC_COMPRESS_MIN_KB', 1), \
                mock.patch.object(_JsonGzipSink, '_compress', delayed_compress):
            with ThreadPoolExecutor(max_workers=2) as pool:
                background = pool.submit(server._write_notification, 'surfaceIndexChanged', {'text': 'x' * 2048})
                try:
                    self.assertTrue(compressing.wait(5))
                    foreground = pool.submit(response)
                    wrote_before_resume = response_written.wait(1)
                finally:
                    resume.set()
                background.result(timeout=5)
                foreground.result(timeout=5)
        self.assertTrue(wrote_before_resume, 'Foreground response waited for background compression')
        lines = server._real_stdout.getvalue().splitlines()
        self.assertEqual(len(lines), 2)
        self.assertEqual(__import__('json').loads(lines[0])['id'], 42)

    def test_surface_notification_skips_a_snapshot_changed_during_encoding(self) -> None:
        import io
        import json
        with tempfile.TemporaryDirectory() as tmp:
            server, path = _label_split_server(Path(tmp).resolve())
            server._real_stdout = io.StringIO()
            server._state_generation = 3
            server.health_snapshot = {'phase': 'ready'}
            loaded_surface = dict(server._last_surface_index)
            server._last_surface_index = {}
            compress = server_app.encode_ipc_message
            changed = []
            def reindex_during_encoding(payload, *args, **kwargs):
                if payload.get('event') == 'surfaceIndexChanged' and not changed:
                    changed.append(True)
                    path.write_text(_ZUZU_MODELS_WITH_CODE)
                    server._reindex_file({'filePath': str(path)})
                return compress(payload, *args, **kwargs)
            with _persisted_surface_cache(server, loaded_surface), \
                    mock.patch.object(server_app, 'encode_ipc_message', reindex_during_encoding):
                server._start_surface_index_prebuild_for_current_state(reason='test')
                worker = server._surface_prebuild_future
                if worker is not None:
                    worker.join(5)
                    self.assertFalse(worker.is_alive())
                retry = server._surface_publish_retry_timer
                if retry is not None:
                    retry.join(5)
                    self.assertFalse(retry.is_alive())
            notifications = [json.loads(line) for line in server._real_stdout.getvalue().splitlines()]
            self.assertTrue(notifications)
            for notification in notifications:
                self.assertIn('code', notification['params']['surfaceIndex']['db.Company']['instance'],
                    'Encoded older snapshot rolled back a completed save')

    def test_surface_publication_retry_survives_multiple_encoding_edit_bursts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            server, _ = _label_split_server(Path(tmp).resolve())
            server._state_generation = 3
            prepare = server._prepare_message
            encoded = []
            sent = threading.Event()
            def changing_prepare(payload):
                prepared = prepare(payload)
                encoded.append(1)
                if len(encoded) <= 7:
                    with server._state_lock:
                        server._reindex_serial += 1
                return prepared
            with mock.patch.object(server, '_prepare_message', changing_prepare), \
                    mock.patch.object(server, '_write_notification', side_effect=lambda *a, **k: sent.set()):
                server._publish_current_surface_snapshot(3)
                self.assertTrue(sent.wait(5), 'Retry was lost after another edit burst')
                timer = server._surface_publish_retry_timer
                if timer is not None:
                    timer.join(5)
                    self.assertFalse(timer.is_alive())
            self.assertEqual(len(encoded), 8)
            self.assertIsNone(server._surface_publish_retry_timer)
            self.assertIsNone(server._surface_publish_retry_generation)

    def test_surface_publication_discards_encoded_data_from_an_older_generation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            server, _ = _label_split_server(Path(tmp).resolve())
            server._state_generation = 3
            prepare = server._prepare_message
            def old_generation(payload):
                prepared = prepare(payload)
                with server._state_lock:
                    server._state_generation = 4
                return prepared
            with mock.patch.object(server, '_prepare_message', old_generation), \
                    mock.patch.object(server, '_write_notification') as notify:
                server._publish_current_surface_snapshot(3)
            notify.assert_not_called()
            self.assertIsNone(server._surface_publish_retry_timer)

    def test_prepared_json_preserves_catalogue_unicode_and_compression_roundtrip(self) -> None:
        import base64
        import gzip
        import io
        import json
        from django_orm_intellisense.runtime.lookup_catalog import LookupTypeTable, lookup_catalog_json_default
        server = _make_server(Path('/workspace'))
        server._real_stdout = io.StringIO()
        payload = {'event': 'surfaceIndexChanged', 'params': {
            'label': '한글 🐍', 'types': LookupTypeTable({'base': {'fieldKind': 'CharField',
                'transforms': {}, 'lookups': {'exact': '문자열'}}})}}
        expected = json.dumps(payload, sort_keys=True, default=lookup_catalog_json_default)
        with mock.patch.object(server_app, '_IPC_COMPRESS_MIN_KB', 0):
            prepared = server._prepare_message(payload)
            self.assertEqual(prepared.line, expected)
        with mock.patch.object(server_app, '_IPC_COMPRESS_MIN_KB', 1):
            payload['params']['padding'] = 'x' * 2048
            prepared = server._prepare_message(payload)
            server._write_message(payload, prepared_message=prepared)
        envelope = json.loads(server._real_stdout.getvalue())
        self.assertEqual(envelope['_enc'], 'gzip+b64')
        actual = json.loads(gzip.decompress(base64.b64decode(envelope['data'])))
        self.assertEqual(actual, json.loads(json.dumps(payload, default=lookup_catalog_json_default)))

    def test_recent_saves_coalesce_snapshot_preparation_until_idle(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            server, _ = _label_split_server(Path(tmp).resolve())
            server._state_generation = 3
            server._last_reindex_commit_at = 100.0
            with mock.patch.object(server_app.time, 'perf_counter', return_value=100.0), \
                    mock.patch.object(server, '_prepare_message') as prepare, \
                    mock.patch.object(server, '_schedule_surface_snapshot_retry') as schedule:
                server._publish_current_surface_snapshot(3)
            prepare.assert_not_called()
            self.assertEqual(schedule.call_args.args, (3,))
            self.assertAlmostEqual(schedule.call_args.kwargs['delay_seconds'], 0.2)
            current = server._last_surface_index
            with mock.patch.object(server_app.time, 'perf_counter', return_value=100.25), \
                    mock.patch.object(server, '_write_notification') as notify:
                server._publish_current_surface_snapshot(3)
            notify.assert_called_once()
            self.assertIs(notify.call_args.args[1]['surfaceIndex'], current)

    def test_stopped_daemon_discards_pending_surface_publication_retry(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            server, _ = _label_split_server(Path(tmp).resolve())
            server._state_generation = 3
            with mock.patch.object(server, '_write_notification') as notify:
                server._schedule_surface_snapshot_retry(3)
                timer = server._surface_publish_retry_timer
                server._stopping.set()
                timer.join(5)
                self.assertFalse(timer.is_alive())
            notify.assert_not_called()
            self.assertIsNone(server._surface_publish_retry_timer)

if __name__ == '__main__':
    unittest.main()
