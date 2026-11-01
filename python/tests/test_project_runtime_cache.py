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

    def test_deferred_restart_returns_before_restoring_registries(self):
        from django_orm_intellisense.cache.projects import ProjectRuntimeCache
        cold, _ = self.run_server()
        original, restored = ProjectRuntimeCache.load, []
        def load(cache, *args):
            restored.append(args[0].namespace)
            return original(cache, *args)
        with mock.patch.object(ProjectRuntimeCache, 'load', load):
            with mock.patch.object(self.server, '_schedule_project_refresh') as schedule:
                initial = self.server._initialize({'workspaceRoot': str(self.root), 'deferRuntime': True})
            self.assertEqual(restored, [], 'Deferred initialization restored registries before its first response')
            self.assertTrue(initial['runtimeMembersPending'])
            schedule.assert_called_once()
            coordinator = self.server._projects
            selected = tuple(project for project in coordinator.projects if project.namespace in coordinator.pending)
            with mock.patch('subprocess.Popen', wraps=subprocess.Popen) as spawn:
                self.server._collect_projects(coordinator, self.server._state_generation,
                    self.server._projects_revision, selected, publish=True)
        workers = sum('django_orm_intellisense._project_runtime_worker' in call.args[0]
            for call in spawn.call_args_list)
        self.assertEqual(len(restored), 2)
        self.assertEqual(workers, 0, 'Deferred cache hits recollected unchanged registries')
        final = self.server._combined_payload()
        self.assertEqual(final['health']['runtime']['readySettingsCount'], 2)
        for key in ('surfaceIndex', 'surfaceFingerprints', 'lookupCatalog', 'projectContexts'):
            self.assertEqual(json.loads(json.dumps(cold[key])), json.loads(json.dumps(final[key])), key)

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
        records = sorted(Path(self.cache.name).rglob('profile-*.json*'))
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
        self.assertEqual(len(list(directory.rglob('profile-*.json*'))), 2)
        shutil.rmtree(directory)
        self.assertEqual(self.run_server()[1], 2)

    def external_lookup(self, directory):
        path = Path(directory) / 'lookup.conf'
        path.write_text('first')
        settings = self.root / 'config/settings/base.py'
        settings.write_text(settings.read_text() + f'\nfrom pathlib import Path\nCONFIG_VALUE=Path({str(path)!r}).read_text()\n')
        apps = self.root / 'common/apps.py'
        apps.write_text(apps.read_text().replace('lookup_name="from_" + settings.PROFILE',
            'lookup_name="from_" + settings.PROFILE + "_" + settings.CONFIG_VALUE'))
        return path

    def assert_current_lookup(self, result):
        label = next(label for label in result['lookupCatalog']['fields'] if label.endswith('.common.Shared'))
        table = result['lookupCatalog']
        names = table['types'][table['fields'][label]['title']]['lookups']
        for profile in ('one', 'two'):
            self.assertIn(f'from_{profile}_other', names)
            self.assertNotIn(f'from_{profile}_first', names)

    def test_external_input_replacement_after_last_restore_is_retried(self):
        from django_orm_intellisense.cache.projects import ProjectRuntimeCache
        with tempfile.TemporaryDirectory(prefix='djls-external-adoption-') as directory:
            path = self.external_lookup(directory)
            self.run_server()
            original, restored = ProjectRuntimeCache.load, []
            def load(cache, *args):
                value = original(cache, *args)
                if value is not None:
                    restored.append(value)
                if len(restored) == 2:
                    before = path.stat()
                    path.write_text('other')
                    os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
                return value
            with mock.patch.object(ProjectRuntimeCache, 'load', load):
                result, workers = self.run_server()
            self.assertEqual(workers, 2, 'A dependency changed after cache validation but stale metadata was published')
            self.assert_current_lookup(result)

    def test_external_input_replacement_after_worker_yield_is_retried(self):
        from django_orm_intellisense.server import project_daemon
        with tempfile.TemporaryDirectory(prefix='djls-external-live-') as directory:
            path = self.external_lookup(directory)
            original, changed = project_daemon.collect_project_runtimes, False
            def collect(*args, **kwargs):
                nonlocal changed
                for value in original(*args, **kwargs):
                    if not changed:
                        changed = True
                        path.write_text('other')
                    yield value
            with mock.patch.object(project_daemon, 'collect_project_runtimes', collect):
                result, workers = self.run_server()
            self.assertEqual(workers, 3)
            self.assert_current_lookup(result)

    def test_input_race_detected_inside_worker_is_retried(self):
        with tempfile.TemporaryDirectory(prefix='djls-external-worker-') as directory:
            path = self.external_lookup(directory)
            settings = self.root / 'config/settings/base.py'
            flag = Path(directory) / 'written'
            settings.write_text(settings.read_text() + f'\nflag=Path({str(flag)!r})\n'
                f'if not flag.exists():\n    Path({str(path)!r}).write_text("other")\n    flag.write_text("yes")\n')
            result, workers = self.run_server()
            self.assertEqual(workers, 3)
            self.assert_current_lookup(result)

    def test_successful_save_refresh_persists_the_current_source_generation(self):
        from django_orm_intellisense.server import project_daemon
        self.server._initialize({'workspaceRoot': str(self.root)})
        path = self.root / 'common/models.py'
        path.write_text(path.read_text() + '\n    fresh = models.BooleanField(default=False)\n')
        with mock.patch.object(self.server, '_schedule_project_refresh'):
            self.server._reindex_file({'filePath': str(path)})
        self.server._collect_projects(self.server._projects, self.server._state_generation,
            self.server._projects_revision, self.server._projects.projects)
        self.server._close_projects()
        with mock.patch.object(project_daemon, 'build_static_index', wraps=project_daemon.build_static_index) as parse:
            result, workers = self.run_server()
        self.assertEqual(workers, 0, 'A successful source refresh wrote obsolete restart cache bindings')
        self.assertEqual(parse.call_count, 0, 'The current shared source seed was not persisted')
        shared = next(label for label in result['surfaceIndex'] if label.endswith('.common.Shared'))
        self.assertIn('fresh', result['surfaceIndex'][shared]['instance'])

    def test_unsupported_input_observation_is_not_reported_as_an_input_race(self):
        from django_orm_intellisense.runtime.project_inputs import ProjectInputs
        path = self.write('input.conf', 'unchanged')
        inputs = ProjectInputs(())
        with inputs.observe():
            os.stat(path, follow_symlinks=False)
        self.assertIsNone(inputs.snapshot())
        self.assertFalse(inputs.changed)

    def test_unaffected_independent_profiles_keep_valid_cache_bindings_after_an_edit(self):
        from test_project_runtime_isolation import IndependentProjectRuntimeTest
        one = IndependentProjectRuntimeTest.project(self, 'nested_one', 'first_only')
        IndependentProjectRuntimeTest.project(self, 'nested_two', 'second_only')
        self.server._initialize({'workspaceRoot': str(self.root)})
        path = one / 'inventory/models.py'
        path.write_text(path.read_text() + '\n    fresh = models.BooleanField(default=False)\n')
        with mock.patch.object(self.server, '_schedule_project_refresh'):
            self.server._reindex_file({'filePath': str(path)})
        coordinator = self.server._projects
        selected = tuple(project for project in coordinator.projects if project.namespace in coordinator.pending)
        self.assertEqual(len(selected), 1)
        self.server._collect_projects(coordinator, self.server._state_generation,
            self.server._projects_revision, selected)
        self.server._close_projects()
        result, workers = self.run_server()
        self.assertEqual(workers, 0, 'Unchanged profile caches lost their validated source ownership')
        self.assertEqual(result['health']['runtime']['readySettingsCount'], 4)

    def test_repetitive_restart_metadata_is_compressed_and_expanded_reads_are_bounded(self):
        from django_orm_intellisense.cache import projects as cache_module
        from django_orm_intellisense.discovery.workspace import snapshot_python_sources, discover_workspace
        from django_orm_intellisense.discovery.settings import settings_projects
        snapshot = snapshot_python_sources(self.root, max_workers=1)
        projects = settings_projects(self.root, discover_workspace(self.root).settings_sources)
        cache = cache_module.ProjectRuntimeCache(self.root, projects, snapshot, 'control')
        path = cache._path(projects[0], 'profile')
        record = {'rows': ['shared metadata ' * 1000] * 400}
        cache._write(path, record, lambda: True)
        self.assertLess(path.stat().st_size, 150000, 'Repetitive registry metadata consumed its full expanded disk size')
        self.assertEqual(cache._read(path), record)
        with mock.patch.object(cache_module, 'MAX_RECORD_BYTES', 100000):
            self.assertIsNone(cache._read(path), 'A small compressed file bypassed the expanded input limit')

    def test_truncated_compressed_record_recollects_instead_of_aborting_startup(self):
        self.run_server()
        path = next(Path(self.cache.name).rglob('profile-*.json.gz'))
        encoded = path.read_bytes()
        for damaged in (encoded[:-5], encoded[:10] + b'\x07' * 20):
            with self.subTest(truncated=len(damaged) > 30):
                path.write_bytes(damaged)
                result, workers = self.run_server()
                self.assertEqual(workers, 1)
                self.assertEqual(result['health']['runtime']['readySettingsCount'], 2)


if __name__ == '__main__':
    unittest.main()
