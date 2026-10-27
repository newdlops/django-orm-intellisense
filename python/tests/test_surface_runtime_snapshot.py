import dataclasses
import json
import os
import pickle
import subprocess
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from django_orm_intellisense.cache import store
from django_orm_intellisense.features import orm_members
from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.server import worker_state
from django_orm_intellisense.static_index.indexer import build_static_index


class SurfaceRuntimeSnapshotTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        package = self.root / 'blog'
        package.mkdir()
        (package / '__init__.py').write_text('')
        (package / 'models.py').write_text('from django.db import models\n'
            'class Post(models.Model):\n    title = models.CharField()\n')
        self.static = build_static_index(self.root)
        self.runtime = create_pending_runtime_inspection(None)
        self.graph = build_model_graph(self.static, self.runtime)
        self.item = orm_members.OrmMemberItem(name='attached', member_kind='method',
            model_label='blog.Post', receiver_kind='instance', detail='function', source='runtime',
            return_kind='instance', return_model_label='blog.Post', file_path=str(package / 'models.py'),
            line=5, column=1, signature='() -> Post')

    def test_actual_spawn_retains_every_dynamic_surface_and_bound_member_record(self):
        result = subprocess.run([sys.executable, '-m', 'benchmarks.check_surface_worker_runtime_fidelity'],
            text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr[-4000:])
        value = json.loads(result.stdout)
        self.assertTrue(value['completeSurfaceEqual'])
        self.assertTrue(value['everyMemberWireEqual'])
        self.assertFalse(value['spawnedDjangoAppsReady'], 'Worker unnecessarily reimported the Django app')
        self.assertGreater(value['runtimeItemsCaptured'], 0)
        self.assertTrue(value['reusedWorkerUsesCurrentCapture'])

    def test_repeated_captures_keep_current_values_without_reusing_or_populating_global_member_cache(self):
        global_cache = orm_members._MemberSurfaceCache()
        with mock.patch.object(orm_members, '_surface_cache', global_cache):
            for name in ('attached', 'replacement'):
                item = dataclasses.replace(self.item, name=name)
                surface = orm_members.prebuild_member_surface_cache(self.static, self.runtime, self.graph,
                    runtime_members={('blog.Post', 'instance', None): (item,)})
                self.assertEqual(surface['blog.Post']['instance'][name][0:2], ('instance', 'blog.Post'))
                self.assertNotIn('replacement' if name == 'attached' else 'attached', surface['blog.Post']['instance'])
                self.assertEqual(global_cache._list_cache, {})
        self.assertEqual(orm_members._project_model_method_items(static_index=self.static,
            runtime=self.runtime, model_label='blog.Post', receiver_kind='instance'), [])

    def test_failed_snapshot_build_does_not_change_a_later_direct_runtime_query(self):
        with mock.patch.object(orm_members, '_member_surface', side_effect=ValueError('interrupted')):
            with self.assertRaisesRegex(ValueError, 'interrupted'):
                orm_members.prebuild_member_surface_cache(self.static, self.runtime, self.graph,
                    runtime_members={('blog.Post', 'instance', None): (self.item,)})
        self.assertEqual(orm_members._project_model_method_items(static_index=self.static,
            runtime=self.runtime, model_label='blog.Post', receiver_kind='instance'), [])

    def test_blocked_snapshot_build_does_not_change_another_threads_direct_query(self):
        started, resume = threading.Event(), threading.Event()
        original = orm_members._member_surface
        def held(**kwargs):
            result = original(**kwargs)
            if kwargs['receiver_kind'] == 'instance':
                started.set()
                self.assertTrue(resume.wait(5))
            return result
        with mock.patch.object(orm_members, '_member_surface', held), ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(orm_members.prebuild_member_surface_cache,
                self.static, self.runtime, self.graph,
                runtime_members={('blog.Post', 'instance', None): (self.item,)})
            try:
                self.assertTrue(started.wait(5))
                self.assertEqual(orm_members._project_model_method_items(static_index=self.static,
                    runtime=self.runtime, model_label='blog.Post', receiver_kind='instance'), [])
            finally:
                resume.set()
            self.assertIn('attached', pending.result(timeout=5)['blog.Post']['instance'])

    def test_runtime_member_file_preserves_complete_records_and_cleans_up_after_success_and_failure(self):
        members = {('blog.Post', 'instance', None): (self.item,)}
        with mock.patch.object(pickle, 'dumps', side_effect=AssertionError('Whole runtime pickle allocated')):
            with worker_state.runtime_member_state_file(members) as name:
                path = Path(name)
                restored = worker_state.load_runtime_member_state(name)
                self.assertEqual(restored, members)
                self.assertEqual(restored[('blog.Post', 'instance', None)][0].to_dict(), self.item.to_dict())
        self.assertFalse(path.exists())
        with self.assertRaisesRegex(ValueError, 'task failed'):
            with worker_state.runtime_member_state_file(members) as name:
                path = Path(name)
                raise ValueError('task failed')
        self.assertFalse(path.exists())
        with worker_state.runtime_member_state_file(None) as name:
            self.assertIsNone(name)

    def test_old_surface_version_is_rebuilt_without_invalidating_the_model_graph_cache(self):
        with mock.patch.dict(os.environ, {'DJANGO_ORM_INTELLISENSE_CACHE_DIR': str(self.root / 'cache')}):
            surface = orm_members.prebuild_member_surface_cache(self.static, self.runtime, self.graph)
            store.save_surface_index(self.root, 'source', 'runtime', surface)
            path = store._workspace_cache_dir(self.root) / store.SURFACE_INDEX_CACHE_NAME
            payload = json.loads(path.read_text())
            self.assertEqual(payload['metadata']['surfaceIndexVersion'], store.SURFACE_INDEX_CACHE_VERSION)
            for version in (None, 1, 2):
                if version is None:
                    payload['metadata'].pop('surfaceIndexVersion', None)
                else:
                    payload['metadata']['surfaceIndexVersion'] = version
                path.write_text(json.dumps(payload))
                self.assertIsNone(store.load_cached_surface_index(self.root, 'source', 'runtime'))
            store.save_model_graph(self.root, 'source', 'runtime', self.graph)
            graph_path = store._workspace_cache_dir(self.root) / store.MODEL_GRAPH_CACHE_NAME
            graph_payload = json.loads(graph_path.read_text())
            self.assertNotIn('surfaceIndexVersion', graph_payload['metadata'])
            self.assertIsNotNone(store.load_cached_model_graph(self.root, 'source', 'runtime', static_index=self.static))
