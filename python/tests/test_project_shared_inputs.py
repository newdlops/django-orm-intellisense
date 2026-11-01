import contextlib
import importlib.util
from pathlib import Path
import unittest
from unittest import mock

import test_same_root_settings as fixtures
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.runtime import projects as runtime


@unittest.skipUnless(importlib.util.find_spec('django'), 'Django is required')
class ProjectSharedInputsTest(unittest.TestCase):
    setUp = fixtures.SameRootSettingsTest.setUp
    write = fixtures.SameRootSettingsTest.write
    initialize = fixtures.SameRootSettingsTest.initialize
    label = fixtures.SameRootSettingsTest.label

    def test_same_source_seed_is_written_once_and_private_files_are_reaped(self):
        self.initialize()
        snapshot = snapshot_python_sources(self.root, max_workers=1)
        records = []
        original = runtime._private_state_file
        @contextlib.contextmanager
        def record(value, prefix):
            with original(value, prefix) as filename:
                records.append((prefix, Path(filename), Path(filename).stat().st_size))
                yield filename
        states = self.workspace.states
        with mock.patch.object(runtime, '_private_state_file', side_effect=record):
            values = list(runtime.collect_project_runtimes(self.workspace.projects,
                workspace_root=self.root, source_files=snapshot.files,
                static_indexes={key: state.engine.static_index for key, state in states.items()},
                static_snapshots={key: state.engine.source_snapshot for key, state in states.items()}))
        self.assertEqual(len(values), 2)
        self.assertTrue(all(isinstance(value, runtime.ProjectRuntime) and value.inspection.bootstrap_status == 'ready' for value in values))
        seeds = [record for record in records if record[0] == 'djls-project-source-seed-']
        self.assertEqual(len(seeds), 1, 'The identical static seed was not shared across registry workers')
        self.assertTrue(all(not path.exists() for _, path, _ in records), 'Private generation files survived their collectors')
        first, second = values
        self.assertIn('only_one', first.surface['common.Shared']['queryset'])
        self.assertIn('only_two', second.surface['common.Shared']['queryset'])

    def test_membership_change_between_settings_rejects_the_old_generation(self):
        self.initialize()
        snapshot = snapshot_python_sources(self.root, max_workers=1)
        results = runtime.collect_project_runtimes(self.workspace.projects,
            workspace_root=self.root, source_files=snapshot.files)
        self.addCleanup(results.close)
        first = next(results)
        self.assertIsInstance(first, runtime.ProjectRuntime)
        self.write('new_helper.py', 'VALUE=1\n')
        second = next(results)
        self.assertIsInstance(second, runtime.ProjectRuntimeFailure,
            'The later registry silently adopted a different source generation')
        self.assertIn('source changed', second.error.lower())

    def test_current_coordinator_snapshot_does_not_repeat_initial_file_fingerprints(self):
        self.initialize()
        snapshot = snapshot_python_sources(self.root, max_workers=1)
        with mock.patch.object(runtime, 'snapshot_project_sources', wraps=runtime.snapshot_project_sources) as rebuilt:
            values = list(runtime.collect_project_runtimes(self.workspace.projects,
                workspace_root=self.root, source_files=snapshot.files, source_snapshot=snapshot))
        self.assertTrue(all(isinstance(value, runtime.ProjectRuntime) for value in values))
        self.assertEqual(rebuilt.call_count, 0, 'The current coordinator source snapshot was rebuilt for each profile')

    def test_same_root_source_selection_is_computed_once(self):
        self.initialize()
        snapshot = snapshot_python_sources(self.root, max_workers=1)
        with mock.patch.object(runtime, 'project_source_files', wraps=runtime.project_source_files) as select:
            values = list(runtime.collect_project_runtimes(self.workspace.projects,
                workspace_root=self.root, source_files=snapshot.files, source_snapshot=snapshot))
        self.assertTrue(all(isinstance(value, runtime.ProjectRuntime) for value in values))
        self.assertEqual(select.call_count, 1, 'Identical source ownership was selected for every settings profile')


if __name__ == '__main__':
    unittest.main()
