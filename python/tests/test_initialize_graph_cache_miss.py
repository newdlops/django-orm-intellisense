"""Cached summaries cannot prepare Django on a deferred graph-cache miss."""
import contextlib
import dataclasses
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from django_orm_intellisense.cache import store
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.runtime import inspector
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.server import app
from django_orm_intellisense.static_index.indexer import build_static_index
from tests.test_static_fallback_surface_gap import _make_server, _ready_runtime_with, _runtime_model


class InitializeGraphCacheMissTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='djls-cached-graph-miss-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve() / 'project'
        self.root.mkdir()
        (self.root/'models.py').write_text('from django.db import models\nclass Post(models.Model):\n'
            '    key=models.UUIDField(primary_key=True)\n    marker="한😀"; title=models.CharField()\n')
        self.static = build_static_index(self.root)
        self.snapshot = snapshot_python_sources(self.root)
        self.runtime = dataclasses.replace(_ready_runtime_with(_runtime_model('models.Post', 'models',
            [('key','UUIDField'),('title','CharField')])), settings_module='test_settings')
        self.stack = contextlib.ExitStack(); self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.object(store, '_workspace_cache_dir', return_value=self.root.parent/'cache'))
        store.save_static_index(self.root, self.snapshot, self.static)
        source = app._runtime_source_fingerprint(source_snapshot=self.snapshot, static_index=self.static,
            settings_module=self.runtime.settings_module)
        store.save_runtime_inspection(self.root, source, self.runtime.settings_module, self.runtime)
        self.runtime_fingerprint = app._runtime_cache_fingerprint(self.runtime, source_fingerprint=source)
        self.runtime_path = store._workspace_cache_dir(self.root)/store.RUNTIME_CACHE_NAME
        self.runtime_before = self.runtime_path.read_bytes()
        self.server = _make_server(self.root)
        self.warmup = self.stack.enter_context(mock.patch.object(self.server, '_start_runtime_warmup'))
        self.stack.enter_context(mock.patch.object(self.server, '_start_runtime_field_registry_prewarm'))
        self.stack.enter_context(mock.patch.object(self.server, '_schedule_surface_index_idle_load'))
        self.save_graph = self.stack.enter_context(mock.patch.object(app, 'save_model_graph', wraps=store.save_model_graph))
        self.build = self.stack.enter_context(mock.patch.object(app, 'build_model_graph', wraps=build_model_graph))
        self.ready = self.stack.enter_context(mock.patch.object(inspector, 'runtime_field_registry_is_ready', return_value=False))
        self.ensure = self.stack.enter_context(mock.patch.object(inspector, '_ensure_runtime_field_registry',
            side_effect=AssertionError('Foreground registry preparation on deferred graph miss')))

    def initialize(self, defer=True):
        return self.server._initialize({'workspaceRoot':str(self.root), 'settingsModule':self.runtime.settings_module,
            'deferRuntime':defer})

    def test_missing_graph_uses_pending_runtime_and_existing_warmup_without_preparation(self):
        result = self.initialize()
        self.ensure.assert_not_called()
        self.assertEqual(self.server.runtime_inspection.bootstrap_status, 'warming_up')
        self.assertEqual(self.build.call_args.args[1].bootstrap_status, 'warming_up')
        self.assertEqual(result['health']['runtime']['bootstrapStatus'], 'warming_up')
        self.assertIsNone(result['sourceProvenance'])
        self.assertEqual(result['surfaceIndex'], {})
        self.assertEqual(result['surfaceFingerprints'], {})
        self.warmup.assert_called_once()
        self.save_graph.assert_not_called()
        self.assertEqual(self.runtime_path.read_bytes(), self.runtime_before)
        self.assertEqual(self.server.model_graph.find_field('models.Post','pk').field_kind, 'UUIDField')
        self.assertNotIn('id', self.server.model_graph.fields_by_model_label['models.Post'])

    def test_valid_graph_cache_keeps_ready_metadata_and_no_warmup_or_registry_probe(self):
        with mock.patch('django_orm_intellisense.semantic.graph.get_runtime_field', return_value=None):
            graph = build_model_graph(self.static, self.runtime)
        store.save_model_graph(self.root, self.snapshot.fingerprint, self.runtime_fingerprint, graph)
        result = self.initialize()
        self.assertEqual(self.server.runtime_inspection.bootstrap_status, 'ready')
        self.assertEqual(store._model_graph_to_cache_dict(self.server.model_graph), store._model_graph_to_cache_dict(graph))
        self.assertEqual(result['health']['runtime']['bootstrapStatus'], 'ready')
        self.build.assert_not_called(); self.warmup.assert_not_called()
        self.ensure.assert_not_called(); self.ready.assert_not_called(); self.save_graph.assert_not_called()
        self.assertEqual(self.runtime_path.read_bytes(), self.runtime_before)

    def test_already_prepared_registry_builds_the_complete_ready_graph(self):
        self.ready.return_value = True
        self.ensure.side_effect = None
        self.initialize()
        self.assertEqual(self.build.call_args.args[1], self.runtime)
        self.assertEqual(self.server.runtime_inspection.bootstrap_status, 'ready')
        self.warmup.assert_not_called(); self.save_graph.assert_called_once()

    def test_explicit_synchronous_initialization_keeps_the_existing_ready_path(self):
        self.ensure.side_effect = None
        self.initialize(defer=False)
        self.assertEqual(self.build.call_args.args[1], self.runtime)
        self.assertEqual(self.server.runtime_inspection.bootstrap_status, 'ready')
        self.warmup.assert_not_called(); self.ready.assert_not_called(); self.save_graph.assert_called_once()


if __name__ == '__main__':
    unittest.main()
