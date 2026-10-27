"""Initialization must not publish cache/runtime data under stale source identity."""
import contextlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from django_orm_intellisense.cache import save_model_graph, save_runtime_inspection, save_static_index
from django_orm_intellisense.discovery.workspace import EditableInstall, VenvInfo, snapshot_python_sources
from django_orm_intellisense.server import app
from django_orm_intellisense.static_index.indexer import build_static_index
from tests.test_static_fallback_surface_gap import _make_server, _ready_runtime, _write_blog_models


class InitializeSourceStabilityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='djls-source-stability-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.root = self.base / 'workspace'
        self.root.mkdir()
        _write_blog_models(self.root)
        self.source = self.root / 'blog' / 'models.py'
        self.server = _make_server(self.root)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.dict(os.environ, {
            'DJANGO_ORM_INTELLISENSE_CACHE_DIR': str(self.base / 'cache')}))
        for name in ['_start_runtime_warmup', '_start_runtime_field_registry_prewarm',
                     '_schedule_surface_index_idle_load']:
            self.stack.enter_context(mock.patch.object(self.server, name))

    def edit(self, source=None):
        source = source or self.source
        stamp = source.stat()
        text = source.read_text()
        old, new = ('CharField', 'DateField') if 'CharField' in text else ('DateField', 'CharField')
        source.write_text(text.replace(old, new))
        os.utime(source, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))

    def save(self, extra_roots=None):
        before = snapshot_python_sources(self.root, extra_roots, max_workers=1)
        save_static_index(self.root, before, build_static_index(self.root, before.files))
        return before

    def save_ready_caches(self):
        snapshot = snapshot_python_sources(self.root, max_workers=1)
        static_index = build_static_index(self.root, snapshot.files)
        save_static_index(self.root, snapshot, static_index)
        runtime = _ready_runtime()
        runtime_fingerprint = app._runtime_source_fingerprint(
            source_snapshot=snapshot,
            static_index=static_index,
            settings_module=runtime.settings_module,
        )
        save_runtime_inspection(
            self.root, runtime_fingerprint, runtime.settings_module, runtime)
        model_graph = app.build_model_graph(static_index, runtime)
        save_model_graph(
            self.root, snapshot.fingerprint,
            app._runtime_cache_fingerprint(runtime, source_fingerprint=runtime_fingerprint), model_graph)
        return snapshot

    def initialize(self):
        return self.server._initialize({'workspaceRoot': str(self.root), 'deferRuntime': True})

    def test_same_size_cached_edit_after_scan_is_retried_before_runtime_and_first_response(self):
        self.save()
        scans = []

        def scan(*args, **kwargs):
            result = snapshot_python_sources(*args, **kwargs)
            scans.append(result)
            if len(scans) == 1:
                self.edit()
            return result

        with mock.patch.object(app, 'snapshot_python_sources', side_effect=scan):
            result = self.initialize()
        self.assertEqual(result['staticFallback']['blog.Post']['fieldDetails']['title']['fieldKind'], 'DateField')
        self.assertEqual(self.server.source_snapshot.fingerprint,
                         snapshot_python_sources(self.root).fingerprint)
        self.assertEqual(self.server.static_index.to_cache_dict(), build_static_index(self.root).to_cache_dict())

    def test_ready_runtime_cache_hit_uses_initial_and_final_source_scans_only(self):
        self.save_ready_caches()
        with mock.patch.object(app, 'snapshot_python_sources', wraps=snapshot_python_sources) as scan, \
                mock.patch.object(app, 'inspect_runtime', side_effect=AssertionError('runtime cache should hit')):
            result = self.server._initialize({
                'workspaceRoot': str(self.root),
                'settingsModule': 'project.settings',
                'deferRuntime': False,
            })
        current_scans = [call for call in scan.call_args_list
                         if call.args and Path(call.args[0]).resolve() == self.root]
        self.assertEqual(len(current_scans), 2, scan.call_args_list)
        self.assertEqual(result['health']['runtime']['bootstrapStatus'], 'ready')
        self.assertEqual(
            result['staticFallback']['blog.Post']['fieldDetails']['title']['fieldKind'],
            'CharField',
        )

    def test_ready_runtime_cache_hit_retries_if_final_source_scan_changed(self):
        self.save_ready_caches()
        scans = []

        def scan(*args, **kwargs):
            result = snapshot_python_sources(*args, **kwargs)
            scans.append(result)
            if len(scans) == 1:
                self.edit()
            return result

        with mock.patch.object(app, 'snapshot_python_sources', side_effect=scan), \
                mock.patch.object(app, 'inspect_runtime', side_effect=AssertionError('deferred retry must not inspect runtime')):
            result = self.server._initialize({
                'workspaceRoot': str(self.root),
                'settingsModule': 'project.settings',
                'deferRuntime': True,
            })
        self.assertEqual(len(scans), 4)
        self.assertEqual(
            result['staticFallback']['blog.Post']['fieldDetails']['title']['fieldKind'],
            'DateField',
        )
        self.assertEqual(self.server.source_snapshot.fingerprint,
                         snapshot_python_sources(self.root).fingerprint)

    def test_creation_and_deletion_after_cached_scan_use_new_inventory(self):
        self.save()
        scans = []

        def scan(*args, **kwargs):
            result = snapshot_python_sources(*args, **kwargs)
            scans.append(result)
            if len(scans) == 1:
                self.source.unlink()
                (self.source.parent / 'replacement.py').write_text(
                    'from django.db import models\nclass Replacement(models.Model):\n    fresh = models.DateField()\n')
            return result

        with mock.patch.object(app, 'snapshot_python_sources', side_effect=scan):
            result = self.initialize()
        self.assertNotIn('Post', result['modelNames'])
        self.assertNotIn('blog.Post', result['staticFallback'])
        self.assertEqual(result['staticFallback']['blog.Replacement']['fieldDetails']['fresh']['fieldKind'], 'DateField')

    def test_edit_during_cold_parse_retries_and_saves_only_current_snapshot(self):
        builds = []

        def build(*args, **kwargs):
            result = build_static_index(*args, **kwargs)
            builds.append(result)
            if len(builds) == 1:
                self.edit()
            return result

        with mock.patch.object(app, 'build_static_index', side_effect=build), \
                mock.patch.object(app, 'save_static_index', wraps=save_static_index) as save:
            result = self.initialize()
        self.assertEqual(len(builds), 2)
        self.assertEqual(save.call_count, 1)
        self.assertEqual(save.call_args.args[1].fingerprint, snapshot_python_sources(self.root).fingerprint)
        self.assertEqual(result['staticFallback']['blog.Post']['fieldDetails']['title']['fieldKind'], 'DateField')

    def test_external_editable_change_after_scan_is_included_in_retry(self):
        self.source.unlink()
        external = self.base / 'library'
        _write_blog_models(external)
        source = external / 'blog' / 'models.py'
        self.save([external])
        info = VenvInfo(str(self.base / 'venv'), None, None, False,
                        (EditableInstall('library', str(external), 'direct-url'),))
        scans = []

        def scan(*args, **kwargs):
            result = snapshot_python_sources(*args, **kwargs)
            scans.append(result)
            if len(scans) == 1:
                self.edit(source)
            return result

        with mock.patch.object(app, 'resolve_venv_info', return_value=info), \
                mock.patch.object(app, 'snapshot_python_sources', side_effect=scan):
            result = self.initialize()
        self.assertEqual(result['staticFallback']['blog.Post']['fieldDetails']['title']['fieldKind'], 'DateField')
        self.assertEqual(self.server.source_snapshot.fingerprint,
                         snapshot_python_sources(self.root, [external]).fingerprint)

    def test_continuous_pre_runtime_edits_are_bounded_and_write_no_caches(self):
        builds = []

        def build(*args, **kwargs):
            result = build_static_index(*args, **kwargs)
            builds.append(result)
            self.edit()
            return result

        with mock.patch.object(app, 'build_static_index', side_effect=build), \
                mock.patch.object(app, 'save_static_index') as save_static, \
                mock.patch.object(app, 'save_runtime_inspection') as save_runtime, \
                mock.patch.object(app, 'save_model_graph') as save_graph, \
                mock.patch.object(app, 'inspect_runtime') as runtime:
            with self.assertRaisesRegex(RuntimeError, 'kept changing'):
                self.initialize()
        self.assertEqual(len(builds), 3)
        save_static.assert_not_called()
        save_runtime.assert_not_called()
        save_graph.assert_not_called()
        runtime.assert_not_called()
        self.assertIsNone(self.server.source_snapshot)

    def test_post_runtime_edit_rejects_without_publishing_or_writing_mismatched_cache(self):
        inspect = app.inspect_runtime

        def runtime(*args, **kwargs):
            result = inspect(*args, **kwargs)
            self.edit()
            return result

        with mock.patch.object(app, 'inspect_runtime', side_effect=runtime), \
                mock.patch.object(app, 'save_static_index') as save_static, \
                mock.patch.object(app, 'save_runtime_inspection') as save_runtime, \
                mock.patch.object(app, 'save_model_graph') as save_graph:
            with self.assertRaisesRegex(RuntimeError, 'changed during runtime'):
                self.initialize()
        save_static.assert_not_called()
        save_runtime.assert_not_called()
        save_graph.assert_not_called()
        self.assertIsNone(self.server.source_snapshot)

    def test_superseded_generation_during_pre_runtime_scan_writes_no_caches(self):
        scans = []

        def scan(*args, **kwargs):
            result = snapshot_python_sources(*args, **kwargs)
            scans.append(result)
            if len(scans) == 2:
                self.server._state_generation += 1
            return result

        with mock.patch.object(app, 'snapshot_python_sources', side_effect=scan), \
                mock.patch.object(app, 'save_static_index') as save_static, \
                mock.patch.object(app, 'inspect_runtime') as runtime:
            with self.assertRaisesRegex(RuntimeError, 'superseded'):
                self.initialize()
        self.assertEqual(len(scans), 2)
        save_static.assert_not_called()
        runtime.assert_not_called()
        self.assertIsNone(self.server.source_snapshot)

    def test_superseded_generation_during_final_scan_does_not_persist_or_adopt(self):
        scans = []

        def scan(*args, **kwargs):
            result = snapshot_python_sources(*args, **kwargs)
            scans.append(result)
            if len(scans) == 3:
                self.server._state_generation += 1
            return result

        with mock.patch.object(app, 'snapshot_python_sources', side_effect=scan), \
                mock.patch.object(app, 'save_static_index') as save_static, \
                mock.patch.object(app, 'save_runtime_inspection') as save_runtime, \
                mock.patch.object(app, 'save_model_graph') as save_graph:
            with self.assertRaisesRegex(RuntimeError, 'superseded'):
                self.initialize()
        self.assertEqual(len(scans), 3)
        save_static.assert_not_called()
        save_runtime.assert_not_called()
        save_graph.assert_not_called()
        self.assertIsNone(self.server.source_snapshot)


if __name__ == '__main__':
    unittest.main()
