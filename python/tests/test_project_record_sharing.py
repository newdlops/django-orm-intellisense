"""Workspace-local sharing cannot alias mutable profile owners or leak generations."""
import importlib.util
import unittest
import weakref

import test_same_root_settings as fixtures
from django_orm_intellisense.discovery.workspace import iter_python_files
from django_orm_intellisense.runtime.projects import collect_project_runtimes


@unittest.skipUnless(importlib.util.find_spec('django'), 'Django is required')
class ProjectRecordSharingTest(unittest.TestCase):
    setUp = fixtures.SameRootSettingsTest.setUp
    write = fixtures.SameRootSettingsTest.write
    initialize = fixtures.SameRootSettingsTest.initialize
    label = fixtures.SameRootSettingsTest.label

    def test_equal_frozen_fields_share_storage_with_distinct_profile_owners(self):
        self.initialize()
        first, second = self.workspace.states.values()
        self.assertIsNot(first.engine.model_graph, second.engine.model_graph)
        self.assertIsNot(first.engine.runtime_inspection, second.engine.runtime_inspection)
        self.assertNotEqual(first.engine.runtime_inspection.settings_module, second.engine.runtime_inspection.settings_module)
        a = first.engine.model_graph.fields_by_model_label['common.Shared']['title']
        b = second.engine.model_graph.fields_by_model_label['common.Shared']['title']
        self.assertTrue(a is b, 'Equal graph fields were retained once per settings profile')
        a_model = first.engine.model_graph.nodes_by_label['common.Shared'].runtime_model
        b_model = second.engine.model_graph.nodes_by_label['common.Shared'].runtime_model
        a_field = next(field for field in a_model.fields if field.name == 'title')
        b_field = next(field for field in b_model.fields if field.name == 'title')
        self.assertEqual(a_field, b_field)
        self.assertTrue(a_field is b_field, 'Equal runtime field records were duplicated')

    def test_qualified_member_rows_and_equal_lookup_descriptors_are_shared(self):
        self.initialize()
        first, second = self.workspace.states.values()
        a, b = self.workspace._contributions.profiles.values()
        shared = self.label('common.Shared')
        self.assertTrue(a.surface[shared]['model_class'] is b.surface[shared]['model_class'],
            'Qualification recreated equal manager rows per profile')
        one = first.engine.runtime_inspection.lookup_catalog
        two = second.engine.runtime_inspection.lookup_catalog
        self.assertIsNot(one, two)
        self.assertTrue(one['types'][one['fields']['common.Shared']['id']]
            is two['types'][two['fields']['common.Shared']['id']], 'Equal lookup descriptors were duplicated')
        self.assertIsNot(one['types'][one['fields']['common.Shared']['title']],
            two['types'][two['fields']['common.Shared']['title']], 'Distinct settings lookup registrations were collapsed')

    def test_shared_rows_reject_mutation_and_source_saves_keep_each_profile_current(self):
        self.initialize()
        first, second = self.workspace.states.values()
        with self.assertRaises(TypeError):
            first.engine._last_surface_index['common.Shared']['model_class']['bad'] = ('scalar', None, 'field', None)
        path = self.root / 'common/models.py'
        path.write_text(path.read_text() + '\n    fresh = models.IntegerField(default=0)\n')
        response = self.workspace.reindex_file({'filePath': str(path)})
        self.assertIn('fresh', response['surfaceIndexDelta'][self.label('common.Shared')]['instance'])
        for state in (first, second):
            self.assertIn('fresh', state.engine.model_graph.fields_by_model_label['common.Shared'])

    def test_replacing_the_only_owner_releases_its_old_model_without_forced_gc(self):
        self.initialize()
        first = next(iter(self.workspace.states.values()))
        project = first.runtime.project
        old = weakref.ref(first.engine.model_graph.nodes_by_label['oneapp.One'].runtime_model)
        path = self.root / 'oneapp/models.py'
        path.write_text(path.read_text() + '\n    fresh = models.BooleanField(default=False)\n')
        value, = collect_project_runtimes((project,), all_projects=self.workspace.projects,
            workspace_root=self.root, source_files=iter_python_files(self.root))
        self.workspace.install(value)
        self.workspace.payload()
        del first, value
        self.assertIsNone(old(), 'The workspace pool retained a retired profile generation')

    def test_close_releases_pooled_model_records_without_forced_gc(self):
        self.initialize()
        first = next(iter(self.workspace.states.values()))
        old = weakref.ref(first.engine.model_graph.nodes_by_label['common.Shared'].runtime_model)
        self.workspace.close()
        del first
        self.assertIsNone(old(), 'Closed workspace retained model records')


if __name__ == '__main__':
    unittest.main()
