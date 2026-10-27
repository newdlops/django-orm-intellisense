import contextlib
import io
import os
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from unittest import mock

from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.server import app
from django_orm_intellisense.static_index.indexer import build_static_index


def _restore_blocked_state(marker):
    Path(marker).write_text(str(os.getpid()))
    threading.Event().wait(60)
    return None


class _BlockedState:
    def __init__(self, marker):
        self.marker = str(marker)

    def __reduce__(self):
        return _restore_blocked_state, (self.marker,)


class SurfacePoolShutdownTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='djls-surface-stop-test-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        package = self.root / 'blog'
        package.mkdir()
        (package / '__init__.py').write_text('')
        (package / 'models.py').write_text(
            'from django.db import models\nclass Post(models.Model):\n    value = models.CharField()\n')
        self.index = build_static_index(self.root)
        self.runtime = create_pending_runtime_inspection(None)
        self.graph = build_model_graph(self.index, self.runtime)
        self.snapshot = snapshot_python_sources(self.root)
        with mock.patch.object(sys, 'stdout', io.StringIO()):
            self.server = app.DaemonServer(self.root)
        self.server.static_index = self.index
        self.server.runtime_inspection = self.runtime
        self.server.model_graph = self.graph
        self.workers = []
        self.pools = []
        self.threads = []
        self.state_paths = []
        self.addCleanup(self.cleanup_owned_workers)
        current = threading.current_thread()
        self.addCleanup(setattr, current, 'name', current.name)

    def cleanup_owned_workers(self):
        self.server._stopping.set()
        # Only Process objects recorded from this test's one-worker executor.
        for worker in self.workers:
            if worker.is_alive():
                worker.terminate()
            worker.join(3)
        for thread in self.threads:
            if thread.is_alive():
                thread.join(3)
            self.assertFalse(thread.is_alive(), 'Owned prebuild thread survived cleanup')
        for pool in self.pools:
            pool.shutdown(wait=False)

    def executor_factory(self, *args, **kwargs):
        owner = self
        class ObservedExecutor(ProcessPoolExecutor):
            def submit(self, *args, **kwargs):
                future = super().submit(*args, **kwargs)
                owner.workers.extend((self._processes or {}).values())
                return future
        pool = ObservedExecutor(*args, **kwargs)
        self.pools.append(pool)
        return pool

    def start_prebuild(self):
        self.server._start_surface_index_prebuild(
            generation=self.server._state_generation, workspace_root=self.root,
            source_snapshot=self.snapshot, static_index=self.index,
            runtime=self.runtime, model_graph=self.graph, reason='lifetime-test')
        thread = self.server._surface_prebuild_future
        if thread is not None:
            self.threads.append(thread)

    def close_stdio(self):
        with mock.patch.object(sys, 'stdin', io.StringIO('')):
            self.server.run_stdio()

    def test_eof_stops_worker_blocked_during_state_load_and_removes_state(self):
        marker = self.root / 'worker-entered'
        real_state_file = app.surface_worker_state_file
        @contextlib.contextmanager
        def blocked_state_file(index, runtime, graph):
            with real_state_file(_BlockedState(marker), runtime, graph) as name:
                self.state_paths.append(Path(name))
                yield name
        with mock.patch.object(app, 'load_cached_surface_index', return_value=None), \
                mock.patch.object(app, 'surface_worker_state_file', blocked_state_file), \
                mock.patch.object(app, 'ProcessPoolExecutor', self.executor_factory), \
                mock.patch.object(self.server, '_publish_current_surface_snapshot') as publish:
            self.start_prebuild()
            deadline = time.monotonic() + 10
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(marker.exists(), 'Actual worker did not reach state loading')
            self.assertEqual(len(self.workers), 1)
            self.assertEqual(int(marker.read_text()), self.workers[0].pid)
            deadline = time.monotonic() + 3
            self.close_stdio()
            for worker in self.workers:
                worker.join(max(0, deadline - time.monotonic()))
            self.assertTrue(all(not worker.is_alive() for worker in self.workers),
                            'EOF left the owned worker blocked')
            self.assertTrue(all(worker.exitcode == 0 for worker in self.workers))
            for thread in self.threads:
                thread.join(max(0, deadline - time.monotonic()))
            self.assertTrue(all(not thread.is_alive() for thread in self.threads))
            self.assertTrue(self.state_paths)
            self.assertTrue(all(not path.exists() and not path.parent.exists() for path in self.state_paths))
            publish.assert_not_called()

    def test_normal_worker_keeps_complete_field_surface_and_exits_cleanly(self):
        published = threading.Event()
        with mock.patch.object(app, 'load_cached_surface_index', return_value=None), \
                mock.patch.object(app, 'ProcessPoolExecutor', self.executor_factory), \
                mock.patch.object(self.server, '_publish_current_surface_snapshot',
                                  side_effect=lambda generation: published.set()):
            self.start_prebuild()
            self.assertTrue(published.wait(10), 'Actual worker did not publish its small surface')
            for thread in self.threads:
                thread.join(3)
                self.assertFalse(thread.is_alive())
            self.assertEqual(len(self.workers), 1)
            self.assertEqual(self.server._last_surface_index['blog.Post']['instance']['value'],
                             ('scalar', 'blog.Post', 'field', 'CharField'))
            self.close_stdio()
            for worker in self.workers:
                worker.join(3)
                self.assertEqual(worker.exitcode, 0)

    def test_channel_allocation_failure_closes_only_new_endpoints(self):
        from django_orm_intellisense.server import worker_lifetime
        real_pipe = worker_lifetime.multiprocessing.Pipe
        unrelated = real_pipe(duplex=False)
        for connection in unrelated:
            self.addCleanup(connection.close)
        class FailingRegistry(set):
            def update(self, connections):
                self.add(connections[0])
                raise MemoryError('partial channel registration')
        registry = FailingRegistry(unrelated)
        created = []
        def create_pipe(*args, **kwargs):
            pair = real_pipe(*args, **kwargs)
            created.extend(pair)
            for connection in pair:
                self.addCleanup(connection.close)
            return pair
        with mock.patch.object(worker_lifetime, '_surface_connections', registry), \
                mock.patch.object(worker_lifetime.multiprocessing, 'Pipe', create_pipe):
            with self.assertRaisesRegex(MemoryError, 'partial channel registration'):
                with worker_lifetime.surface_pool_state_path('unused.pickle', threading.Event()):
                    self.fail('Failed channel initialization yielded a path')
        self.assertEqual(len(created), 2)
        self.assertEqual([connection.closed for connection in created], [True, True])
        self.assertEqual(registry, set(unrelated))
        self.assertTrue(all(not connection.closed for connection in unrelated))

    def test_endpoint_close_failure_still_closes_other_endpoint(self):
        from django_orm_intellisense.server import worker_lifetime
        real_pipe = worker_lifetime.multiprocessing.Pipe
        created = []
        def create_pipe(*args, **kwargs):
            reader, writer = real_pipe(*args, **kwargs)
            original_close = reader.close
            def fail_after_close():
                original_close()
                raise OSError('injected endpoint close failure')
            reader.close = fail_after_close
            created.extend((reader, writer))
            self.addCleanup(writer.close)
            self.addCleanup(original_close)
            self.addCleanup(setattr, reader, 'close', original_close)
            return reader, writer
        with mock.patch.object(worker_lifetime.multiprocessing, 'Pipe', create_pipe):
            with self.assertRaisesRegex(OSError, 'injected endpoint close failure'):
                with worker_lifetime.surface_pool_state_path('unused.pickle', threading.Event()):
                    pass
        self.assertEqual([connection.closed for connection in created], [True, True])
        self.assertTrue(all(connection not in worker_lifetime._surface_connections for connection in created))


if __name__ == '__main__':
    unittest.main()
