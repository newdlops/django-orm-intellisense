from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

from django_orm_intellisense.discovery.settings import settings_projects
from django_orm_intellisense.discovery.workspace import discover_workspace, iter_python_files
from django_orm_intellisense.runtime.projects import collect_project_runtimes
from django_orm_intellisense.server.project_daemon import ProjectDaemonServer
from django_orm_intellisense.server.app import DaemonServer
from django_orm_intellisense.server.settings_union import CatalogUnion


@unittest.skipUnless(importlib.util.find_spec('django'), 'Django is required')
class SameRootSettingsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='djls-same-root-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        for package in ('config', 'config/settings', 'common', 'oneapp', 'twoapp', 'utility'):
            self.write(package + '/__init__.py', '')
        self.write('manage.py', "import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings.one')\n")
        self.write('config/settings/base.py', "SECRET_KEY='fixture'\nINSTALLED_APPS=['common.apps.CommonConfig']\n"
            "DATABASES={'default':{'ENGINE':'django.db.backends.sqlite3','NAME':':memory:'}}\n"
            "DEFAULT_AUTO_FIELD='django.db.models.AutoField'\n")
        for name in ('one', 'two'):
            self.write(f'config/settings/{name}.py', f"from .base import *\nINSTALLED_APPS += ['{name}app']\nPROFILE='{name}'\n")
            self.write(f'{name}app/models.py', 'from django.db import models\n'
                f'class {name.title()}(models.Model):\n    {name}_field = models.IntegerField()\n'
                "    shared = models.ForeignKey('common.Shared', on_delete=models.CASCADE)\n")
        self.write('utility/settings.py', 'from pathlib import Path\nROOT=Path(__file__).parent\n')
        self.write('common/models.py', 'from django.db import models\n'
            'class SharedQuerySet(models.QuerySet):\n    pass\n'
            'class Shared(models.Model):\n    title = models.CharField(max_length=20)\n'
            '    objects = SharedQuerySet.as_manager()\n')
        self.write('common/apps.py', 'from django.apps import AppConfig\n'
            'class CommonConfig(AppConfig):\n    name="common"\n'
            '    def ready(self):\n        from django.conf import settings\n'
            '        from django.db.models import CharField, Lookup\n'
            '        from .models import SharedQuerySet\n'
            '        class ProfileLookup(Lookup):\n            lookup_name="from_" + settings.PROFILE\n'
            '            def as_sql(self, compiler, connection):\n                return "1=1", []\n'
            '        CharField.register_lookup(ProfileLookup)\n'
            '        def only_profile(self):\n            return self\n'
            '        setattr(SharedQuerySet, "only_" + settings.PROFILE, only_profile)\n')
        output = sys.stdout
        try:
            self.server = ProjectDaemonServer(self.root)
        finally:
            sys.stdout = output
        self.server._write_notification = lambda *_args, **_kwargs: None
        def close():
            self.server._stopping.set()
            self.server._close_projects()
            if self.server._projects_thread:
                self.server._projects_thread.join(timeout=3)
        self.addCleanup(close)

    def write(self, relative, value):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)
        return path

    def initialize(self):
        result = self.server._initialize({'workspaceRoot': str(self.root)})
        self.workspace = self.server._projects
        self.group = result['projectContexts'][0]['namespace']
        return result

    def label(self, local):
        return self.group + '.' + local

    def test_discovery_collects_both_registries_and_covers_shared_fragments(self):
        profile = discover_workspace(self.root)
        projects = settings_projects(self.root, profile.settings_sources)
        self.assertEqual([project.settings_module for project in projects], ['config.settings.one', 'config.settings.two'])
        self.assertEqual(len({project.group_namespace for project in projects}), 1)
        self.assertIn('config.settings.base', projects[0].candidates)
        self.assertIn('utility.settings', projects[0].candidates)
        selected = settings_projects(self.root, profile.settings_sources, 'config.settings.two')
        self.assertEqual(selected[0].settings_module, 'config.settings.two')
        self.assertEqual({p.settings_module for p in selected}, {p.settings_module for p in projects})

    def test_union_deduplicates_common_models_and_shares_the_static_index(self):
        result = self.initialize()
        self.assertEqual(result['health']['phase'], 'ready')
        self.assertEqual(result['health']['runtime']['modelCount'], 3)
        self.assertEqual(result['health']['runtime']['appCount'], 3)
        self.assertEqual(result['health']['runtime']['readySettingsCount'], 2)
        context, = result['projectContexts']
        self.assertEqual(len(context['settingsProfiles']), 2)
        self.assertEqual({key for key in context['models']}, {
            self.label('common.Shared'), self.label('oneapp.One'), self.label('twoapp.Two')})
        first, second = self.workspace.states.values()
        self.assertIs(first.engine.static_index.modules, second.engine.static_index.modules)
        self.assertIsNot(first.engine.static_index, second.engine.static_index)
        self.assertIsNot(first.engine.static_index._runtime_member_snapshot, second.engine.static_index._runtime_member_snapshot)
        self.assertIs(first.engine._last_surface_index['common.Shared']['model_class'],
                      second.engine._last_surface_index['common.Shared']['model_class'])
        self.assertIsNone(first.runtime.static_index)

    def test_profile_only_methods_relations_and_lookups_survive_the_union(self):
        result = self.initialize()
        shared = self.label('common.Shared')
        surface = result['surfaceIndex'][shared]
        self.assertIn('only_one', surface['queryset'])
        self.assertIn('only_two', surface['queryset'])
        self.assertIn('one_set', surface['instance'])
        self.assertIn('two_set', surface['instance'])
        catalog = result['lookupCatalog']
        descriptor = catalog['types'][catalog['fields'][shared]['title']]
        self.assertIn('from_one', descriptor['lookups'])
        self.assertIn('from_two', descriptor['lookups'])
        for value in ('title__from_one', 'title__from_two'):
            reply = self.workspace.request('resolveLookupPath', {'baseModelLabel': shared, 'value': value, 'method': 'filter'})
            self.assertTrue(reply['resolved'], reply)
        reply = self.workspace.request('resolveOrmMember', {'modelLabel': shared, 'receiverKind': 'queryset', 'name': 'only_two'})
        self.assertTrue(reply['resolved'], reply)
        targets = self.workspace.request('relationTargets', {})['items']
        self.assertEqual(len(targets), 3)

    def test_save_updates_all_settings_without_losing_other_members(self):
        self.initialize()
        path = self.root / 'common/models.py'
        path.write_text(path.read_text() + '\n    added = models.IntegerField(default=0)\n')
        result = self.workspace.reindex_file({'filePath': str(path)})
        self.assertNotIn('error', result)
        self.assertEqual(self.workspace.pending, {project.namespace for project in self.workspace.projects})
        self.assertIn('added', result['surfaceIndexDelta'][self.label('common.Shared')]['instance'])
        for state in self.workspace.states.values():
            self.assertIn('added', state.engine.model_graph.fields_by_model_label['common.Shared'])

    def test_one_failed_setting_keeps_other_data_and_reports_partial_coverage(self):
        path = self.root / 'config/settings/two.py'
        path.write_text(path.read_text() + 'raise RuntimeError("second settings unavailable")\n')
        result = self.initialize()
        self.assertEqual(result['health']['phase'], 'degraded')
        self.assertEqual(result['health']['runtime']['readySettingsCount'], 1)
        profiles = result['health']['settingsProfiles']
        self.assertEqual(len(profiles), 2)
        self.assertIn('second settings unavailable', profiles[1]['error'])
        self.assertIn(self.label('oneapp.One'), result['surfaceIndex'])
        self.assertIn('two_field', result['surfaceIndex'][self.label('twoapp.Two')]['instance'])

    def test_stale_static_seed_is_rebuilt_instead_of_returning_old_source(self):
        self.initialize()
        project = self.workspace.projects[0]
        state = self.workspace.states[project.namespace]
        path = self.root / 'common/models.py'
        path.write_text(path.read_text() + '\n    fresh = models.BooleanField(default=False)\n')
        value, = collect_project_runtimes((project,), all_projects=self.workspace.projects,
            workspace_root=self.root, source_files=iter_python_files(self.root),
            static_indexes={project.namespace: state.engine.static_index},
            static_snapshots={project.namespace: state.engine.source_snapshot})
        self.assertIn('fresh', value.surface['common.Shared']['instance'])
        self.assertIsNot(value.static_index.modules, state.engine.static_index.modules)

    def test_same_django_label_from_different_sources_keeps_both_models(self):
        for name in ('one', 'two'):
            self.write(f'{name}app/apps.py', 'from django.apps import AppConfig\n'
                f'class ConflictConfig(AppConfig):\n    name="{name}app"\n    label="inventory"\n')
            self.write(f'{name}app/models.py', 'from django.db import models\n'
                f'class Item(models.Model):\n    {name}_field = models.IntegerField()\n'
                '    class Meta:\n        app_label="inventory"\n')
            self.write(f'config/settings/{name}.py', "from .base import *\n"
                f"INSTALLED_APPS += ['{name}app.apps.ConflictConfig']\nPROFILE='{name}'\n")
        result = self.initialize()
        self.assertEqual(result['health']['runtime']['modelCount'], 3)
        sources = result['projectContexts'][0]['models']
        labels = {row['sourceModule']: label for label, row in sources.items() if row['djangoLabel'] == 'inventory.Item'}
        self.assertEqual(set(labels), {'oneapp.models', 'twoapp.models'})
        self.assertNotEqual(labels['oneapp.models'], labels['twoapp.models'])
        for name, other in (('one', 'two'), ('two', 'one')):
            label = labels[f'{name}app.models']
            self.assertEqual(sources[label]['filePath'], str(self.root / f'{name}app/models.py'))
            surface = result['surfaceIndex'][label]['instance']
            self.assertIn(name + '_field', surface)
            self.assertNotIn(other + '_field', surface)
        reply = self.workspace.request('resolveRelationTarget', {'value': 'inventory.Item'})
        self.assertFalse(reply['resolved'])
        self.assertEqual(len(reply['candidates']), 2)
        path = self.root / 'oneapp/models.py'
        path.write_text(path.read_text() + '\n    saved = models.BooleanField(default=False)\n')
        changed = self.workspace.reindex_file({'filePath': str(path)})
        self.assertIn('saved', changed['surfaceIndexDelta'][labels['oneapp.models']]['instance'])
        self.assertNotIn('saved', changed['surfaceIndexDelta'][labels['twoapp.models']]['instance'])

    def test_query_creation_failure_does_not_discard_a_ready_registry(self):
        path = self.root / 'common/models.py'
        text = path.read_text().replace('class Shared(models.Model):',
            'class UnavailableQueryManager(models.Manager.from_queryset(SharedQuerySet)):\n'
            '    def get_queryset(self):\n        raise RuntimeError("metadata must work without a database")\n'
            'class Shared(models.Model):').replace('SharedQuerySet.as_manager()', 'UnavailableQueryManager()')
        path.write_text(text)
        result = self.initialize()
        self.assertEqual(result['health']['phase'], 'ready')
        self.assertEqual(result['health']['runtime']['readySettingsCount'], 2)
        shared = result['surfaceIndex'][self.label('common.Shared')]
        self.assertIn('title', shared['instance'])
        self.assertIn('only_one', shared['queryset'])
        self.assertIn('only_two', shared['queryset'])

    def test_one_concrete_settings_without_an_entrypoint_reaches_the_single_engine(self):
        (self.root / 'manage.py').unlink()
        (self.root / 'config/settings/two.py').unlink()
        with mock.patch.object(DaemonServer, '_initialize', return_value={'single': True}) as initialize:
            self.assertEqual(self.server._initialize({'workspaceRoot': str(self.root)}), {'single': True})
        self.assertEqual(initialize.call_args.args[0]['settingsModule'], 'config.settings.one')


class SettingsCatalogUnionTest(unittest.TestCase):
    def test_cyclic_transforms_and_dynamic_keys_merge_without_recursion_or_name_loss(self):
        union = CatalogUnion()
        for namespace, lookup, blocked in (('one', 'first', ['shared', 'only_one']), ('two', 'second', ['shared', 'only_two'])):
            union.add({'fields': {'model': {'data': namespace}}, 'types': {
                namespace: {'fieldKind': 'JSONField', 'lookups': [lookup], 'transforms': {'again': namespace},
                    'dynamicTransform': {'kind': 'key', 'outputType': namespace, 'blockedNames': blocked}}}})
        type_id = union.value['fields']['model']['data']
        result = union.value['types'][type_id]
        self.assertEqual(result['lookups'], ['first', 'second'])
        self.assertEqual(result['transforms']['again'], type_id)
        self.assertEqual(result['dynamicTransform']['outputType'], type_id)
        self.assertEqual(result['dynamicTransform']['blockedNames'], ['shared'])


if __name__ == '__main__':
    unittest.main()
