from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from django_orm_intellisense.discovery import workspace


class SettingsInventoryTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='djls-settings-inventory-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def source(self, name, text=''):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
        return path

    def profile(self, files=None):
        return workspace.discover_workspace(self.root, python_files=files)

    def test_settings_without_manage_py_are_not_dropped(self):
        self.source('config/settings.py', 'SECRET_KEY="test"\nINSTALLED_APPS=[]\n')
        profile = self.profile()
        self.assertEqual(profile.settings_candidates, ['config.settings'])
        self.assertEqual(profile.settings_module, 'config.settings')

    def test_deep_environment_settings_are_all_included(self):
        self.source('config/settings/__init__.py')
        self.source('config/settings/base.py')
        self.source('config/settings/development/__init__.py')
        self.source('config/settings/development/local.py')
        self.assertEqual(set(self.profile().settings_candidates), {
            'config.settings', 'config.settings.base',
            'config.settings.development', 'config.settings.development.local'})

    def test_independent_projects_keep_local_module_names_and_owners(self):
        for project in ('payroll', 'billing'):
            self.source(f'services/{project}/manage.py',
                "import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.production')\n")
            self.source(f'services/{project}/config/production.py', 'INSTALLED_APPS=[]\n')
        profile = self.profile()
        sources = {source.selector: source for source in profile.settings_sources}
        self.assertEqual(set(sources), {
            'services.payroll.config.production', 'services.billing.config.production'})
        for project in ('payroll', 'billing'):
            source = sources[f'services.{project}.config.production']
            self.assertEqual(source.module, 'config.production')
            self.assertEqual(source.project_root, str(self.root / 'services' / project))
            self.assertEqual(source.import_root, source.project_root)
            self.assertEqual(source.entrypoints, (str(self.root / 'services' / project / 'manage.py'),))

    def test_assignment_declaration_and_os_alias_are_discovered(self):
        self.source('service/manage.py',
            "import os as operating\noperating.environ['DJANGO_SETTINGS_MODULE']='config.production'\n")
        self.source('service/config/production.py')
        self.assertIn('service.config.production', self.profile().settings_candidates)

    def test_imported_environ_and_constant_declaration(self):
        self.source('manage.py', "from os import environ as env\n"
            "DEFAULT='config.development'\nenv.setdefault('DJANGO_SETTINGS_MODULE', DEFAULT)\n")
        self.source('config/development.py')
        self.assertEqual(self.profile().settings_module, 'config.development')

    def test_comment_and_docstring_do_not_override_real_declaration(self):
        self.source('manage.py', '''"""os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'fake.doc')"""
# os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'fake.comment')
import os
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.real')
''')
        self.source('config/real.py')
        profile = self.profile()
        self.assertEqual(profile.settings_module, 'config.real')
        self.assertNotIn('fake.doc', profile.settings_candidates)
        self.assertNotIn('fake.comment', profile.settings_candidates)

    def test_settings_discovery_does_not_execute_project_code(self):
        marker = self.root / 'executed'
        self.source('manage.py', f'import os\nraise RuntimeError("must not execute")\n'
            "os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')\n")
        self.source('config/settings.py', f'open({str(marker)!r}, "w").write("bad")\n')
        self.assertEqual(self.profile().settings_module, 'config.settings')
        self.assertFalse(marker.exists())

    def test_existing_snapshot_is_reused_without_another_directory_walk(self):
        files = [self.source('manage.py', "import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE','config.custom')\n"),
                 self.source('config/custom.py')]
        with mock.patch.object(workspace, 'iter_python_files', side_effect=AssertionError('unexpected source walk')):
            self.assertEqual(self.profile(tuple(files)).settings_module, 'config.custom')

    def test_external_editable_settings_are_not_mistaken_for_repository_projects(self):
        local = self.source('config/settings.py')
        with tempfile.TemporaryDirectory() as other:
            external = Path(other) / 'settings.py'
            external.write_text('INSTALLED_APPS=[]\n', encoding='utf-8')
            self.assertEqual(self.profile((local, external)).settings_candidates, ['config.settings'])

    def test_asgi_only_project_keeps_its_settings_variants_together(self):
        self.source('services/api/config/asgi.py',
            "import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE','config.settings.dev')\n")
        self.source('services/api/config/settings/__init__.py')
        self.source('services/api/config/settings/base.py')
        self.source('services/api/config/settings/dev.py')
        sources = self.profile().settings_sources
        self.assertEqual({source.project_root for source in sources}, {str(self.root / 'services/api')})
        self.assertTrue(all(source.module.startswith('config.settings') for source in sources))

    def test_src_import_root_is_distinct_from_project_root(self):
        self.source('services/api/manage.py',
            "import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE','config.settings')\n")
        self.source('services/api/src/config/settings.py')
        source, = self.profile().settings_sources
        self.assertEqual(source.project_root, str(self.root / 'services/api'))
        self.assertEqual(source.import_root, str(self.root / 'services/api/src'))
        self.assertEqual(source.module, 'config.settings')

    def test_separate_projects_without_entrypoints_keep_separate_roots(self):
        self.source('services/one/config/settings.py', 'INSTALLED_APPS=[]\n')
        self.source('services/two/config/settings.py', 'INSTALLED_APPS=[]\n')
        self.assertEqual({source.project_root for source in self.profile().settings_sources},
                         {str(self.root / 'services/one'), str(self.root / 'services/two')})

    def test_all_src_variants_use_the_declared_import_root(self):
        self.source('api/manage.py', "import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE','config.settings.dev')\n")
        self.source('api/src/config/settings/__init__.py')
        self.source('api/src/config/settings/base.py')
        self.source('api/src/config/settings/dev.py')
        self.source('api/src/config/settings/prod.py')
        sources = self.profile().settings_sources
        self.assertEqual(len(sources), 4)
        self.assertTrue(all(source.import_root == str(self.root / 'api/src') for source in sources))
        self.assertTrue(all(source.module.startswith('config.settings') for source in sources))

    def test_unreadable_encoding_does_not_abort_other_project_discovery(self):
        path = self.source('bad/manage.py')
        path.write_bytes(b'\xff\xfe\x00')
        self.source('good/manage.py', "import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE','cfg.live')\n")
        self.source('good/cfg/live.py')
        self.assertIn('good.cfg.live', self.profile().settings_candidates)


if __name__ == '__main__':
    unittest.main()
