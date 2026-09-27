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
    server._last_surface_index = surface
    server._last_surface_fingerprints = fingerprint_surface_index(surface)
    server._last_static_fallback = server._build_static_fallback(
        model_graph=graph,
        surface_index=surface,
    )
    return server, models_path


class StaticFallbackSurfaceGapTest(unittest.TestCase):
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
        source_snapshot = mock.Mock(fingerprint='source-fp')

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
                source_snapshot=mock.Mock(fingerprint='source-fp'),
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

            def _rebuild(static_index, runtime, model_graph, labels, existing):
                runtimes_seen.append(runtime)
                if len(runtimes_seen) == 1:
                    # Warm-up applies its state while this reindex computes.
                    server.runtime_inspection = warmed_runtime
                    server.model_graph = warmed_graph
                    server._last_surface_index = {}
                return real_rebuild(static_index, runtime, model_graph, labels, existing)

            with mock.patch.object(server_app, 'rebuild_surface_for_models', side_effect=_rebuild):
                result = server._reindex_file({'filePath': str(models_path)})

        self.assertEqual(len(runtimes_seen), 2)
        self.assertIs(runtimes_seen[1], warmed_runtime)
        self.assertIs(server.runtime_inspection, warmed_runtime)
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
            server.source_snapshot = mock.Mock(fingerprint='source-fp')
            server.health_snapshot = {'phase': 'ready'}
            loaded_surface = dict(server._last_surface_index)
            server._last_surface_index = {}
            notifications: list[dict] = []
            second_sent = threading.Event()

            def _notify(event, params):
                notifications.append(params)
                if len(notifications) == 1:
                    # A reindex commits between our snapshot and this write.
                    with server._state_lock:
                        server._reindex_serial += 1
                else:
                    second_sent.set()

            with mock.patch.object(
                server_app, 'load_cached_surface_index', return_value=loaded_surface,
            ), mock.patch.object(server, '_write_notification', side_effect=_notify):
                server._start_surface_index_prebuild_for_current_state(reason='test')
                self.assertTrue(second_sent.wait(5), notifications)

        self.assertEqual(len(notifications), 2)
        self.assertIn('db.Company', notifications[1]['surfaceIndex'])


if __name__ == '__main__':
    unittest.main()
