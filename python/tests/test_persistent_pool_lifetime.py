import io
import os
import sys
import tempfile
import threading
import time
import unittest
import weakref
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from unittest import mock

from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.server import app, worker_lifetime, worker_state
from django_orm_intellisense.static_index.indexer import build_static_index


def _wait_and_read_snapshot(marker, release):
    Path(marker).write_text(str(os.getpid()))
    deadline = time.monotonic() + 60
    while not Path(release).exists() and time.monotonic() < deadline:
        time.sleep(0.01)
    static_field = app._worker_static_index.find_field('blog.Post', 'value')
    graph_field = app._worker_model_graph.find_field('blog.Post', 'value')
    return (static_field.field_kind, graph_field.field_kind,
            static_field is graph_field, app._worker_runtime.bootstrap_status)


class _WeakPayload:
    def __init__(self):
        self.value = 'complete payload'


class PersistentPoolLifetimeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='djls-persistent-test-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        (self.root / 'blog').mkdir()
        (self.root / 'blog/__init__.py').write_text('')
        self.source = self.root / 'blog/models.py'
        self.source.write_text('from django.db import models\nclass Post(models.Model):\n    value=models.CharField()\n')
        self.index = build_static_index(self.root)
        self.runtime = create_pending_runtime_inspection(None)
        self.graph = build_model_graph(self.index, self.runtime)
        with mock.patch.object(sys, 'stdout', io.StringIO()):
            self.server = app.DaemonServer(self.root)
        self.server.static_index, self.server.runtime_inspection, self.server.model_graph = self.index, self.runtime, self.graph
        self.workers = []
        self.raw_pools = []
        self.paths = []
        self.addCleanup(self.cleanup_owned)
        patches = mock.patch.dict(os.environ, {'DJLS_BG_PROCESS_POOL': '1', 'DJLS_BG_PROCESS_POOL_PREWARM': '0'})
        patches.start()
        self.addCleanup(patches.stop)
        current = threading.current_thread()
        self.addCleanup(setattr, current, 'name', current.name)

    def factory(self, *args, **kwargs):
        if isinstance(kwargs['initargs'][0], str):
            self.paths.append(Path(kwargs['initargs'][0]))
        owner = self
        class ObservedExecutor(ProcessPoolExecutor):
            def submit(self, *args, **kwargs):
                future = super().submit(*args, **kwargs)
                owner.workers.extend(process for process in (self._processes or {}).values()
                                     if process not in owner.workers)
                return future
        pool = ObservedExecutor(*args, **kwargs)
        self.raw_pools.append(pool)
        return pool

    def rebuild(self):
        with mock.patch.object(app.os, 'cpu_count', return_value=1), \
                mock.patch.object(app, 'ProcessPoolExecutor', self.factory):
            self.server._rebuild_bg_pool()
        self.assertIsNotNone(self.server._bg_pool)
        return self.server._bg_pool

    def entered_task(self, pool, label):
        marker, release = self.root / (label + '.entered'), self.root / (label + '.release')
        future = pool.submit(_wait_and_read_snapshot, str(marker), str(release))
        deadline = time.monotonic() + 10
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(marker.exists(), 'Actual persistent worker did not enter its task')
        self.assertTrue(any(process.pid == int(marker.read_text()) for process in self.workers))
        return future, release

    def close_stdio(self):
        with mock.patch.object(sys, 'stdin', io.StringIO('')):
            self.server.run_stdio()

    def cleanup_owned(self):
        self.server._stopping.set()
        for worker in self.workers:
            if worker.is_alive():
                worker.terminate()
            worker.join(3)
        pool = self.server._bg_pool
        if pool is not None:
            pool.shutdown(wait=False)
        for pool in self.raw_pools:
            pool.shutdown(wait=False)

    def assert_eof_stops_workers(self):
        deadline = time.monotonic() + 3
        self.close_stdio()
        for worker in self.workers:
            worker.join(max(0, deadline - time.monotonic()))
        self.assertTrue(all(not worker.is_alive() for worker in self.workers), 'EOF left an owned pool worker alive')
        self.assertTrue(all(worker.exitcode == 0 for worker in self.workers))
        self.assertTrue(all(not path.exists() and not path.parent.exists() for path in self.paths))

    def test_eof_stops_current_pool_with_blocked_task(self):
        self.entered_task(self.rebuild(), 'current')
        self.assert_eof_stops_workers()

    def test_eof_stops_retired_pool_with_blocked_task(self):
        self.entered_task(self.rebuild(), 'retired')
        self.server._discard_bg_pool()
        self.assertIsNone(self.server._bg_pool)
        self.assert_eof_stops_workers()

    def test_replacement_drains_old_request_and_new_pool_uses_new_metadata(self):
        old_pool = self.rebuild()
        future, release = self.entered_task(old_pool, 'old')
        old_workers = list(self.workers)
        self.source.write_text(self.source.read_text().replace('CharField', 'DateField'))
        self.server.static_index = build_static_index(self.root)
        self.server.model_graph = build_model_graph(self.server.static_index, self.runtime)
        new_pool = self.rebuild()
        self.assertIsNot(new_pool, old_pool)
        self.assertTrue(any(worker.is_alive() for worker in old_workers))
        self.assertTrue(self.paths[0].is_file(), 'Retired pool lost its snapshot before accepted work drained')
        release.touch()
        self.assertEqual(future.result(5), ('CharField', 'CharField', True, self.runtime.bootstrap_status))
        # The executor manager owns waitpid. Wait for it to publish the exit
        # status before inspecting Process objects from this thread.
        retirement_deadline = time.monotonic() + 3
        self.assertTrue(old_pool.wait_closed(max(0, retirement_deadline - time.monotonic())))
        for worker in old_workers:
            worker.join(max(0, retirement_deadline - time.monotonic()))
            self.assertEqual(worker.exitcode, 0)
        self.assertFalse(self.paths[0].parent.exists())
        self.assertLessEqual(time.monotonic(), retirement_deadline)
        new_release = self.root / 'new.release'
        new_release.touch()
        result = new_pool.submit(_wait_and_read_snapshot, str(self.root / 'new.entered'), str(new_release))
        self.assertEqual(result.result(5), ('DateField', 'DateField', True, self.runtime.bootstrap_status))
        self.assert_eof_stops_workers()

    @unittest.skipUnless(os.name == 'posix', 'Requires POSIX waitpid observation')
    def test_pool_reap_publication_is_observed_through_the_shutdown_owner(self):
        from multiprocessing.connection import wait
        pool = self.rebuild()
        future, release_task = self.entered_task(pool, 'reap-publication')
        self.assertEqual(len(self.workers), 1)
        worker = self.workers[0]
        reaped, resume_publication = threading.Event(), threading.Event()
        original_waitpid = os.waitpid
        kernel_status = []

        def held_publication(pid, flags):
            result = original_waitpid(pid, flags)
            if pid == worker.pid and result[0] == pid:
                kernel_status.append(os.waitstatus_to_exitcode(result[1]))
                reaped.set()
                resume_publication.wait(3)
            return result

        with mock.patch.object(os, 'waitpid', held_publication):
            try:
                self.server._discard_bg_pool()
                self.assertTrue(self.paths[0].is_file())
                release_task.touch()
                self.assertEqual(future.result(5), ('CharField', 'CharField', True, self.runtime.bootstrap_status))
                deadline = time.monotonic() + 3
                self.assertTrue(reaped.wait(max(0, deadline - time.monotonic())))
                # The kernel has reaped this worker, but its manager has not
                # returned from waitpid to publish Process.returncode yet.
                self.assertTrue(wait([worker.sentinel], timeout=0))
                self.assertIsNone(worker._popen.returncode)
                self.assertFalse(pool.wait_closed(0))
                self.assertTrue(self.paths[0].is_file())
                resume_publication.set()
                self.assertTrue(pool.wait_closed(max(0, deadline - time.monotonic())))
                worker.join(max(0, deadline - time.monotonic()))
                self.assertEqual(worker.exitcode, 0)
                self.assertEqual(kernel_status, [0])
                self.assertFalse(self.paths[0].parent.exists())
                self.assertLessEqual(time.monotonic(), deadline)
            finally:
                resume_publication.set()

    def test_same_state_reuses_single_pool(self):
        first = self.rebuild()
        self.assertIs(self.rebuild(), first)
        self.assertEqual(len(self.raw_pools), 1)
        self.close_stdio()

    def test_snapshot_context_releases_parent_payload_and_preserves_full_aliases(self):
        payload = _WeakPayload()
        reference = weakref.ref(payload)
        context = worker_state.persistent_worker_state_file(payload, payload, payload)
        with context as name:
            path = Path(name)
            del payload
            self.assertIsNone(reference(), 'Long-lived file context retained the parent payload')
            restored = worker_state.load_surface_worker_state(name)
            self.assertEqual(restored[0].value, 'complete payload')
            self.assertIs(restored[0], restored[1])
            self.assertIs(restored[1], restored[2])
            self.assertTrue(path.exists())
        self.assertFalse(path.exists())
        self.assertFalse(path.parent.exists())

    def test_pool_releases_parent_payload_before_its_first_task(self):
        payload = _WeakPayload()
        reference = weakref.ref(payload)
        self.server.static_index = self.server.runtime_inspection = self.server.model_graph = payload
        pool = self.rebuild()
        self.server.static_index = self.server.runtime_inspection = self.server.model_graph = None
        del payload
        self.assertIsNone(reference(), 'Persistent pool retained the original parent state')
        self.assertTrue(self.paths[-1].is_file())
        self.close_stdio()
        self.assertTrue(pool.wait_closed(3))
        self.assertFalse(self.paths[-1].parent.exists())

    def test_failed_serialization_releases_payload_and_removes_its_directory(self):
        original = worker_state.tempfile.TemporaryDirectory
        directories = []
        def temporary(*args, **kwargs):
            directory = original(*args, **kwargs)
            directories.append(Path(directory.name))
            return directory
        payload = _WeakPayload()
        payload.unpicklable = threading.Lock()
        reference = weakref.ref(payload)
        context = worker_state.persistent_worker_state_file(payload, payload, payload)
        with mock.patch.object(worker_state.tempfile, 'TemporaryDirectory', temporary):
            with self.assertRaises(TypeError):
                with context:
                    self.fail('Failed snapshot was yielded')
        del payload
        self.assertIsNone(reference())
        self.assertTrue(directories)
        self.assertTrue(all(not path.exists() for path in directories))

    def test_pool_construction_failure_and_interrupt_explicitly_close_owned_resources(self):
        cls = worker_state._PersistentWorkerStateFile
        original_enter, original_exit = cls.__enter__, cls.__exit__
        paths, exited = [], []
        def enter(context):
            path = original_enter(context)
            paths.append(Path(path))
            return path
        def leave(context, *args):
            exited.append(context)
            return original_exit(context, *args)
        for failure in (OSError('pool creation failed'), KeyboardInterrupt('pool creation interrupted')):
            with self.subTest(failure=type(failure).__name__):
                before = set(worker_lifetime._surface_connections)
                with mock.patch.object(cls, '__enter__', enter), \
                        mock.patch.object(cls, '__exit__', leave), \
                        mock.patch.object(app, 'ProcessPoolExecutor', side_effect=failure):
                    if isinstance(failure, KeyboardInterrupt):
                        with self.assertRaises(KeyboardInterrupt) as raised:
                            self.server._rebuild_bg_pool()
                        self.assertIs(raised.exception, failure)
                    else:
                        self.server._rebuild_bg_pool()
                self.assertIsNone(self.server._bg_pool)
                self.assertEqual(len(exited), len(paths), 'Pool creation bypassed explicit file cleanup')
                self.assertFalse(paths[-1].parent.exists())
                self.assertEqual(worker_lifetime._surface_connections, before)

    def check_drain_start_failure(self, *, construction):
        pool = self.rebuild()
        self.addCleanup(pool._state_scope.close)
        future, release = self.entered_task(pool, 'drain-failure')
        release.touch()
        failure = RuntimeError('drain thread unavailable')
        if construction:
            patch = mock.patch.object(worker_lifetime.threading, 'Thread', side_effect=failure)
        else:
            patch = mock.patch.object(worker_lifetime.threading.Thread, 'start', side_effect=failure)
        with patch:
            with self.assertRaises(RuntimeError) as raised:
                self.server._discard_bg_pool()
        self.assertIs(raised.exception, failure)
        self.assertEqual(future.result(5), ('CharField', 'CharField', True, self.runtime.bootstrap_status))
        self.assertTrue(pool.wait_closed(3), 'Failed drain startup abandoned pool ownership')
        self.assertFalse(self.paths[-1].parent.exists())

    def test_drain_thread_construction_failure_still_drains_accepted_work(self):
        self.check_drain_start_failure(construction=True)

    def test_drain_thread_start_failure_still_drains_accepted_work(self):
        self.check_drain_start_failure(construction=False)

    def test_stopped_server_does_not_create_snapshot_or_pool(self):
        self.server._stopping.set()
        with mock.patch.object(app, 'persistent_worker_state_file') as snapshot, \
                mock.patch.object(app, 'ProcessPoolExecutor') as constructor:
            self.server._rebuild_bg_pool()
        snapshot.assert_not_called()
        constructor.assert_not_called()

    def test_stop_during_pool_construction_cannot_publish_or_start_workers(self):
        def stop_after_construction(*args, **kwargs):
            pool = self.factory(*args, **kwargs)
            self.server._stopping.set()
            return pool
        with mock.patch.object(app, 'ProcessPoolExecutor', stop_after_construction):
            self.server._rebuild_bg_pool()
        self.assertIsNone(self.server._bg_pool)
        self.close_stdio()
        self.assertEqual(self.workers, [])
        self.assertTrue(self.paths)
        self.assertTrue(all(not path.parent.exists() for path in self.paths))


if __name__ == '__main__':
    unittest.main()
