"""A warm initial surface must be complete, current and ready for the first save."""
import contextlib
import copy
import dataclasses
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from django_orm_intellisense.cache import store
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.features.orm_members import build_surface_index, fingerprint_surface_index
from django_orm_intellisense.runtime.lookup_catalog import lookup_catalog_json_default
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.server import app
from django_orm_intellisense.static_index.indexer import build_static_index
from tests.test_static_fallback_surface_gap import _make_server, _ready_runtime_with, _runtime_model


class InitializeCachedSurfaceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='djls-initialize-surface-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.root = self.base / 'workspace'
        self.root.mkdir()
        self.source = self.root / 'models.py'
        self.source.write_text('from django.db import models\nclass Post(models.Model):\n'
            '    key = models.UUIDField(primary_key=True)\n    title = models.CharField(max_length=10)\n')
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.dict(os.environ, {
            'DJANGO_ORM_INTELLISENSE_CACHE_DIR': str(self.base / 'cache')}))
        for name in ['DJLS_SURFACE_CACHE_LOAD_MODE', 'DJLS_SURFACE_CACHE_IDLE_MS', 'DJLS_INLINE_CACHED_SURFACE']:
            os.environ.pop(name, None)
        self.runtime = dataclasses.replace(_ready_runtime_with(_runtime_model(
            'models.Post', 'models', [('key', 'UUIDField'), ('pk', 'UUIDField'), ('title', 'CharField')])),
            settings_module=None, custom_lookups={'CharField': ['custom_exact']},
            lookup_catalog={'fields': {'models.Post': {'key': 'uuid', 'pk': 'uuid', 'title': 'char'}},
                'types': {'uuid': {'fieldKind': 'UUIDField', 'lookups': ['exact'], 'transforms': {}},
                    'char': {'fieldKind': 'CharField', 'lookups': ['custom_exact'], 'transforms': {}}}})
        self.snapshot = snapshot_python_sources(self.root, max_workers=1)
        self.index = build_static_index(self.root, self.snapshot.files)
        self.graph = build_model_graph(self.index, self.runtime)
        self.surface = build_surface_index(self.index, self.runtime, self.graph)
        store.save_static_index(self.root, self.snapshot, self.index)
        runtime_source = app._runtime_source_fingerprint(
            source_snapshot=self.snapshot, static_index=self.index, settings_module=None)
        store.save_runtime_inspection(self.root, runtime_source, None, self.runtime)
        self.runtime_fingerprint = app._runtime_cache_fingerprint(self.runtime, source_fingerprint=runtime_source)
        store.save_model_graph(self.root, self.snapshot.fingerprint, self.runtime_fingerprint, self.graph)
        store.save_surface_index(self.root, self.snapshot.fingerprint, self.runtime_fingerprint, self.surface,
            surface_fingerprints=fingerprint_surface_index(self.surface))
        self.server = _make_server(self.root)
        self.schedule = self.stack.enter_context(mock.patch.object(self.server, '_schedule_surface_index_idle_load'))
        self.stack.enter_context(mock.patch.object(self.server, '_start_runtime_field_registry_prewarm'))
        self.stack.enter_context(mock.patch.object(self.server, '_start_runtime_warmup'))

    def initialize(self):
        return self.server._initialize({'workspaceRoot': str(self.root), 'deferRuntime': True})

    def edit(self):
        stamp = self.source.stat()
        self.source.write_text(self.source.read_text().replace('CharField', 'DateField'))
        os.utime(self.source, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        self.assertEqual(self.source.stat().st_size, stamp.st_size)
        self.assertEqual(self.source.stat().st_mtime_ns, stamp.st_mtime_ns)

    def test_complete_cache_is_initial_authority_with_uuid_custom_metadata_and_no_duplicate_load(self):
        before = {path: path.read_bytes() for path in store._workspace_cache_dir(self.root).iterdir()}
        with mock.patch.object(app, 'load_cached_surface_index', wraps=store.load_cached_surface_index) as load, \
                mock.patch.object(app, 'snapshot_python_sources', wraps=snapshot_python_sources) as scans, \
                mock.patch.object(app, 'fingerprint_surface_index', wraps=fingerprint_surface_index) as fingerprint, \
                mock.patch.object(self.server, '_publish_current_surface_snapshot') as publish:
            result = self.initialize()
            self.server._request_surface_index_load(reason='first-member-request')
        self.assertEqual(scans.call_count, 2)
        self.assertEqual(load.call_count, 1)
        fingerprint.assert_not_called()
        self.assertEqual(result['surfaceIndex'], self.surface)
        self.assertEqual(result['surfaceFingerprints'], fingerprint_surface_index(self.surface))
        self.assertIsNone(result['staticFallback'])
        self.assertEqual(result['customLookups'], self.runtime.custom_lookups)
        self.assertEqual(json.loads(json.dumps(result['lookupCatalog'], default=lookup_catalog_json_default)),
            self.runtime.lookup_catalog)
        self.assertEqual(result['surfaceIndex']['models.Post']['instance']['pk'][3], 'UUIDField')
        self.assertNotIn('id', result['surfaceIndex']['models.Post']['instance'])
        self.schedule.assert_not_called()
        publish.assert_not_called()
        self.assertIsNone(self.server._surface_prebuild_future)
        self.assertEqual(before, {path: path.read_bytes() for path in before})

    def test_legacy_surface_cache_without_fingerprints_uses_recalculation_fallback(self):
        path = store._workspace_cache_dir(self.root) / store.SURFACE_INDEX_CACHE_NAME
        payload = json.loads(path.read_text())
        payload['metadata'].pop('surfaceFingerprints')
        path.write_text(json.dumps(payload))

        loaded, fingerprints = store.load_cached_surface_index(
            self.root, self.snapshot.fingerprint, self.runtime_fingerprint,
            static_index=self.index, model_graph=self.graph, with_fingerprints=True)

        self.assertEqual(loaded, self.surface)
        self.assertIsNone(fingerprints)

    def test_invalid_surface_cache_fingerprints_use_recalculation_fallback(self):
        path = store._workspace_cache_dir(self.root) / store.SURFACE_INDEX_CACHE_NAME
        payload = json.loads(path.read_text())
        payload['metadata']['surfaceFingerprints']['models.Post'] = 'invalid'
        path.write_text(json.dumps(payload))

        loaded, fingerprints = store.load_cached_surface_index(
            self.root, self.snapshot.fingerprint, self.runtime_fingerprint,
            static_index=self.index, model_graph=self.graph, with_fingerprints=True)

        self.assertEqual(loaded, self.surface)
        self.assertIsNone(fingerprints)

    def test_first_save_dependency_and_workspace_caches_are_ready_before_full_adoption(self):
        apply = self.server._apply_state

        def adopt(**kwargs):
            index = kwargs['static_index']
            self.assertEqual(index._workspace_source_paths, frozenset(map(str, self.snapshot.files)))
            self.assertIsNotNone(index._import_dependency_cache.dependents)
            self.assertIsNotNone(index._constructor_dependency_cache)
            return apply(**kwargs)

        with mock.patch.object(self.server, '_apply_state', side_effect=adopt):
            self.initialize()

    def test_same_size_restored_mtime_edit_during_cache_read_retries_before_adoption(self):
        def load(*args, **kwargs):
            value = store.load_cached_surface_index(*args, **kwargs)
            self.edit()
            return value

        with mock.patch.object(app, 'load_cached_surface_index', side_effect=load):
            result = self.initialize()
        self.assertEqual(self.server.source_snapshot.fingerprint, snapshot_python_sources(self.root).fingerprint)
        self.assertIn('DateField', str(result))
        self.schedule.assert_called_once()

    def test_same_size_edit_during_first_save_preparation_retries_before_adoption(self):
        with mock.patch.object(app, 'prebuild_runtime_workspace_paths', side_effect=lambda *_: self.edit()):
            self.initialize()
        self.assertEqual(self.server.source_snapshot.fingerprint, snapshot_python_sources(self.root).fingerprint)
        self.schedule.assert_called_once()

    def prepare_same_inode_source_alias(self):
        first, second = self.base / 'first.txt', self.base / 'second.txt'
        self.source.rename(first)
        os.link(first, second)
        self.source.symlink_to(first)
        self.snapshot = snapshot_python_sources(self.root, max_workers=1)
        self.index = build_static_index(self.root, self.snapshot.files)
        self.graph = build_model_graph(self.index, self.runtime)
        self.surface = build_surface_index(self.index, self.runtime, self.graph)
        store.save_static_index(self.root, self.snapshot, self.index)
        runtime_source = app._runtime_source_fingerprint(
            source_snapshot=self.snapshot, static_index=self.index, settings_module=None)
        store.save_runtime_inspection(self.root, runtime_source, None, self.runtime)
        self.runtime_fingerprint = app._runtime_cache_fingerprint(self.runtime, source_fingerprint=runtime_source)
        store.save_model_graph(self.root, self.snapshot.fingerprint, self.runtime_fingerprint, self.graph)
        store.save_surface_index(self.root, self.snapshot.fingerprint, self.runtime_fingerprint, self.surface,
            surface_fingerprints=fingerprint_surface_index(self.surface))
        return first, second

    def switch_source_alias(self, target):
        replacement = self.root / '.alias-switch.tmp'
        replacement.symlink_to(target)
        replacement.replace(self.source)

    def test_same_inode_alias_switch_during_preparation_retries_with_current_membership(self):
        first, second = self.prepare_same_inode_source_alias()
        stamp = self.source.stat()
        prepare = app.prebuild_runtime_workspace_paths
        owners = []

        def prepared(index, runtime):
            prepare(index, runtime)
            owners.append(index)
            if len(owners) == 1:
                self.switch_source_alias(second)

        with mock.patch.object(app, 'prebuild_runtime_workspace_paths', side_effect=prepared):
            result = self.initialize()
        current = self.source.stat()
        self.assertEqual((stamp.st_dev, stamp.st_ino, stamp.st_size, stamp.st_mtime_ns, stamp.st_ctime_ns),
            (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns, current.st_ctime_ns))
        self.assertEqual(snapshot_python_sources(self.root).fingerprint, self.snapshot.fingerprint)
        self.assertEqual(len(owners), 1)
        self.assertEqual(owners[0]._workspace_source_paths_by_module['models'], str(first))
        self.assertIsNot(self.server.static_index, owners[0])
        self.assertEqual(result['surfaceIndex'], {})
        self.assertEqual(result['health']['runtime']['bootstrapStatus'], 'skipped_missing_settings')
        self.assertEqual(result['staticFallback']['models.Post']['fieldDetails']['title']['fieldKind'], 'CharField')
        self.assertEqual(self.server._source_membership_fingerprint,
                         app.source_membership_fingerprint(self.server.source_snapshot))
        # The new canonical target cannot reuse the old runtime. Without a
        # configured settings module, its current static fallback is available.
        self.assertNotEqual(result['lookupCatalog'], self.runtime.lookup_catalog)

    def test_same_inode_alias_churn_stops_before_adoption_after_bounded_retries(self):
        first, second = self.prepare_same_inode_source_alias()
        capture = app.source_membership_fingerprint
        calls = []

        def captured(snapshot):
            value = capture(snapshot)
            calls.append(value)
            self.switch_source_alias(second if self.source.resolve() == first else first)
            return value

        with mock.patch.object(app, 'source_membership_fingerprint', side_effect=captured):
            with self.assertRaisesRegex(RuntimeError, 'kept changing'):
                self.initialize()
        self.assertEqual(len(calls), 6)
        self.assertIsNone(self.server.source_snapshot)
        self.assertIsNone(self.server.static_index)
        self.schedule.assert_not_called()

    def test_root_generation_superseded_during_cache_read_cannot_adopt_old_surface(self):
        def load(*args, **kwargs):
            value = store.load_cached_surface_index(*args, **kwargs)
            self.server._reserve_state_generation(workspace_root=self.base / 'other',
                initialized_at=app.datetime.now(app.timezone.utc))
            return value

        with mock.patch.object(app, 'load_cached_surface_index', side_effect=load):
            with self.assertRaisesRegex(RuntimeError, 'superseded'):
                self.initialize()
        self.assertEqual(self.server.workspace_root, self.base / 'other')
        self.assertIsNone(self.server.source_snapshot)
        self.assertIsNone(self.server._last_surface_index)

    def test_explicit_scheduling_and_diagnostic_optout_keep_deferred_initialization(self):
        for control in [{'DJLS_SURFACE_CACHE_IDLE_MS': value} for value in ['0', '2000', 'invalid']] + [
                {'DJLS_SURFACE_CACHE_LOAD_MODE': mode} for mode in ['off', 'on-demand', 'eager']] + [
                {'DJLS_INLINE_CACHED_SURFACE': '0'}]:
            with self.subTest(control=control), mock.patch.dict(os.environ, control), \
                    mock.patch.object(app, 'load_cached_surface_index') as load:
                result = self.initialize()
                self.assertEqual(result['surfaceIndex'], {})
                self.assertEqual(result['staticFallback']['models.Post']['fieldDetails']['pk']['fieldKind'], 'UUIDField')
                load.assert_not_called()
                self.schedule.assert_called()

    def test_missing_surface_falls_back_without_pretending_to_be_complete(self):
        (store._workspace_cache_dir(self.root) / store.SURFACE_INDEX_CACHE_NAME).unlink()
        result = self.initialize()
        self.assertEqual(result['surfaceIndex'], {})
        self.assertIn('title', result['staticFallback']['models.Post']['fields'])
        self.schedule.assert_called_once()
        self.assertIsNone(self.server._surface_load_attempted_generation)

    def test_malformed_surface_falls_back_and_removes_corrupt_cache(self):
        path = store._workspace_cache_dir(self.root) / store.SURFACE_INDEX_CACHE_NAME
        path.write_text('{broken')
        self.assertEqual(self.initialize()['surfaceIndex'], {})
        self.assertFalse(path.exists())
        self.schedule.assert_called_once()

    def test_incomplete_surface_is_rejected_by_existing_graph_and_field_coverage_validation(self):
        partial = copy.deepcopy(self.surface)
        del partial['models.Post']['instance']['title']
        store.save_surface_index(self.root, self.snapshot.fingerprint, self.runtime_fingerprint, partial)
        result = self.initialize()
        self.assertEqual(result['surfaceIndex'], {})
        self.assertEqual(result['staticFallback']['models.Post']['fieldDetails']['title']['fieldKind'], 'CharField')
        self.assertFalse((store._workspace_cache_dir(self.root) / store.SURFACE_INDEX_CACHE_NAME).exists())
        self.schedule.assert_called_once()

    def test_missing_runtime_or_graph_never_treats_surface_alone_as_a_complete_warm_cache(self):
        for name in [store.RUNTIME_CACHE_NAME, store.MODEL_GRAPH_CACHE_NAME]:
            with self.subTest(cache=name):
                path = store._workspace_cache_dir(self.root) / name
                original = path.read_bytes()
                path.unlink()
                with mock.patch.object(app, 'load_cached_surface_index') as load:
                    self.assertEqual(self.initialize()['surfaceIndex'], {})
                    load.assert_not_called()
                path.write_bytes(original)

    def test_source_edit_before_initialize_does_not_restore_old_surface(self):
        self.edit()
        with mock.patch.object(app, 'load_cached_surface_index') as load:
            result = self.initialize()
        self.assertEqual(result['surfaceIndex'], {})
        self.assertEqual(result['staticFallback']['models.Post']['fieldDetails']['title']['fieldKind'], 'DateField')
        load.assert_not_called()

    def test_live_source_verification_does_not_replace_reconciled_graph_with_cached_surface(self):
        self.initialize()
        with mock.patch.object(app, 'load_cached_surface_index') as load:
            state = self.server._initialize_from_source_snapshot(generation=self.server._state_generation,
                initialized_at=self.server.initialized_at, workspace_root=self.root, settings_module=None,
                defer_runtime=True, venv_info=None, source_snapshot=self.snapshot, started_at=time.perf_counter(),
                expected_reindex_serial=self.server._reindex_serial)
        self.assertIsNotNone(state)
        self.assertEqual(state.surface_index, {})
        load.assert_not_called()


if __name__ == '__main__':
    unittest.main()
