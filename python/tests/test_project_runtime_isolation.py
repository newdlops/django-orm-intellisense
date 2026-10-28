from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock

from django_orm_intellisense.discovery.settings import settings_projects
from django_orm_intellisense.discovery.workspace import discover_workspace, iter_python_files
from django_orm_intellisense.runtime.projects import ProjectRuntime, collect_project_runtimes


class ProjectPlanTest(unittest.TestCase):
    def test_all_complete_settings_are_collected_without_an_entrypoint(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'api/config/settings').mkdir(parents=True)
            for name in ('dev.py', 'prod.py'):
                (root / 'api/config/settings' / name).write_text('INSTALLED_APPS=[]\n')
            profile = discover_workspace(root)
            projects = settings_projects(root, profile.settings_sources)
            self.assertEqual({project.settings_module for project in projects}, {'config.settings.dev', 'config.settings.prod'})
            self.assertTrue(all(len(project.candidates) == 2 for project in projects))
            self.assertEqual(len({project.group_namespace for project in projects}), 1)

    def test_each_project_retains_its_declared_default_and_all_variants(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ('one', 'two'):
                folder = root / name
                (folder / 'config/settings').mkdir(parents=True)
                (folder / 'manage.py').write_text("import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE','config.settings.dev')\n")
                for filename in ('__init__.py', 'base.py', 'dev.py', 'prod.py'):
                    (folder / 'config/settings' / filename).write_text('')
            profile = discover_workspace(root)
            projects = settings_projects(root, profile.settings_sources)
            self.assertEqual(len(projects), 2)
            self.assertEqual(len({project.namespace for project in projects}), 2)
            for project in projects:
                self.assertEqual(project.settings_module, 'config.settings.dev')
                self.assertEqual(len(project.candidates), 4)
                self.assertEqual(project.root, project.import_root)


@unittest.skipUnless(importlib.util.find_spec('django'), 'Django is required for real independent registries')
class IndependentProjectRuntimeTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='djls-independent-projects-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def project(self, name, field, extra_settings=''):
        root = self.root / name
        for package in ('config', 'inventory'):
            (root / package).mkdir(parents=True)
            (root / package / '__init__.py').write_text('')
        (root / 'manage.py').write_text("import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE','config.settings')\n")
        (root / 'config/settings.py').write_text(
            "SECRET_KEY='fixture'\nINSTALLED_APPS=['inventory']\n"
            "DATABASES={'default':{'ENGINE':'django.db.backends.sqlite3','NAME':':memory:'}}\n"
            "DEFAULT_AUTO_FIELD='django.db.models.AutoField'\n" + extra_settings)
        method = name.replace('.', 'root')
        (root / 'inventory/models.py').write_text(
            'from django.db import models\n'
            f'class CustomQuerySet(models.QuerySet):\n    def only_{method}(self):\n        return self\n'
            'class Item(models.Model):\n'
            f'    {field} = models.CharField(max_length=20)\n'
            '    objects = CustomQuerySet.as_manager()\n')
        return root

    def test_nested_project_does_not_import_the_repository_root_settings(self):
        self.project('.', 'root_only')
        self.project('nested', 'nested_only')
        projects, files = self.plan()
        values = list(collect_project_runtimes(projects, workspace_root=self.root, source_files=files))
        self.assertEqual(len(values), 2)
        self.assertIn('root_only', values[0].surface['inventory.Item']['instance'])
        self.assertNotIn('nested_only', values[0].surface['inventory.Item']['instance'])
        self.assertIn('nested_only', values[1].surface['inventory.Item']['instance'])
        self.assertNotIn('root_only', values[1].surface['inventory.Item']['instance'])

    def plan(self):
        files = iter_python_files(self.root)
        profile = discover_workspace(self.root, python_files=files)
        return settings_projects(self.root, profile.settings_sources), files

    def test_same_module_app_and_model_names_remain_independent(self):
        self.project('one', 'only_first')
        self.project('two', 'only_second')
        projects, files = self.plan()
        from django.apps import apps
        from django.conf import settings
        before = settings.configured, apps.ready, os.environ.get('DJANGO_SETTINGS_MODULE')
        values = list(collect_project_runtimes(projects, workspace_root=self.root, source_files=files))
        self.assertEqual(len(values), 2)
        self.assertTrue(all(isinstance(value, ProjectRuntime) for value in values))
        self.assertEqual((settings.configured, apps.ready, os.environ.get('DJANGO_SETTINGS_MODULE')), before)
        for value, own_field, other_field, own_method, other_method in (
            (values[0], 'only_first', 'only_second', 'only_one', 'only_two'),
            (values[1], 'only_second', 'only_first', 'only_two', 'only_one'),
        ):
            self.assertEqual(value.inspection.bootstrap_status, 'ready')
            self.assertEqual(value.inspection.model_count, 1)
            model, = value.inspection.model_catalog
            self.assertEqual(model.label, 'inventory.Item')
            self.assertEqual(model.module, 'inventory.models')
            self.assertIn(own_field, model.field_names)
            self.assertNotIn(other_field, model.field_names)
            self.assertIn(own_field, value.surface['inventory.Item']['instance'])
            self.assertNotIn(other_field, value.surface['inventory.Item']['instance'])
            self.assertIn(own_method, value.surface['inventory.Item']['queryset'])
            self.assertNotIn(other_method, value.surface['inventory.Item']['queryset'])

    def test_failed_settings_do_not_prevent_the_next_project(self):
        self.project('one', 'first', 'raise RuntimeError("fixture settings failure")\n')
        self.project('two', 'second')
        projects, files = self.plan()
        values = list(collect_project_runtimes(projects, workspace_root=self.root, source_files=files))
        self.assertEqual(len(values), 2)
        self.assertEqual(values[0].inspection.bootstrap_status, 'setup_failed')
        self.assertIn('fixture settings failure', values[0].inspection.bootstrap_error)
        self.assertEqual(values[1].inspection.bootstrap_status, 'ready')
        self.assertIn('second', values[1].surface['inventory.Item']['instance'])

    def test_imported_sibling_app_is_owned_by_both_dependent_contexts(self):
        self.project('one', 'first', "INSTALLED_APPS=['inventory', 'two.partner']\n")
        two = self.project('two', 'second', "INSTALLED_APPS=['inventory', 'partner']\n")
        (two / 'partner').mkdir()
        (two / 'partner/__init__.py').write_text('')
        (two / 'partner/models.py').write_text(
            'from django.db import models\nclass Shared(models.Model):\n    shared = models.IntegerField()\n')
        projects, files = self.plan()
        values = list(collect_project_runtimes(projects, workspace_root=self.root, source_files=files))
        for value in values:
            self.assertIsInstance(value, ProjectRuntime)
            self.assertEqual(value.inspection.bootstrap_status, 'ready', value.inspection.bootstrap_error)
            self.assertIn('partner.Shared', value.surface)
        self.assertEqual(set(values[0].dependencies), {project.namespace for project in projects})
        refreshed, = collect_project_runtimes((projects[0],), all_projects=projects,
            workspace_root=self.root, source_files=files)
        self.assertNotIn('second', refreshed.surface['inventory.Item']['instance'])
        self.assertIn('shared', refreshed.surface['partner.Shared']['instance'])

    def test_source_changed_by_settings_is_not_adopted_as_the_old_snapshot(self):
        self.project('one', 'first',
            "from pathlib import Path\np=Path(__file__).parents[1]/'inventory/models.py'\n"
            "p.write_text(p.read_text().replace('first =', 'changed ='))\n")
        projects, files = self.plan()
        value, = collect_project_runtimes(projects, workspace_root=self.root, source_files=files)
        from django_orm_intellisense.runtime.projects import ProjectRuntimeFailure
        self.assertIsInstance(value, ProjectRuntimeFailure)
        self.assertIn('source changed', value.error)

    def test_cancellation_reaps_owned_child_and_removes_private_state(self):
        self.project('one', 'first', 'import time\ntime.sleep(10)\n')
        self.project('two', 'second')
        projects, files = self.plan()
        stopping = threading.Event()
        processes = []
        import subprocess
        original = subprocess.Popen

        def started(*args, **kwargs):
            child = original(*args, **kwargs)
            processes.append(child)
            return child

        state_root = self.root / 'private-state'
        state_root.mkdir()
        timer = threading.Timer(0.2, stopping.set)
        timer.start()
        try:
            with mock.patch('django_orm_intellisense.runtime.projects.subprocess.Popen', side_effect=started), \
                 mock.patch.object(tempfile, 'tempdir', str(state_root)):
                values = list(collect_project_runtimes(projects, workspace_root=self.root,
                    source_files=files, stopping=stopping))
        finally:
            timer.cancel()
            timer.join()
        self.assertEqual(values, [])
        self.assertEqual(len(processes), 1)
        self.assertIsNotNone(processes[0].poll())
        self.assertEqual(list(state_root.iterdir()), [])

    def test_complete_snapshot_does_not_wait_for_project_background_threads(self):
        self.project('one', 'first', 'import threading, time\n'
            'threading.Thread(target=time.sleep, args=(30,), daemon=False).start()\n')
        projects, files = self.plan()
        processes = []
        import subprocess
        original = subprocess.Popen
        def started(*args, **kwargs):
            child = original(*args, **kwargs)
            processes.append(child)
            return child
        with mock.patch('django_orm_intellisense.runtime.projects.subprocess.Popen', side_effect=started):
            value, = collect_project_runtimes(projects, workspace_root=self.root,
                source_files=files, timeout_seconds=4)
        self.assertIsInstance(value, ProjectRuntime)
        self.assertEqual(value.inspection.bootstrap_status, 'ready')
        self.assertIn('first', value.surface['inventory.Item']['instance'])
        self.assertEqual(len(processes), 1)
        self.assertIsNotNone(processes[0].poll())


if __name__ == '__main__':
    unittest.main()
