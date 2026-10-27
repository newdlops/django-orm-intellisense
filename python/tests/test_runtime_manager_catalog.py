"""Runtime manager lookups keep catalogue precedence, ownership and lifetime."""
import dataclasses
import gc
import tempfile
import threading
import unittest
import weakref
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from django_orm_intellisense.features import orm_members
from django_orm_intellisense.runtime.inspector import RuntimeModelSummary, create_pending_runtime_inspection
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.static_index.indexer import build_static_index


class CountingCatalog(tuple):
    visits = 0

    def __iter__(self):
        for item in super().__iter__():
            self.visits += 1
            yield item


def summary(label, managers):
    return RuntimeModelSummary(label, 'blog.models', [], [], [], [], [], managers)


def runtime_for(catalog):
    return dataclasses.replace(create_pending_runtime_inspection(None), model_catalog=catalog)


class RuntimeManagerCatalogTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        app = self.root / 'blog'
        app.mkdir()
        (app / '__init__.py').write_text('')
        (app / 'models.py').write_text('from django.db import models\n'
            'class Post(models.Model):\n    value = models.CharField()\n'
            'class Other(models.Model):\n    value = models.IntegerField()\n')
        self.static = build_static_index(self.root)

    def test_complete_surface_build_visits_catalog_once_and_keeps_all_manager_names(self):
        catalog = CountingCatalog([summary(f'external.Model{i}', ['objects']) for i in range(200)]
            + [summary('blog.Post', ['archive', 'objects', 'archive']),
               summary('blog.Other', ['custom'])])
        runtime = runtime_for(catalog)
        with mock.patch.object(orm_members, '_surface_cache', orm_members._MemberSurfaceCache()):
            surface = orm_members.build_surface_index(self.static, runtime)
        self.assertEqual(catalog.visits, len(catalog), 'Each model traversed the full runtime catalogue')
        self.assertEqual(set(surface), {'blog.Post', 'blog.Other'})
        self.assertIn('archive', surface['blog.Post']['model_class'])
        self.assertIn('custom', surface['blog.Other']['model_class'])
        self.assertEqual(surface['blog.Other']['instance']['value'][3], 'IntegerField')

    def test_first_duplicate_live_manager_changes_and_static_fallback_keep_precedence(self):
        first = summary('blog.Post', ['zeta', 'first', 'first'])
        runtime = runtime_for((first, summary('blog.Post', ['second'])))

        @orm_members._with_runtime_source_paths
        def query():
            self.assertEqual(orm_members._manager_names(self.static, runtime, 'blog.Post'), ['first', 'zeta'])
            first.manager_names[:] = ['live']
            self.assertEqual(orm_members._manager_names(self.static, runtime, 'blog.Post'), ['live'])
            first.manager_names.clear()
            self.assertEqual(orm_members._manager_names(self.static, runtime, 'blog.Post'), ['objects'])
            self.assertEqual(orm_members._manager_names(self.static, runtime, 'missing.Model'), [])
        query()

    def test_canonical_runtime_label_keeps_dynamic_manager_names_in_full_and_individual_results(self):
        catalog = CountingCatalog([summary('custom.Post', ['attached', 'objects'])])
        runtime = runtime_for(catalog)
        graph = build_model_graph(self.static, runtime)
        with mock.patch.object(orm_members, '_surface_cache', orm_members._MemberSurfaceCache()):
            surface = orm_members.build_surface_index(self.static, runtime, graph)
            resolved = orm_members.resolve_orm_member(static_index=self.static, runtime=runtime,
                model_graph=graph, model_label='custom.Post', receiver_kind='model_class', name='attached')
        self.assertIn('attached', surface['custom.Post']['model_class'])
        self.assertTrue(resolved['resolved'])
        self.assertEqual(resolved['item']['modelLabel'], 'custom.Post')

    def test_nested_builds_keep_distinct_catalog_owners_without_repeated_traversal(self):
        first = CountingCatalog([summary('blog.Post', ['first'])])
        second = CountingCatalog([summary('blog.Post', ['second'])])
        runtimes = [runtime_for(first), runtime_for(second)]

        @orm_members._with_runtime_source_paths
        def nested():
            self.assertEqual(orm_members._manager_names(self.static, runtimes[1], 'blog.Post'), ['second'])

        @orm_members._with_runtime_source_paths
        def outer():
            self.assertEqual(orm_members._manager_names(self.static, runtimes[0], 'blog.Post'), ['first'])
            nested()
            self.assertEqual(orm_members._manager_names(self.static, runtimes[0], 'blog.Post'), ['first'])
        outer()
        self.assertEqual((first.visits, second.visits), (1, 1))

    def test_normal_and_exceptional_builds_release_catalog_summaries_without_cyclic_gc(self):
        @orm_members._with_runtime_source_paths
        def query(runtime, fail):
            self.assertEqual(orm_members._manager_names(self.static, runtime, 'blog.Post'), ['objects'])
            if fail:
                raise ValueError('surface build interrupted')

        enabled = gc.isenabled()
        gc.disable()
        try:
            for fail in (False, True):
                with self.subTest(fail=fail):
                    model = summary('blog.Post', ['objects'])
                    reference = weakref.ref(model)
                    runtime = runtime_for((model,))
                    if fail:
                        with self.assertRaisesRegex(ValueError, 'surface build interrupted'):
                            query(runtime, fail)
                    else:
                        query(runtime, fail)
                    del runtime, model
                    self.assertIsNone(reference(), 'Finished build retained a runtime catalogue owner')
        finally:
            if enabled:
                gc.enable()

    def test_blocked_build_does_not_retain_another_threads_direct_query_catalog(self):
        started, resume = threading.Event(), threading.Event()
        runtime = runtime_for((summary('blog.Post', ['worker']),))

        @orm_members._with_runtime_source_paths
        def blocked():
            self.assertEqual(orm_members._manager_names(self.static, runtime, 'blog.Post'), ['worker'])
            started.set()
            self.assertTrue(resume.wait(5))

        def direct():
            model = summary('blog.Post', ['direct'])
            reference = weakref.ref(model)
            direct_runtime = runtime_for((model,))
            self.assertEqual(orm_members._manager_names(self.static, direct_runtime, 'blog.Post'), ['direct'])
            return reference

        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(blocked)
            try:
                self.assertTrue(started.wait(5))
                reference = direct()
                self.assertIsNone(reference(), 'Other thread retained the direct-query catalogue')
            finally:
                resume.set()
            pending.result(timeout=5)
