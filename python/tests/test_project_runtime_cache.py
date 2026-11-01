"""Real independent registry restarts must validate every reusable input."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import test_same_root_settings as fixtures
from django_orm_intellisense.server.project_daemon import ProjectDaemonServer


class ProjectRuntimeCacheTest(unittest.TestCase):
    write = fixtures.SameRootSettingsTest.write

    def setUp(self):
        self.cache = tempfile.TemporaryDirectory(prefix='djls-project-cache-')
        self.addCleanup(self.cache.cleanup)
        patch = mock.patch.dict(os.environ, {'DJANGO_ORM_INTELLISENSE_CACHE_DIR': self.cache.name})
        patch.start()
        self.addCleanup(patch.stop)
        fixtures.SameRootSettingsTest.setUp(self)

    def run_server(self):
        previous = sys.stdout
        try:
            server = ProjectDaemonServer(self.root)
        finally:
            sys.stdout = previous
        self.addCleanup(server._close_projects)
        with mock.patch('subprocess.Popen', wraps=subprocess.Popen) as spawn:
            result = server._initialize({'workspaceRoot': str(self.root)})
        workers = sum('django_orm_intellisense._project_runtime_worker' in call.args[0]
            for call in spawn.call_args_list)
        server._close_projects()
        return result, workers

    def test_unchanged_restart_restores_both_profiles_without_registry_workers(self):
        cold, first = self.run_server()
        warm, second = self.run_server()
        self.assertEqual(first, 2)
        self.assertEqual(second, 0, 'An unchanged restart repeated both Django registries')
        for key in ('surfaceIndex', 'surfaceFingerprints', 'lookupCatalog', 'projectContexts'):
            self.assertEqual(json.loads(json.dumps(cold[key])), json.loads(json.dumps(warm[key])), key)
        self.assertEqual(warm['health']['runtime']['readySettingsCount'], 2)

    def test_equal_size_source_replacement_with_restored_mtime_misses(self):
        self.run_server()
        path = self.root / 'common/models.py'
        before = path.stat()
        path.write_text(path.read_text().replace('title =', 'other ='))
        os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
        result, workers = self.run_server()
        self.assertEqual(workers, 2)
        shared = next(label for label in result['surfaceIndex'] if label.endswith('.common.Shared'))
        self.assertIn('other', result['surfaceIndex'][shared]['instance'])
        self.assertNotIn('title', result['surfaceIndex'][shared]['instance'])

    def test_changed_environment_misses(self):
        self.run_server()
        with mock.patch.dict(os.environ, {'DJLS_PROJECT_CACHE_FIXTURE': 'changed'}):
            _, workers = self.run_server()
        self.assertEqual(workers, 2)

    def test_config_read_and_previously_missing_config_creation_miss(self):
        settings = self.root / 'config/settings/base.py'
        settings.write_text(settings.read_text() + '\nfrom pathlib import Path\n'
            'config = Path(__file__).parents[2] / "profile.conf"\n'
            'CONFIG_VALUE = config.read_text() if config.exists() else "absent"\n')
        self.run_server()
        self.assertEqual(self.run_server()[1], 0)
        config = self.write('profile.conf', 'first')
        self.assertEqual(self.run_server()[1], 2)
        self.assertEqual(self.run_server()[1], 0)
        before = config.stat()
        config.write_text('other')
        os.utime(config, ns=(before.st_atime_ns, before.st_mtime_ns))
        self.assertEqual(self.run_server()[1], 2)

    def test_failed_profile_is_retried_while_successful_profile_is_restored(self):
        path = self.root / 'config/settings/two.py'
        path.write_text(path.read_text() + 'raise RuntimeError("not ready")\n')
        cold, _ = self.run_server()
        warm, workers = self.run_server()
        self.assertEqual(cold['health']['runtime']['readySettingsCount'], 1)
        self.assertEqual(warm['health']['runtime']['readySettingsCount'], 1)
        self.assertEqual(workers, 1, 'A failed profile was reused, or a successful profile was recollected')

    def test_corrupt_record_recollects_only_its_profile(self):
        self.run_server()
        records = sorted(Path(self.cache.name).rglob('profile-*.json'))
        self.assertEqual(len(records), 2)
        records[0].write_text('{"incomplete":')
        result, workers = self.run_server()
        self.assertEqual(workers, 1)
        self.assertEqual(result['health']['runtime']['readySettingsCount'], 2)

    def test_dependency_replacement_outside_the_source_inventory_misses(self):
        with tempfile.TemporaryDirectory(prefix='djls-config-dependency-') as directory:
            dependency = Path(directory) / 'fixture_dependency.py'
            dependency.write_text('VALUE = "first"\n')
            settings = self.root / 'config/settings/base.py'
            settings.write_text(settings.read_text() + f'\nimport sys\nsys.path.insert(0, {directory!r})\n'
                'import fixture_dependency\nDEPENDENCY = fixture_dependency.VALUE\n')
            self.run_server()
            self.assertEqual(self.run_server()[1], 0)
            before = dependency.stat()
            dependency.write_text('VALUE = "other"\n')
            os.utime(dependency, ns=(before.st_atime_ns, before.st_mtime_ns))
            self.assertEqual(self.run_server()[1], 2)

    def test_code_and_interpreter_identity_changes_miss(self):
        from django_orm_intellisense.cache import projects
        self.run_server()
        with mock.patch.object(projects, 'analysis_code_fingerprint', return_value='new-analysis-code'):
            self.assertEqual(self.run_server()[1], 2)
        self.run_server()
        actual = projects.input_identity
        def replaced(path, *args):
            identity = actual(path, *args)
            return [*identity[:-1], identity[-1] + 1] if str(path) == sys.executable else identity
        with mock.patch.object(projects, 'input_identity', side_effect=replaced):
            self.assertEqual(self.run_server()[1], 2)

    def test_cancelled_and_partial_writes_preserve_prior_complete_json(self):
        self.run_server()
        from django_orm_intellisense.cache.projects import ProjectRuntimeCache
        from django_orm_intellisense.discovery.workspace import snapshot_python_sources
        from django_orm_intellisense.discovery.settings import settings_projects
        from django_orm_intellisense.discovery.workspace import discover_workspace
        snapshot = snapshot_python_sources(self.root, max_workers=1)
        projects = settings_projects(self.root, discover_workspace(self.root).settings_sources)
        cache = ProjectRuntimeCache(self.root, projects, snapshot, 'control')
        path = cache._path(projects[0], 'profile')
        before = path.read_bytes()
        count = 0
        def current():
            nonlocal count
            count += 1
            return count < 8
        cache._write(path, {'values': list(range(5000))}, current)
        self.assertEqual(path.read_bytes(), before)
        cache._write(path, {'invalid': object()}, lambda: True)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(list(cache.directory.glob('*.tmp')), [])

    def test_new_daemon_process_restores_the_same_registry_union(self):
        script = ('import json,sys\n'
            'from django_orm_intellisense.server.project_daemon import ProjectDaemonServer\n'
            'import django_orm_intellisense.runtime.projects as workers\n'
            'original=workers.subprocess.Popen\ncount=[0]\n'
            'def spawn(args,*a,**kw):\n'
            ' count[0] += "django_orm_intellisense._project_runtime_worker" in args\n'
            ' return original(args,*a,**kw)\n'
            'workers.subprocess.Popen=spawn\n'
            's=ProjectDaemonServer(sys.argv[1])\n'
            'r=s._initialize({"workspaceRoot":sys.argv[1]})\n'
            'sys.__stdout__.write(json.dumps({"workers":count[0],"surface":r["surfaceIndex"],'
            '"lookups":r["lookupCatalog"],"ready":r["health"]["runtime"]["readySettingsCount"]}))\n'
            's._close_projects()\n')
        def run():
            result = subprocess.run([sys.executable, '-B', '-c', script, str(self.root)],
                capture_output=True, text=True, timeout=25)
            self.assertEqual(result.returncode, 0, result.stderr[-2000:])
            return json.loads(result.stdout)
        cold, warm = run(), run()
        self.assertEqual(cold.pop('workers'), 2)
        self.assertEqual(warm.pop('workers'), 0)
        self.assertEqual(warm, cold)

    def test_source_change_during_restore_is_revalidated_before_publication(self):
        self.run_server()
        from django_orm_intellisense.cache.projects import ProjectRuntimeCache
        original = ProjectRuntimeCache.load
        changed = False
        def load(cache, *args):
            nonlocal changed
            value = original(cache, *args)
            if value is not None and not changed:
                changed = True
                path = self.root / 'common/models.py'
                path.write_text(path.read_text() + '\n    current = models.BooleanField(default=False)\n')
            return value
        with mock.patch.object(ProjectRuntimeCache, 'load', load):
            result, workers = self.run_server()
        shared = next(label for label in result['surfaceIndex'] if label.endswith('.common.Shared'))
        self.assertEqual(workers, 2)
        self.assertIn('current', result['surfaceIndex'][shared]['instance'])

    def test_clear_workspace_cache_removes_the_shared_seed_and_every_profile(self):
        import shutil
        from django_orm_intellisense.cache import store
        self.run_server()
        directory = store._workspace_cache_dir(self.root)
        self.assertEqual(len(list(directory.rglob('seed-*.json'))), 1)
        self.assertEqual(len(list(directory.rglob('profile-*.json'))), 2)
        shutil.rmtree(directory)
        self.assertEqual(self.run_server()[1], 2)


if __name__ == '__main__':
    unittest.main()
