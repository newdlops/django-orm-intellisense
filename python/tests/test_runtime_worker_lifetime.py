import contextlib
import dataclasses
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.server import runtime_members, worker_lifetime, worker_state
from django_orm_intellisense.static_index.indexer import build_static_index


def _restore_after_gate(state, marker, release):
    Path(marker).write_text(str(os.getpid()))
    deadline = time.monotonic() + 60
    while not Path(release).exists() and time.monotonic() < deadline:
        time.sleep(0.01)
    return state


class _BlockedSnapshot:
    def __init__(self, state, marker, release):
        self.state, self.marker, self.release = state, str(marker), str(release)

    def __reduce__(self):
        return _restore_after_gate, (self.state, self.marker, self.release)


class RuntimeWorkerLifetimeTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix='djls-runtime-lifetime-test-')
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        (self.root / 'blog').mkdir()
        (self.root / 'blog/__init__.py').write_text('')
        (self.root / 'blog/models.py').write_text(
            'from django.db import models\nclass Post(models.Model):\n'
            '    value=models.CharField(max_length=20)\n'
            '    def fresh(self) -> str:\n        return "current"\n')
        (self.root / 'fixture_settings.py').write_text(
            'SECRET_KEY="test"\nINSTALLED_APPS=["blog"]\n'
            'DATABASES={"default":{"ENGINE":"django.db.backends.sqlite3","NAME":":memory:"}}\n'
            'DEFAULT_AUTO_FIELD="django.db.models.AutoField"\n')
        self.static = build_static_index(self.root)
        self.runtime = dataclasses.replace(create_pending_runtime_inspection('fixture_settings'), bootstrap_status='ready')
        self.graph = build_model_graph(self.static, self.runtime)
        self.stopping = threading.Event()
        # The deliberately pickled gate helper is a declared test dependency.
        # A selected worker must not inherit unittest's implicit sys.path edits.
        helper_path = str(Path(__file__).resolve().parent)
        declared = os.environ.get('PYTHONPATH')
        test_path = helper_path if declared is None else helper_path + os.pathsep + declared
        environment = mock.patch.dict(os.environ, {'PYTHONPATH': test_path})
        environment.start()
        self.addCleanup(environment.stop)
        self.marker, self.release = self.root / 'entered', self.root / 'release'
        self.processes = []
        self.paths = []
        self.addCleanup(self.cleanup_processes)

    def cleanup_processes(self):
        self.stopping.set()
        for process in self.processes:
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=1)

    def wait_for_marker(self, process):
        deadline = time.monotonic() + 10
        while not self.marker.exists() and process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(self.marker.exists(), 'Actual worker did not enter full-state loading')
        self.assertEqual(int(self.marker.read_text()), process.pid)

    def refresh(self, static=None):
        return runtime_members.refresh_in_process(self.static if static is None else static,
            self.runtime, self.graph, self.root, (), lambda: True, self.stopping)

    def record_spawn(self, original, observed):
        def start(argv, **kwargs):
            self.paths.append(Path(argv[3]))
            process = original(argv, **kwargs)
            self.processes.append(process)
            observed.append((argv, kwargs, process))
            return process
        return start

    def test_parent_channel_eof_stops_worker_blocked_loading_full_state(self):
        wrapped = _BlockedSnapshot(self.static, self.marker, self.release)
        with worker_state.runtime_member_refresh_state_file(wrapped, self.runtime, self.graph, None) as name:
            path = Path(name)
            with path.with_suffix('.log').open('wb') as errors:
                with worker_lifetime.ParentExitPipe() as channel:
                    arguments, options = channel.spawn_parameters()
                    process = subprocess.Popen([sys.executable, '-B', '-m',
                        'django_orm_intellisense.server.runtime_member_worker', name,
                        str(path.with_name('result.pickle')), str(self.root), *arguments],
                        cwd=self.root, env=dict(os.environ, PYTHONPATH=os.pathsep.join(sys.path)),
                        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=errors, **options)
                    self.processes.append(process)
                    channel.child_spawned()
                    self.wait_for_marker(process)
                started = time.monotonic()
                self.assertEqual(process.wait(timeout=3), 0)
                print(json.dumps({'event': 'owned_runtime_worker_eof', 'pid': process.pid,
                    'exitCode': process.returncode, 'elapsedSeconds': time.monotonic() - started}), file=sys.stderr)
        self.assertFalse(path.parent.exists())

    def test_normal_fresh_worker_preserves_complete_metadata_and_cleans_files(self):
        from django.apps import apps
        parent_ready = apps.ready
        observed = []
        original = subprocess.Popen
        with mock.patch.object(runtime_members.subprocess, 'Popen', self.record_spawn(original, observed)):
            result = self.refresh()
        self.assertEqual(apps.ready, parent_ready, 'Worker app population leaked into the parent')
        self.assertEqual(len(observed), 1)
        argv, options, process = observed[0]
        self.assertEqual(argv[0], self.runtime.python_executable)
        self.assertEqual(argv[1:3], ['-m', 'django_orm_intellisense._runtime_member_worker'])
        self.assertIn(argv[-2], ('--parent-exit-fd', '--parent-exit-handle'))
        self.assertEqual(process.returncode, 0)
        self.assertEqual(result.runtime_metadata['modelCount'], 1)
        self.assertEqual(result.runtime_metadata['fieldCount'], 2)
        self.assertEqual(result.surface['blog.Post']['instance']['value'],
            ('scalar', 'blog.Post', 'field', 'CharField'))
        names = {item.name for item in result.snapshot.items[('blog.Post', 'instance', None)]}
        self.assertIn('fresh', names)
        self.assertTrue(all(not path.parent.exists() for path in self.paths))

    def test_stopping_before_refresh_skips_serialization_and_spawn(self):
        self.stopping.set()
        with mock.patch.object(runtime_members, 'runtime_member_refresh_state_file',
                side_effect=AssertionError('Stopped refresh serialized metadata')), \
                mock.patch.object(runtime_members.subprocess, 'Popen') as spawn:
            self.assertIsNone(self.refresh())
        spawn.assert_not_called()

    def test_stopping_during_serialization_skips_spawn_and_cleans_files(self):
        original = runtime_members.runtime_member_refresh_state_file
        paths = []
        @contextlib.contextmanager
        def stop_after_snapshot(*args):
            with original(*args) as name:
                paths.append(Path(name))
                self.stopping.set()
                yield name
        with mock.patch.object(runtime_members, 'runtime_member_refresh_state_file', stop_after_snapshot), \
                mock.patch.object(runtime_members.subprocess, 'Popen',
                    side_effect=AssertionError('Stopped refresh spawned a worker')):
            self.assertIsNone(self.refresh())
        self.assertTrue(paths)
        self.assertTrue(all(not path.parent.exists() for path in paths))

    def test_spawn_failure_closes_parent_handles_and_private_files(self):
        channels, captured = [], []
        class ObservedChannel(worker_lifetime.ParentExitPipe):
            def __init__(channel):
                super().__init__()
                channels.append(channel)
        failure = OSError('owned runtime spawn failed')
        def fail(argv, **kwargs):
            captured.append((Path(argv[3]), kwargs['stderr']))
            raise failure
        before = set(worker_lifetime._pipe_fds)
        with mock.patch.object(runtime_members, 'ParentExitPipe', ObservedChannel), \
                mock.patch.object(runtime_members.subprocess, 'Popen', fail):
            with self.assertRaises(OSError) as raised:
                self.refresh()
        self.assertIs(raised.exception, failure)
        self.assertEqual(len(channels), 1)
        self.assertTrue(all(channel.reader is None and channel.writer is None for channel in channels))
        self.assertEqual(worker_lifetime._pipe_fds, before)
        self.assertFalse(captured[0][0].parent.exists())
        self.assertTrue(captured[0][1].closed)

    def test_child_registration_failure_reaps_actual_worker_and_closes_handles(self):
        channels, observed = [], []
        failure = OSError('owned runtime registration failed')
        class FailedChannel(worker_lifetime.ParentExitPipe):
            def __init__(channel):
                super().__init__()
                channels.append(channel)
            def child_spawned(channel):
                super().child_spawned()
                raise failure
        before = set(worker_lifetime._pipe_fds)
        original = subprocess.Popen
        wrapped = _BlockedSnapshot(self.static, self.marker, self.release)
        with mock.patch.object(runtime_members, 'ParentExitPipe', FailedChannel), \
                mock.patch.object(runtime_members.subprocess, 'Popen', self.record_spawn(original, observed)):
            with self.assertRaises(OSError) as raised:
                self.refresh(wrapped)
        self.assertIs(raised.exception, failure)
        self.assertEqual(len(observed), 1)
        self.assertIsNotNone(observed[0][2].poll())
        self.assertTrue(all(channel.reader is None and channel.writer is None for channel in channels))
        self.assertEqual(worker_lifetime._pipe_fds, before)
        self.assertTrue(all(not path.parent.exists() for path in self.paths))
        self.assertTrue(observed[0][1]['stderr'].closed)

    def test_cancellation_reaps_actual_worker_blocked_loading_state(self):
        observed, results, failures = [], [], []
        original = subprocess.Popen
        wrapped = _BlockedSnapshot(self.static, self.marker, self.release)
        def refresh():
            try:
                results.append(self.refresh(wrapped))
            except BaseException as error:
                failures.append(error)
        before = set(worker_lifetime._pipe_fds)
        with mock.patch.object(runtime_members.subprocess, 'Popen', self.record_spawn(original, observed)):
            thread = threading.Thread(target=refresh, daemon=True)
            thread.start()
            try:
                deadline = time.monotonic() + 10
                while not self.processes and thread.is_alive() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertEqual(len(self.processes), 1)
                self.wait_for_marker(self.processes[0])
            finally:
                self.stopping.set()
                thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(results, [None])
        self.assertEqual(failures, [])
        self.assertIsNotNone(self.processes[0].poll())
        self.assertEqual(worker_lifetime._pipe_fds, before)
        self.assertTrue(all(not path.parent.exists() for path in self.paths))

    def test_stop_at_process_exit_discards_result_and_closes_owned_files(self):
        captured = []
        def finished():
            self.stopping.set()
            return 0
        process = mock.Mock(returncode=0, poll=finished)
        def start(argv, **kwargs):
            captured.append((Path(argv[3]), kwargs['stderr']))
            return process
        before = set(worker_lifetime._pipe_fds)
        with mock.patch.object(runtime_members.subprocess, 'Popen', start):
            self.assertIsNone(self.refresh())
        process.terminate.assert_not_called()
        self.assertEqual(worker_lifetime._pipe_fds, before)
        self.assertFalse(captured[0][0].parent.exists())
        self.assertTrue(captured[0][1].closed)


if __name__ == '__main__':
    unittest.main()
