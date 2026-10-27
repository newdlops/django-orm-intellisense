from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from django_orm_intellisense.discovery.settings import settings_projects
from django_orm_intellisense.discovery.workspace import discover_workspace, iter_python_files
from django_orm_intellisense.runtime.projects import collect_project_runtimes
from django_orm_intellisense.server.workspace_projects import WorkspaceProjects


@unittest.skipUnless(importlib.util.find_spec('django'), 'Django is required for actual project states')
class WorkspaceProjectUnionTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='djls-project-union-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for name, field in (('one', 'first'), ('two', 'second')):
            folder = self.root / name
            for package in ('config', 'inventory'):
                (folder / package).mkdir(parents=True)
                (folder / package / '__init__.py').write_text('')
            (folder / 'manage.py').write_text("import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE','config.settings')\n")
            (folder / 'config/settings.py').write_text(
                "SECRET_KEY='test'\nINSTALLED_APPS=['inventory']\n"
                "DATABASES={'default':{'ENGINE':'django.db.backends.sqlite3','NAME':':memory:'}}\n"
                "DEFAULT_AUTO_FIELD='django.db.models.AutoField'\n")
            (folder / 'inventory/models.py').write_text(
                'from django.db import models\n'
                f'class CustomQuerySet(models.QuerySet):\n    def only_{name}(self):\n        return self\n'
                'class Item(models.Model):\n'
                f'    {field} = models.CharField(max_length=20)\n'
                '    objects = CustomQuerySet.as_manager()\n')
        files = iter_python_files(self.root)
        profile = discover_workspace(self.root, python_files=files)
        self.projects = settings_projects(self.root, profile.settings_sources)
        self.workspace = WorkspaceProjects(self.root, self.projects, source_files=files)
        self.addCleanup(self.workspace.close)
        for value in collect_project_runtimes(self.projects, workspace_root=self.root, source_files=files):
            self.workspace.install(value)

    def label(self, index):
        return self.projects[index].namespace + '.inventory.Item'

    def test_union_contains_both_models_without_label_or_field_overwrites(self):
        payload = self.workspace.payload()
        self.assertEqual(set(payload['surfaceIndex']), {self.label(0), self.label(1)})
        self.assertEqual(payload['health']['phase'], 'ready')
        self.assertEqual(payload['health']['runtime']['modelCount'], 2)
        self.assertEqual(len(payload['projectContexts']), 2)
        self.assertIn('first', payload['surfaceIndex'][self.label(0)]['instance'])
        self.assertNotIn('second', payload['surfaceIndex'][self.label(0)]['instance'])
        self.assertIn('second', payload['surfaceIndex'][self.label(1)]['instance'])
        self.assertNotIn('first', payload['surfaceIndex'][self.label(1)]['instance'])

    def test_member_requests_keep_the_requested_project_and_return_scope(self):
        from django.apps import apps
        from django.conf import settings
        before = settings.configured, apps.ready
        for index, own, other in ((0, 'only_one', 'only_two'), (1, 'only_two', 'only_one')):
            result = self.workspace.request('resolveOrmMember', {
                'modelLabel': self.label(index), 'receiverKind': 'queryset', 'name': own})
            self.assertTrue(result['resolved'], result)
            self.assertEqual(result['item']['returnModelLabel'], self.label(index))
            missing = self.workspace.request('resolveOrmMember', {
                'modelLabel': self.label(index), 'receiverKind': 'queryset', 'name': other})
            self.assertFalse(missing['resolved'], missing)
        self.assertEqual((settings.configured, apps.ready), before)

    def test_same_local_label_routes_by_source_document(self):
        for index, name in ((0, 'one'), (1, 'two')):
            result = self.workspace.request('resolveRelationTarget', {
                'value': 'inventory.Item', '_sourceFile': str(self.root / name / 'inventory/models.py')})
            self.assertTrue(result['resolved'], result)
            self.assertEqual(result['target']['label'], self.label(index))
            self.assertEqual(result['target']['djangoLabel'], 'inventory.Item')
        ambiguous = self.workspace.request('resolveRelationTarget', {'value': 'inventory.Item'})
        self.assertFalse(ambiguous['resolved'])

    def test_lookup_batch_preserves_cross_project_order_and_catalogue_scope(self):
        result = self.workspace.request('resolveLookupPathBatch', {'items': [
            {'baseModelLabel': self.label(1), 'value': 'second__icontains', 'method': 'filter'},
            {'baseModelLabel': self.label(0), 'value': 'first__icontains', 'method': 'filter'},
            {'baseModelLabel': self.label(1), 'value': 'first__icontains', 'method': 'filter'},
        ]})
        self.assertEqual([row['resolved'] for row in result['results']], [True, True, False])
        payload = self.workspace.payload()
        self.assertEqual(set(payload['lookupCatalog']['fields']), {self.label(0), self.label(1)})
        for label, fields in payload['lookupCatalog']['fields'].items():
            for type_id in fields.values():
                self.assertTrue(type_id.startswith(label.split('.', 1)[0] + '.'))
                self.assertIn(type_id, payload['lookupCatalog']['types'])

    def test_canonical_module_resolution_retains_the_local_project(self):
        result = self.workspace.request('resolveModule', {'module': 'one.inventory.models'})
        self.assertTrue(result['resolved'], result)
        self.assertEqual(result['filePath'], str(self.root / 'one/inventory/models.py'))

    def test_qualified_relation_labels_and_canonical_imports_keep_the_owner(self):
        for value in (self.label(0), 'one.inventory.models.Item'):
            result = self.workspace.request('resolveRelationTarget', {
                'value': value, '_sourceFile': str(self.root / 'two/views.py')})
            self.assertTrue(result['resolved'], result)
            self.assertEqual(result['target']['label'], self.label(0))

    def test_saving_one_project_updates_only_its_surface(self):
        before = self.workspace.payload()['surfaceIndex'][self.label(1)]
        path = self.root / 'one/inventory/models.py'
        path.write_text(path.read_text() + '\n    newly_saved = models.TextField()\n')
        from django.conf import settings
        before_registry = settings.configured, os.environ.get('DJANGO_SETTINGS_MODULE')
        with mock.patch('django_orm_intellisense.semantic.graph.get_runtime_field',
                        side_effect=AssertionError('Detached save must not prepare a parent Django registry')):
            result = self.workspace.reindex_file({'filePath': str(path)})
        self.assertEqual((settings.configured, os.environ.get('DJANGO_SETTINGS_MODULE')), before_registry)
        self.assertNotIn('error', result)
        self.assertIn(self.label(0), result['surfaceIndexDelta'])
        self.assertIn('newly_saved', result['surfaceIndexDelta'][self.label(0)]['instance'])
        self.assertNotIn(self.label(1), result['surfaceIndexDelta'])
        self.assertEqual(self.workspace.payload()['surfaceIndex'][self.label(1)], before)
        self.assertEqual(self.workspace.pending, {self.projects[0].namespace})

    def test_saved_foreign_key_alias_and_pk_use_their_own_captured_types(self):
        path = self.root / 'one/inventory/models.py'
        path.write_text(path.read_text() + "\n    parent = models.ForeignKey('self', on_delete=models.CASCADE, null=True)\n")
        files = iter_python_files(self.root)
        value, = collect_project_runtimes((self.projects[0],), all_projects=self.projects,
            workspace_root=self.root, source_files=files)
        self.workspace.install(value)
        path.write_text(path.read_text() + '\n    saved = models.TextField()\n')
        with mock.patch('django_orm_intellisense.semantic.graph.get_runtime_field',
                        side_effect=AssertionError('Detached aliases must not access a global registry')):
            result = self.workspace.reindex_file({'filePath': str(path)})
        self.assertNotIn('error', result)
        fields = self.workspace.states[self.projects[0].namespace].engine.model_graph.fields_by_model_label['inventory.Item']
        self.assertEqual(fields['pk'].field_kind, 'AutoField')
        self.assertEqual(fields['parent_id'].field_kind, 'AutoField')

    def test_numeric_lookup_names_and_parameter_text_are_not_type_ids(self):
        wire = self.workspace.states[self.projects[0].namespace].wire
        catalog = wire.catalog({'fields': {'inventory.Item': {'value': '0'}},
            'expressionFields': {'inventory.Item': {'value': '1'}},
            'relationPaths': {'inventory.Item': {'children': {'queryName': '1', 'accessorName': '0'}}},
            'types': {'0': {'fieldKind': 'JSONField', 'lookups': ['0', '1'], 'transforms': {'1': '1'},
                'dynamicTransform': {'kind': 'key', 'outputType': '0', 'blockedNames': ['0']}},
                '1': {'fieldKind': 'CharField', 'lookups': ['exact'], 'transforms': {}}},
            'kinds': {'JSONField': '0'}})
        descriptor = catalog['types'][wire.type_id('0')]
        self.assertEqual(descriptor['lookups'], ['0', '1'])
        self.assertEqual(descriptor['dynamicTransform']['blockedNames'], ['0'])
        self.assertEqual(descriptor['transforms'], {'1': wire.type_id('1')})
        self.assertEqual(catalog['expressionFields'][self.label(0)]['value'], wire.type_id('1'))
        self.assertEqual(catalog['relationPaths'][self.label(0)]['children']['queryName'], '1')
        metadata = wire.metadata({'parameters': [{'label': 'inventory.Item', 'defaultValue': 'inventory.Item'}],
                                  'returnModelLabel': 'inventory.Item'})
        self.assertEqual(metadata['parameters'][0]['label'], 'inventory.Item')
        self.assertEqual(metadata['returnModelLabel'], self.label(0))


if __name__ == '__main__':
    unittest.main()
