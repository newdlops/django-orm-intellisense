"""Unchanged profile metadata must not be converted or unioned again."""
from dataclasses import replace
import json
import importlib.util
import unittest
from unittest import mock

import test_same_root_settings as fixtures
from django_orm_intellisense.runtime.projects import ProjectRuntime, ProjectRuntimeFailure
from django_orm_intellisense.server.workspace_projects import WorkspaceProjects


@unittest.skipUnless(importlib.util.find_spec('django'), 'Django is required')
class ProjectIncrementalUnionTest(unittest.TestCase):
    setUp = fixtures.SameRootSettingsTest.setUp
    write = fixtures.SameRootSettingsTest.write
    initialize = fixtures.SameRootSettingsTest.initialize
    label = fixtures.SameRootSettingsTest.label

    def test_health_only_pending_reuses_complete_model_metadata(self):
        before = self.initialize()
        state = next(iter(self.workspace.states.values()))
        with mock.patch.object(state.wire, 'catalog', wraps=state.wire.catalog) as converted:
            self.workspace.mark_pending(state.runtime.project.namespace)
            after = self.workspace.payload()
        self.assertTrue(after['runtimeMembersPending'])
        self.assertEqual(after['health']['runtime']['readySettingsCount'], 1)
        self.assertEqual(after['surfaceIndex'], before['surfaceIndex'])
        self.assertEqual(converted.call_count, 0, 'A health update re-converted unchanged profile metadata')
        self.assertTrue(after['surfaceIndex'] is before['surfaceIndex'], 'Unchanged model table was replaced')
        self.assertTrue(after['lookupCatalog'] is before['lookupCatalog'], 'Unchanged catalog was replaced')

    def test_one_profile_member_change_preserves_unaffected_model_rows(self):
        before = self.initialize()
        state = list(self.workspace.states.values())[1]
        engine = state.engine
        surface = dict(engine._last_surface_index)
        common = dict(surface['common.Shared'])
        common['queryset'] = {**common['queryset'], 'new_two_only': ('queryset', 'common.Shared', 'method', None)}
        surface['common.Shared'] = common
        value = ProjectRuntime(state.runtime.project, engine.static_index, engine.runtime_inspection,
            engine.model_graph, engine.static_index._runtime_member_snapshot, surface, {},
            engine.source_snapshot, dependencies=state.runtime.dependencies, app_names=state.runtime.app_names)
        self.workspace.install(value)
        after = self.workspace.payload()
        self.assertIn('new_two_only', after['surfaceIndex'][self.label('common.Shared')]['queryset'])
        self.assertIn('only_one', after['surfaceIndex'][self.label('common.Shared')]['queryset'])
        self.assertIn('only_two', after['surfaceIndex'][self.label('common.Shared')]['queryset'])
        self.assertTrue(after['surfaceIndex'][self.label('oneapp.One')] is before['surfaceIndex'][self.label('oneapp.One')], 'Unchanged model row was replaced')
        self.assertTrue(after['lookupCatalog'] is before['lookupCatalog'], 'Unchanged catalog was replaced')
        self.assertNotIn('new_two_only', before['surfaceIndex'][self.label('common.Shared')]['queryset'])

    def test_failed_refresh_retains_other_profiles_without_metadata_rebuild(self):
        before = self.initialize()
        state = list(self.workspace.states.values())[1]
        self.workspace.install(ProjectRuntimeFailure(state.runtime.project, 'retryable fixture failure'))
        after = self.workspace.payload()
        self.assertEqual(after['health']['phase'], 'degraded')
        self.assertEqual(after['surfaceIndex'], before['surfaceIndex'])
        self.assertTrue(after['surfaceIndex'] is before['surfaceIndex'], 'Failed refresh replaced model metadata')
        self.assertIn('retryable fixture failure', after['health']['settingsProfiles'][1]['error'])

    def test_save_updates_changed_model_and_keeps_unedited_model_row(self):
        before = self.initialize()
        path = self.root / 'twoapp/models.py'
        path.write_text(path.read_text() + '\n    saved = models.BooleanField(default=False)\n')
        self.workspace.reindex_file({'filePath': str(path)})
        after = self.workspace.payload()
        self.assertIn('saved', after['surfaceIndex'][self.label('twoapp.Two')]['instance'])
        self.assertTrue(after['surfaceIndex'][self.label('oneapp.One')] is before['surfaceIndex'][self.label('oneapp.One')], 'Save replaced an unrelated model row')

    def test_pending_workspace_without_results_still_has_zero_model_counts(self):
        self.initialize()
        pending = WorkspaceProjects(self.root, self.workspace.projects)
        self.addCleanup(pending.close)
        snapshot = pending.payload()
        self.assertEqual(snapshot['health']['runtime']['modelCount'], 0)
        self.assertEqual(snapshot['health']['phase'], 'starting')

    def test_lookup_only_change_rebuilds_catalog_and_preserves_model_members(self):
        before = self.initialize()
        state = list(self.workspace.states.values())[1]
        engine = state.engine
        catalog = json.loads(json.dumps(engine.runtime_inspection.lookup_catalog))
        type_id = catalog['fields']['common.Shared']['title']
        catalog['types'][type_id]['lookups'] = [*catalog['types'][type_id]['lookups'], 'added_lookup']
        inspection = replace(engine.runtime_inspection, lookup_catalog=catalog)
        value = ProjectRuntime(state.runtime.project, engine.static_index, inspection,
            engine.model_graph, engine.static_index._runtime_member_snapshot, engine._last_surface_index, {},
            engine.source_snapshot, dependencies=state.runtime.dependencies, app_names=state.runtime.app_names)
        self.workspace.install(value)
        after = self.workspace.payload()
        shared = self.label('common.Shared')
        field_type = after['lookupCatalog']['fields'][shared]['title']
        self.assertIn('added_lookup', after['lookupCatalog']['types'][field_type]['lookups'])
        self.assertTrue(after['surfaceIndex'] is before['surfaceIndex'], 'Lookup-only update replaced member tables')
        self.assertNotEqual(after['customLookupsFingerprint'], before['customLookupsFingerprint'])

    def test_removed_surface_does_not_remove_a_model_owned_by_another_setting(self):
        before = self.initialize()
        state = list(self.workspace.states.values())[1]
        engine = state.engine
        surface = {label: row for label, row in engine._last_surface_index.items() if label != 'common.Shared'}
        value = ProjectRuntime(state.runtime.project, engine.static_index, engine.runtime_inspection,
            engine.model_graph, engine.static_index._runtime_member_snapshot, surface, {},
            engine.source_snapshot, dependencies=state.runtime.dependencies, app_names=state.runtime.app_names)
        self.workspace.install(value)
        after = self.workspace.payload()
        common = after['surfaceIndex'][self.label('common.Shared')]['queryset']
        self.assertIn('only_one', common)
        self.assertNotIn('only_two', common)
        self.assertTrue(after['surfaceIndex'][self.label('twoapp.Two')] is before['surfaceIndex'][self.label('twoapp.Two')])


if __name__ == '__main__':
    unittest.main()
