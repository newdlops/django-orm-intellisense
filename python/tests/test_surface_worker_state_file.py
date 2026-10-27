import contextlib
import pickle
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.server import app
from django_orm_intellisense.static_index.indexer import build_static_index


class SurfaceWorkerStateFileTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='djls-worker-state-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        package = self.root / 'blog'
        package.mkdir()
        (package / '__init__.py').write_text('')
        (package / 'models.py').write_text('from django.db import models\nclass Post(models.Model):\n    value=models.CharField()\n')
        self.index = build_static_index(self.root)
        self.runtime = create_pending_runtime_inspection(None)
        self.graph = build_model_graph(self.index, self.runtime)
        self.snapshot = snapshot_python_sources(self.root)
        stdout = sys.stdout
        try:
            self.server = app.DaemonServer(self.root)
        finally:
            sys.stdout = stdout
        self.server.static_index, self.server.runtime_inspection, self.server.model_graph = self.index, self.runtime, self.graph
        self.surface = {'blog.Post': {'instance': {'value': ['scalar', None, 'field', 'CharField']}}}

    def test_one_shot_prebuild_passes_only_a_snapshot_path_and_keeps_it_until_pool_shutdown(self):
        published = threading.Event()
        observed = []
        def entered(pool):
            return pool
        def exited(pool, *args):
            args = created.call_args.kwargs['initargs']
            self.assertEqual(len(args), 1)
            self.assertIsInstance(args[0], str, 'Surface worker startup carried the complete state in spawn initargs')
            path = Path(args[0])
            self.assertTrue(path.exists(), 'State file disappeared before pool shutdown')
            observed.append(path)
        with mock.patch.object(app, 'load_cached_surface_index', return_value=None), \
                mock.patch.object(app, 'save_surface_index'), \
                mock.patch.object(app, 'ProcessPoolExecutor') as created, \
                mock.patch.object(self.server, '_publish_current_surface_snapshot', side_effect=lambda generation: published.set()):
            pool = created.return_value
            pool.__enter__.side_effect = lambda: entered(pool)
            pool.__exit__.side_effect = lambda *args: exited(pool, *args)
            pool.submit.return_value.result.return_value = self.surface
            self.server._start_surface_index_prebuild(generation=self.server._state_generation,
                workspace_root=self.root, source_snapshot=self.snapshot, static_index=self.index,
                runtime=self.runtime, model_graph=self.graph, reason='test')
            thread = self.server._surface_prebuild_future
            self.assertTrue(published.wait(3), 'Surface publication did not finish')
            if thread is not None:
                thread.join(3)
                self.assertFalse(thread.is_alive())
        self.assertEqual(len(observed), 1)
        self.assertFalse(observed[0].exists())
        self.assertFalse(observed[0].parent.exists())

    def test_snapshot_uses_file_pickle_preserves_full_state_aliases_and_closes_writer_before_yield(self):
        from django_orm_intellisense.server.worker_state import surface_worker_state_file, load_surface_worker_state
        from django_orm_intellisense.cache import store
        expected = (self.index.to_cache_dict(), self.index.fields, self.runtime.to_cache_dict(),
                    store._model_graph_to_cache_dict(self.graph))
        with mock.patch.object(pickle, 'dumps', side_effect=AssertionError('Whole state pickle buffer allocated')):
            with surface_worker_state_file(self.index, self.runtime, self.graph) as name:
                path = Path(name)
                self.assertTrue(path.is_file())
                restored = load_surface_worker_state(name)
                self.assertEqual((restored[0].to_cache_dict(), restored[0].fields, restored[1].to_cache_dict(),
                    store._model_graph_to_cache_dict(restored[2])), expected)
                self.assertIs(restored[2].find_field('blog.Post', 'value'), restored[0].find_field('blog.Post', 'value'))
                with path.open('rb') as stream:
                    self.assertTrue(stream.read(2))
        self.assertFalse(path.exists())
        self.assertFalse(path.parent.exists())

    def test_snapshot_serialization_and_body_failures_remove_owned_private_directory(self):
        from django_orm_intellisense.server import worker_state
        original = worker_state.tempfile.TemporaryDirectory
        paths = []
        def temporary(*args, **kwargs):
            directory = original(*args, **kwargs)
            paths.append(Path(directory.name))
            return directory
        for error in [OSError('injected serialization I/O failure'), RuntimeError('injected serialization failure')]:
            with mock.patch.object(worker_state.tempfile, 'TemporaryDirectory', temporary), \
                    mock.patch.object(worker_state.pickle, 'dump', side_effect=error):
                with self.assertRaises(type(error)):
                    with worker_state.surface_worker_state_file(self.index, self.runtime, self.graph):
                        self.fail('Failed snapshot was yielded')
            self.assertFalse(paths[-1].exists())
        with self.assertRaisesRegex(RuntimeError, 'injected task failure'):
            with worker_state.surface_worker_state_file(self.index, self.runtime, self.graph) as name:
                path = Path(name)
                raise RuntimeError('injected task failure')
        self.assertFalse(path.exists())
        self.assertFalse(path.parent.exists())

    def test_bad_worker_file_does_not_partially_replace_worker_state(self):
        from django_orm_intellisense.server.worker_state import surface_worker_state_file
        with mock.patch.object(app, '_worker_static_index', mock.sentinel.index), \
                mock.patch.object(app, '_worker_runtime', mock.sentinel.runtime), \
                mock.patch.object(app, '_worker_model_graph', mock.sentinel.graph):
            with surface_worker_state_file(self.index, self.runtime, self.graph) as name:
                Path(name).write_bytes(b'not a pickle')
                with self.assertRaises(pickle.UnpicklingError):
                    app._init_bg_worker_from_file(name)
            self.assertIs(app._worker_static_index, mock.sentinel.index)
            self.assertIs(app._worker_runtime, mock.sentinel.runtime)
            self.assertIs(app._worker_model_graph, mock.sentinel.graph)

    def test_parallel_snapshots_have_separate_complete_files_and_keep_old_source_values(self):
        from django_orm_intellisense.server.worker_state import surface_worker_state_file, load_surface_worker_state
        from django_orm_intellisense.static_index.indexer import reindex_single_file
        source = self.root / 'blog' / 'models.py'
        source.write_text(source.read_text().replace('CharField', 'DateField'))
        current, _, _ = reindex_single_file(self.root, source, self.index)
        current_graph = build_model_graph(current, self.runtime)
        barrier = threading.Barrier(2)
        def work(state):
            with surface_worker_state_file(*state) as name:
                path = Path(name)
                barrier.wait(timeout=3)
                restored = load_surface_worker_state(name)
                kind = restored[0].find_field('blog.Post', 'value').field_kind
                self.assertTrue(path.exists())
            self.assertFalse(path.exists())
            return name, kind
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(work, [(self.index, self.runtime, self.graph), (current, self.runtime, current_graph)]))
        self.assertEqual(len({name for name, _ in results}), 2)
        self.assertEqual({kind for _, kind in results}, {'CharField', 'DateField'})
        self.assertEqual(self.index.find_field('blog.Post', 'value').field_kind, 'CharField')

    def test_pool_or_task_failure_cleans_snapshot_and_cannot_publish(self):
        original = app.surface_worker_state_file
        seen = []
        @contextlib.contextmanager
        def recorded(*args):
            with original(*args) as name:
                seen.append(Path(name))
                yield name
        for failure in ['pool', 'task']:
            self.server._surface_load_attempted_generation = None
            with mock.patch.object(app, 'load_cached_surface_index', return_value=None), \
                    mock.patch.object(app, 'surface_worker_state_file', recorded), \
                    mock.patch.object(app, 'ProcessPoolExecutor') as created, \
                    mock.patch.object(self.server, '_publish_current_surface_snapshot') as publish:
                if failure == 'pool':
                    created.side_effect = OSError('injected pool start failure')
                else:
                    created.return_value.__enter__.return_value.submit.return_value.result.side_effect = RuntimeError('injected task failure')
                self.server._start_surface_index_prebuild(generation=self.server._state_generation,
                    workspace_root=self.root, source_snapshot=self.snapshot, static_index=self.index,
                    runtime=self.runtime, model_graph=self.graph, reason='test')
                thread = self.server._surface_prebuild_future
                if thread is not None:
                    thread.join(3)
                    self.assertFalse(thread.is_alive())
                publish.assert_not_called()
            self.assertFalse(seen[-1].exists())
            self.assertFalse(seen[-1].parent.exists())


if __name__ == '__main__':
    unittest.main()
