import os
import unittest
from unittest import mock

from django_orm_intellisense import launch_environment
from django_orm_intellisense.cache import store
from django_orm_intellisense.server import app, source_provenance
from tests import test_initialize_cached_surface as cached


class LaunchEnvironmentFingerprintTests(unittest.TestCase):
    def test_all_names_values_empty_entries_and_unicode_are_bound_in_stable_order(self):
        values = {'TOKEN': 'private\nvalue', '빈값': '', '😀': '한글', '\ue000': '='}
        fingerprint = launch_environment.fingerprint_environment(values)
        self.assertEqual(fingerprint, launch_environment.fingerprint_environment(dict(reversed(list(values.items())))))
        self.assertEqual(len(fingerprint), 64)
        self.assertNotIn('private', fingerprint)
        for changed in ({**values, 'TOKEN': 'other'}, {**values, 'extra': ''},
                        {key: value for key, value in values.items() if key != '빈값'}):
            self.assertNotEqual(fingerprint, launch_environment.fingerprint_environment(changed))
        self.assertNotEqual(launch_environment.fingerprint_environment({'AB': 'C'}),
                            launch_environment.fingerprint_environment({'A': 'BC'}))

    def test_later_project_environment_mutation_does_not_relabel_launch(self):
        captured = launch_environment.launch_environment_fingerprint()
        with mock.patch.dict(os.environ, {'DJANGO_SETTINGS_MODULE': 'added.by.django', 'DJLS_TEST_SECRET': 'changed'}):
            self.assertEqual(launch_environment.launch_environment_fingerprint(), captured)


class LaunchEnvironmentCacheOwnershipTests(unittest.TestCase):
    setUp = cached.InitializeCachedSurfaceTests.setUp

    def keys(self):
        source = app._runtime_source_fingerprint(source_snapshot=self.snapshot,
            static_index=self.index, settings_module=None)
        return source, app._runtime_cache_fingerprint(self.runtime, source_fingerprint=source)

    def test_changed_launch_rejects_runtime_graph_and_surface_but_preserves_static_reuse(self):
        original_source, original_graph = self.keys()
        with mock.patch.object(launch_environment, '_LAUNCH_ENVIRONMENT_FINGERPRINT', 'f' * 64):
            source, graph = self.keys()
            self.assertNotEqual(source, original_source)
            self.assertNotEqual(graph, original_graph)
            self.assertIsNone(store.load_cached_runtime_inspection(self.root, original_source, None))
            self.assertIsNone(store.load_cached_runtime_inspection(self.root, source, None))
            self.assertIsNone(store.load_cached_model_graph(self.root, self.snapshot.fingerprint, graph))
            self.assertIsNone(store.load_cached_surface_index(self.root, self.snapshot.fingerprint, graph))
            static, hit = store.load_cached_static_index(self.root, self.snapshot)
            self.assertEqual(hit, 'full')
            self.assertEqual(static.to_cache_dict(), self.index.to_cache_dict())
        self.assertIsNotNone(store.load_cached_runtime_inspection(self.root, original_source, None))
        self.assertIsNotNone(store.load_cached_model_graph(self.root, self.snapshot.fingerprint, original_graph))
        self.assertIsNotNone(store.load_cached_surface_index(self.root, self.snapshot.fingerprint, original_graph))

    def test_settings_import_mutation_keeps_cached_owner_and_captured_proof(self):
        original_source, original_graph = self.keys()
        with mock.patch.dict(os.environ, {'DJANGO_SETTINGS_MODULE': 'project.imported_settings'}):
            self.assertEqual(self.keys(), (original_source, original_graph))
            self.assertIsNotNone(store.load_cached_runtime_inspection(self.root, original_source, None))
            proof = source_provenance.capture_source_provenance(self.snapshot, 'a' * 64, [], None)
            self.assertEqual(proof['version'], 2)
            self.assertEqual(proof['launchEnvironmentFingerprint'], launch_environment.launch_environment_fingerprint())
            self.assertNotIn('project.imported_settings', str(proof))
