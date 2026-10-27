"""Member cache reuse must not mix source owners or resurrect invalidated work."""
from __future__ import annotations

import dataclasses
import json
import pickle
import tempfile
import threading
import sys
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from django_orm_intellisense.features import orm_members
from django_orm_intellisense.runtime import inspector
from django_orm_intellisense.cache.store import load_cached_surface_index, save_surface_index
from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.server.app import DaemonServer, _rebuild_surface_slice
from django_orm_intellisense.static_index.indexer import build_static_index, reindex_single_file


class MemberSurfaceCacheTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        app = self.root / 'blog'
        app.mkdir()
        (app / '__init__.py').write_text('')
        self.path = app / 'models.py'
        self.path.write_text('from django.db import models\n'
            'class Post(models.Model):\n    title = models.CharField()\n'
            'class Other(models.Model):\n    value = models.IntegerField()\n')
        self.runtime = create_pending_runtime_inspection(None)
        self.original = build_static_index(self.root)
        self.cache = orm_members._MemberSurfaceCache()

    def changed_index(self):
        self.path.write_text(self.path.read_text().replace('CharField', 'TextField'))
        changed, _, _ = reindex_single_file(self.root, self.path, self.original)
        return changed

    def get(self, index, label='blog.Post'):
        return self.cache.get_list(index, self.runtime, None, label, 'instance', None)

    def find(self, index, label='blog.Post', name='title'):
        return self.cache.find(index, self.runtime, None, label, 'instance', name, None)

    def registry_surface(self):
        surface = orm_members._member_surface(static_index=self.original, runtime=self.runtime,
            model_graph=None, model_label='blog.Post', receiver_kind='instance', manager_name=None)
        dynamic = dataclasses.replace(surface[0], name='attached_method', member_kind='method')
        return surface, [*surface, dynamic]

    def test_registry_readiness_changes_retire_cached_hits_and_misses_for_the_same_owner(self):
        self.runtime = dataclasses.replace(self.runtime, bootstrap_status='ready', settings_module='blog.settings')
        early, ready = self.registry_surface()
        with mock.patch.object(inspector, '_RUNTIME_FIELD_REGISTRY_SETTINGS_MODULE', 'blog.settings'), \
                mock.patch.object(inspector, '_RUNTIME_FIELD_REGISTRY_READY', False), \
                mock.patch.object(orm_members, '_member_surface',
                    side_effect=lambda **_: ready if inspector._RUNTIME_FIELD_REGISTRY_READY else early) as build:
            previous = None
            for available in (False, True, False, True):
                inspector._RUNTIME_FIELD_REGISTRY_READY = available
                found = self.find(self.original, name='attached_method')
                self.assertEqual(found is not None, available)
                current = self.get(self.original)
                self.assertIsNot(current, previous)
                self.assertIs(self.get(self.original), current)
                previous = current
        self.assertEqual(build.call_count, 4)

    def test_registry_becoming_ready_during_a_build_retries_before_caching_its_partial_result(self):
        self.runtime = dataclasses.replace(self.runtime, bootstrap_status='ready', settings_module='blog.settings')
        early, ready = self.registry_surface()
        started, resume = threading.Event(), threading.Event()
        calls = []

        def build(**_):
            calls.append(1)
            if len(calls) == 1:
                started.set()
                self.assertTrue(resume.wait(5))
                return early
            return ready

        with mock.patch.object(inspector, '_RUNTIME_FIELD_REGISTRY_SETTINGS_MODULE', 'blog.settings'), \
                mock.patch.object(inspector, '_RUNTIME_FIELD_REGISTRY_READY', False), \
                mock.patch.object(orm_members, '_member_surface', side_effect=build):
            with ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(self.get, self.original)
                try:
                    self.assertTrue(started.wait(5))
                    inspector._RUNTIME_FIELD_REGISTRY_READY = True
                finally:
                    resume.set()
                current = pending.result(timeout=5)
            self.assertIn('attached_method', {item.name for item in current})
            self.assertIs(self.get(self.original), current)
        self.assertEqual(len(calls), 2)
        self.assertFalse(self.cache._inflight)

    def test_owner_reuse_cannot_mark_pre_registry_entries_as_ready(self):
        self.runtime = dataclasses.replace(self.runtime, bootstrap_status='ready', settings_module='blog.settings')
        early, ready = self.registry_surface()
        changed = dataclasses.replace(self.original)
        with mock.patch.object(inspector, '_RUNTIME_FIELD_REGISTRY_SETTINGS_MODULE', 'blog.settings'), \
                mock.patch.object(inspector, '_RUNTIME_FIELD_REGISTRY_READY', False), \
                mock.patch.object(orm_members, '_member_surface',
                    side_effect=lambda **_: ready if inspector._RUNTIME_FIELD_REGISTRY_READY else early):
            self.get(self.original)
            inspector._RUNTIME_FIELD_REGISTRY_READY = True
            self.cache.force_owner(changed, self.runtime, None, previous_static_index=self.original)
            self.assertIsNotNone(self.find(changed, name='attached_method'))

    def test_catalogue_rebind_cannot_mark_pre_registry_entries_as_ready(self):
        self.runtime = dataclasses.replace(self.runtime, bootstrap_status='ready', settings_module='blog.settings')
        early, ready = self.registry_surface()
        previous = self.runtime
        replacement = dataclasses.replace(previous, lookup_catalog={'types': {}})
        with mock.patch.object(inspector, '_RUNTIME_FIELD_REGISTRY_SETTINGS_MODULE', 'blog.settings'), \
                mock.patch.object(inspector, '_RUNTIME_FIELD_REGISTRY_READY', False), \
                mock.patch.object(orm_members, '_member_surface',
                    side_effect=lambda **_: ready if inspector._RUNTIME_FIELD_REGISTRY_READY else early):
            self.get(self.original)
            inspector._RUNTIME_FIELD_REGISTRY_READY = True
            self.cache.rebind_runtime(self.original, previous, replacement, None)
            self.runtime = replacement
            self.assertIsNotNone(self.find(self.original, name='attached_method'))

    def test_reuse_keeps_the_readiness_observed_when_deciding_to_retain_entries(self):
        self.runtime = dataclasses.replace(self.runtime, bootstrap_status='ready', settings_module='blog.settings')
        early, ready = self.registry_surface()
        for adoption in ('index', 'catalogue'):
            with self.subTest(adoption=adoption), \
                    mock.patch.object(inspector, '_RUNTIME_FIELD_REGISTRY_SETTINGS_MODULE', 'blog.settings'), \
                    mock.patch.object(inspector, '_RUNTIME_FIELD_REGISTRY_READY', False), \
                    mock.patch.object(orm_members, '_member_surface',
                        side_effect=lambda **_: ready if inspector._RUNTIME_FIELD_REGISTRY_READY else early):
                self.cache = orm_members._MemberSurfaceCache()
                self.get(self.original)
                set_owner = self.cache._set_owner

                def setup_finishes(*args, **kwargs):
                    inspector._RUNTIME_FIELD_REGISTRY_READY = True
                    return set_owner(*args, **kwargs)

                with mock.patch.object(self.cache, '_set_owner', side_effect=setup_finishes):
                    if adoption == 'index':
                        current_index = dataclasses.replace(self.original)
                        self.cache.force_owner(current_index, self.runtime, None,
                            previous_static_index=self.original)
                    else:
                        current_index = self.original
                        previous = self.runtime
                        self.runtime = dataclasses.replace(previous, lookup_catalog={'types': {}})
                        self.cache.rebind_runtime(current_index, previous, self.runtime, None)
                self.assertIsNotNone(self.find(current_index, name='attached_method'))

    def test_find_uses_its_own_surface_after_another_owner_populates_or_clears_cache(self):
        changed = self.changed_index()
        original_get = self.cache.get_list
        for replacement_label in ('blog.Post', 'blog.Other'):
            with self.subTest(replacement_label=replacement_label):
                self.cache = orm_members._MemberSurfaceCache()
                original_get = self.cache.get_list
                built = threading.Event()
                resume = threading.Event()
                def delayed_get(*args, **kwargs):
                    surface = original_get(*args, **kwargs)
                    if args[0] is self.original:
                        built.set()
                        self.assertTrue(resume.wait(5))
                    return surface
                with mock.patch.object(self.cache, 'get_list', delayed_get):
                    with ThreadPoolExecutor(max_workers=1) as pool:
                        pending = pool.submit(self.find, self.original)
                        try:
                            self.assertTrue(built.wait(5))
                            self.get(changed, replacement_label)
                        finally:
                            resume.set()
                        item = pending.result(timeout=5)
                self.assertEqual(item.field_kind, 'CharField')

    def test_late_old_build_does_not_evict_a_new_owner_surface(self):
        changed = self.changed_index()
        started = threading.Event()
        resume = threading.Event()
        member_surface = orm_members._member_surface
        def delayed_surface(**kwargs):
            surface = member_surface(**kwargs)
            if kwargs['static_index'] is self.original:
                started.set()
                self.assertTrue(resume.wait(5))
            return surface
        with mock.patch.object(orm_members, '_member_surface', delayed_surface):
            with ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(self.get, self.original)
                try:
                    self.assertTrue(started.wait(5))
                    current = self.get(changed)
                finally:
                    resume.set()
                old = pending.result(timeout=5)
            self.assertIs(self.get(changed), current, 'Old completion discarded the current cache')
        self.assertEqual(next(item for item in old if item.name == 'title').field_kind, 'CharField')
        self.assertEqual(next(item for item in current if item.name == 'title').field_kind, 'TextField')

    def test_model_invalidation_retries_an_inflight_surface_before_publishing(self):
        started = threading.Event()
        resume = threading.Event()
        member_surface = orm_members._member_surface
        calls = []
        def changing_surface(**kwargs):
            surface = member_surface(**kwargs)
            calls.append(1)
            if len(calls) == 1:
                started.set()
                self.assertTrue(resume.wait(5))
                return surface
            return [dataclasses.replace(item, field_kind='TextField') if item.name == 'title' else item
                    for item in surface]
        with mock.patch.object(orm_members, '_member_surface', changing_surface):
            with ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(self.get, self.original)
                try:
                    self.assertTrue(started.wait(5))
                    self.cache.invalidate_model('blog.Post')
                finally:
                    resume.set()
                actual = pending.result(timeout=5)
            self.assertEqual(next(item for item in actual if item.name == 'title').field_kind, 'TextField')
            self.assertIs(self.get(self.original), actual)
        self.assertEqual(len(calls), 2)

    def test_rebuild_adopts_owner_and_invalidates_models_in_one_step(self):
        changed = self.changed_index()
        old_graph = build_model_graph(self.original, self.runtime)
        new_graph = build_model_graph(changed, self.runtime)
        adopted = threading.Event()
        resume = threading.Event()
        force_owner = self.cache.force_owner
        def delayed_adopt(*args, **kwargs):
            force_owner(*args, **kwargs)
            adopted.set()
            self.assertTrue(resume.wait(5))
        with mock.patch.object(orm_members, '_surface_cache', self.cache):
            original_surface = orm_members.build_surface_index(self.original, self.runtime, old_graph)
            with mock.patch.object(self.cache, 'force_owner', delayed_adopt):
                with ThreadPoolExecutor(max_workers=1) as pool:
                    pending = pool.submit(_rebuild_surface_slice, static_index=changed,
                        runtime=self.runtime, model_graph=new_graph, labels={'blog.Post'},
                        surface_index=original_surface, previous_static_index=self.original,
                        previous_model_graph=old_graph)
                    try:
                        self.assertTrue(adopted.wait(5))
                        item = self.cache.find(changed, self.runtime, new_graph,
                            'blog.Post', 'instance', 'title', None)
                    finally:
                        resume.set()
                    updated, _ = pending.result(timeout=5)
        self.assertEqual(item.field_kind, 'TextField')
        self.assertEqual(updated['blog.Post']['instance']['title'][3], 'TextField')

    def test_rebuild_does_not_relabel_an_unrelated_workspace_owner(self):
        wanted_path = self.path
        wanted_path.write_text(wanted_path.read_text().replace('IntegerField', 'FloatField'))
        wanted = build_static_index(self.root)
        old_graph = build_model_graph(wanted, self.runtime)
        wanted_path.write_text(wanted_path.read_text().replace('CharField', 'TextField'))
        changed, _, _ = reindex_single_file(self.root, wanted_path, wanted)
        new_graph = build_model_graph(changed, self.runtime)
        with mock.patch.object(orm_members, '_surface_cache', self.cache):
            original_surface = orm_members.build_surface_index(wanted, self.runtime, old_graph)
            # A concurrent caller populated a different source snapshot after
            # the wanted surface was captured.
            self.get(self.original, 'blog.Other')
            updated, _ = _rebuild_surface_slice(static_index=changed, runtime=self.runtime,
                model_graph=new_graph, labels={'blog.Post'}, surface_index=original_surface,
                previous_static_index=wanted, previous_model_graph=old_graph)
            item = self.cache.find(changed, self.runtime, new_graph,
                'blog.Other', 'instance', 'value', None)
        self.assertEqual(item.field_kind, 'FloatField')
        self.assertEqual(updated['blog.Other']['instance']['value'][3], 'FloatField')

    def test_model_invalidation_does_not_scan_other_cached_keys(self):
        post = self.get(self.original)
        other = self.get(self.original, 'blog.Other')
        class NoScan(dict):
            def __iter__(self):
                raise AssertionError('Unrelated cache keys scanned during model invalidation')
        self.cache._list_cache = NoScan(self.cache._list_cache)
        self.cache.invalidate_model('blog.Post')
        self.assertIs(self.get(self.original, 'blog.Other'), other)
        self.assertIsNot(self.get(self.original), post)

    def test_weak_owner_does_not_accept_recycled_ids_or_retain_source_indexes(self):
        import builtins
        import gc
        import weakref
        old = self.original
        previous_id = id(old)
        self.get(old)
        previous = weakref.ref(old)
        self.original = None
        del old
        gc.collect()
        self.assertIsNone(previous(), 'Cache retained an old workspace index')
        self.path.write_text(self.path.read_text().replace('CharField', 'TextField'))
        changed = build_static_index(self.root)
        def recycled_id(value):
            return previous_id if value is changed else builtins.id(value)
        # Simulate reuse of the released index's address without relying on
        # allocator timing. The real input owners are already gone.
        with mock.patch.object(orm_members, 'id', recycled_id, create=True):
            item = self.find(changed)
        self.assertEqual(item.field_kind, 'TextField')

    def test_expired_graph_owner_is_distinct_from_a_request_without_a_graph(self):
        import gc
        import weakref
        graph = build_model_graph(self.original, self.runtime)
        extra = dataclasses.replace(self.original.find_field('blog.Post', 'title'), name='graph_only')
        graph = dataclasses.replace(graph, fields_by_model_label={
            **graph.fields_by_model_label,
            'blog.Post': {**graph.fields_by_model_label['blog.Post'], 'graph_only': extra}})
        self.cache.get_list(self.original, self.runtime, graph, 'blog.Post', 'instance', None)
        previous = weakref.ref(graph)
        del graph
        gc.collect()
        self.assertIsNone(previous())
        self.assertNotIn('graph_only', {item.name for item in self.get(self.original)})

    def test_rebuild_keeps_unaffected_receiver_surfaces_for_the_expected_owner(self):
        changed = self.changed_index()
        old_graph = build_model_graph(self.original, self.runtime)
        new_graph = build_model_graph(changed, self.runtime)
        with mock.patch.object(orm_members, '_surface_cache', self.cache):
            original_surface = orm_members.build_surface_index(self.original, self.runtime, old_graph)
            other = self.cache.get_list(self.original, self.runtime, old_graph,
                'blog.Other', 'instance', None)
            updated, _ = _rebuild_surface_slice(static_index=changed, runtime=self.runtime,
                model_graph=new_graph, labels={'blog.Post'}, surface_index=original_surface,
                previous_static_index=self.original, previous_model_graph=old_graph)
            self.assertIs(self.cache.get_list(changed, self.runtime, new_graph,
                'blog.Other', 'instance', None), other)
        self.assertIs(updated['blog.Other'], original_surface['blog.Other'])

    def test_build_failures_and_repeated_removed_labels_release_inflight_versions(self):
        with mock.patch.object(orm_members, '_member_surface', side_effect=ValueError('surface failed')):
            with self.assertRaisesRegex(ValueError, 'surface failed'):
                self.get(self.original)
        self.assertFalse(self.cache._inflight)
        self.assertFalse(self.cache._model_versions)
        self.get(self.original)
        for number in range(100):
            label = f'blog.Removed{number}'
            self.get(self.original, label)
            self.cache.invalidate_model(label)
        self.assertEqual(set(self.cache._keys_by_model), {'blog.Post'})
        self.assertEqual(set(self.cache._model_versions), {'blog.Post'})
        self.assertFalse(self.cache._inflight)

    def server(self, graph, surface):
        stdout = sys.stdout
        try:
            server = DaemonServer(self.root)
        finally:
            sys.stdout = stdout
        server.static_index = self.original
        server.runtime_inspection = self.runtime
        server.model_graph = graph
        server._last_surface_index = surface
        return server

    def test_catalogue_only_commit_preserves_current_unaffected_receiver_cache(self):
        # The edited module invalidates all of its classes. Put the unrelated
        # receiver in a separate module for a genuine unaffected cache entry.
        self.path.write_text('from django.db import models\n'
            'class Post(models.Model):\n    title = models.CharField()\n')
        self.path.with_name('other.py').write_text('from django.db import models\n'
            'class Other(models.Model):\n    value = models.IntegerField()\n')
        self.original = build_static_index(self.root)
        old_graph = build_model_graph(self.original, self.runtime)
        with mock.patch.object(orm_members, '_surface_cache', self.cache):
            surface = orm_members.build_surface_index(self.original, self.runtime, old_graph)
            other = self.cache.get_list(self.original, self.runtime, old_graph,
                'blog.Other', 'instance', None)
            server = self.server(old_graph, surface)
            self.path.write_text(self.path.read_text().replace('CharField', 'TextField'))
            outcome = server._compute_reindex(file_path=self.path, static_index=self.original,
                runtime=self.runtime, previous_model_graph=old_graph, existing_surface=surface,
                previous_static_fallback=None)
            outcome.lookup_catalog_delta = {'blog.Post': {'types': {},
                'fields': {'blog.Post': {}}, 'expressionFields': {}, 'relationPaths': {}}}
            server._commit_reindex(outcome)
            self.assertIsNot(server.runtime_inspection, self.runtime)
            self.assertIs(self.cache.get_list(server.static_index, server.runtime_inspection,
                server.model_graph, 'blog.Other', 'instance', None), other)
            self.assertEqual(self.cache.find(server.static_index, server.runtime_inspection,
                server.model_graph, 'blog.Post', 'instance', 'title', None).field_kind, 'TextField')

    def test_unchanged_helper_commit_preserves_current_member_cache(self):
        graph = build_model_graph(self.original, self.runtime)
        with mock.patch.object(orm_members, '_surface_cache', self.cache):
            surface = orm_members.build_surface_index(self.original, self.runtime, graph)
            other = self.cache.get_list(self.original, self.runtime, graph,
                'blog.Other', 'instance', None)
            server = self.server(graph, surface)
            helper = self.path.with_name('helper.py')
            helper.write_text('unused = 1\n')
            outcome = server._compute_reindex(file_path=helper, static_index=self.original,
                runtime=self.runtime, previous_model_graph=graph, existing_surface=surface,
                previous_static_fallback=None)
            self.assertIsNone(outcome.affected_labels)
            self.assertEqual(server._commit_reindex(outcome), {'unchanged': True})
            self.assertIs(self.cache.get_list(server.static_index, self.runtime, graph,
                'blog.Other', 'instance', None), other)

    def test_runtime_rebind_rejects_changed_member_metadata(self):
        previous = dataclasses.replace(self.runtime, django_version='6.1')
        current = dataclasses.replace(previous, django_version='5.2', lookup_catalog={'types': {}})
        first = self.cache.get_list(self.original, previous, None, 'blog.Post', 'queryset', None)
        self.assertIn('fetch_mode', {item.name for item in first})
        self.cache.rebind_runtime(self.original, previous, current, None)
        second = self.cache.get_list(self.original, current, None, 'blog.Post', 'queryset', None)
        self.assertNotIn('fetch_mode', {item.name for item in second})

    def test_cold_and_warm_member_lookup_preserve_duplicate_name_winner(self):
        item = self.get(self.original)[0]
        first = dataclasses.replace(item, name='same', field_kind='CharField')
        last = dataclasses.replace(item, name='same', field_kind='TextField')
        self.cache.invalidate_model('blog.Post')
        with mock.patch.object(orm_members, '_member_surface', return_value=[first, last]):
            self.assertIs(self.find(self.original, name='same'), last)
            self.assertIs(self.find(self.original, name='same'), last)
            self.assertIsNone(self.find(self.original, name='missing'))

    def test_surface_storage_preserves_wire_cache_and_edit_metadata(self):
        graph = build_model_graph(self.original, self.runtime)
        with mock.patch.object(orm_members, '_surface_cache', self.cache):
            original = orm_members.build_surface_index(self.original, self.runtime, graph)
            wire = json.loads(json.dumps(original))
            self.assertEqual(wire['blog.Post']['instance']['title'],
                             ['scalar', 'blog.Post', 'field', 'CharField'])
            self.assertEqual(wire['blog.Post']['model_class']['objects'],
                             ['manager', 'blog.Post', 'manager', None])
            fingerprint = orm_members.fingerprint_surface_index(original)
            # A schema-34 cache written with JSON arrays remains usable.
            with mock.patch.dict('os.environ', {
                    'DJANGO_ORM_INTELLISENSE_CACHE_DIR': str(self.root / 'cache')}):
                save_surface_index(self.root, 'source', 'runtime', wire)
                loaded = load_cached_surface_index(self.root, 'source', 'runtime',
                    static_index=self.original, model_graph=graph)
                self.assertEqual(json.loads(json.dumps(loaded)), wire)
                self.assertEqual(orm_members.fingerprint_surface_index(loaded), fingerprint)
            server = self.server(graph, loaded)
            self.path.write_text(self.path.read_text().replace('CharField', 'TextField'))
            outcome = server._compute_reindex(file_path=self.path, static_index=self.original,
                runtime=self.runtime, previous_model_graph=graph, existing_surface=loaded,
                previous_static_fallback=None)
            fresh = orm_members.build_surface_index(outcome.new_static_index,
                                                   self.runtime, outcome.model_graph)
            self.assertEqual(json.loads(json.dumps(outcome.surface_index)),
                             json.loads(json.dumps(fresh)))
            self.assertEqual(json.loads(json.dumps(loaded)), wire,
                             'Editing a new snapshot changed the previous cached surface')
            changed_wire = json.loads(json.dumps(outcome.surface_index_delta))
            self.assertEqual(changed_wire['blog.Post']['instance']['title'][3], 'TextField')

    def test_member_records_preserve_replace_pickle_and_optional_wire_metadata(self):
        item = orm_members.OrmMemberItem(name='recent', member_kind='method',
            model_label='blog.Post', receiver_kind='queryset', detail='Recent posts',
            source='runtime', return_kind='queryset', return_model_label='blog.Post',
            manager_name='published', file_path=str(self.path), line=3, column=4,
            signature='recent(days: int = 7) -> QuerySet')
        restored = pickle.loads(pickle.dumps(item))
        self.assertEqual(restored, item)
        self.assertEqual(restored.to_dict(), item.to_dict())
        remapped = dataclasses.replace(restored, model_label='db.Post',
                                      return_model_label='db.Post')
        self.assertEqual(remapped.to_dict(), {**item.to_dict(),
            'modelLabel': 'db.Post', 'returnModelLabel': 'db.Post'})
        self.assertEqual(item.model_label, 'blog.Post')

    def test_shared_builtins_preserve_all_receiver_and_manager_metadata(self):
        for version in ('5.2.12', '6.1.2'):
            runtime = dataclasses.replace(self.runtime, django_version=version)
            for label in ('blog.Post', 'blog.Other'):
                for kind in ('instance', 'model_class', 'manager', 'queryset', 'related_manager'):
                    for manager in (None, 'published'):
                        with self.subTest(version=version, label=label, kind=kind, manager=manager):
                            expected = orm_members._member_surface(static_index=self.original,
                                runtime=runtime, model_graph=None, model_label=label,
                                receiver_kind=kind, manager_name=manager)
                            cached = self.cache.get_list(self.original, runtime, None,
                                label, kind, manager)
                            self.assertEqual(list(cached), expected)
                            self.assertEqual([item.to_dict() for item in cached],
                                             [item.to_dict() for item in expected])
                            self.assertEqual(cached[::-1], expected[::-1])
                            for item in expected:
                                found = self.cache.find(self.original, runtime, None,
                                    label, kind, item.name, manager)
                                self.assertEqual(found, item)
                                self.assertEqual(found.to_dict(), item.to_dict())

    def test_shared_builtin_templates_leave_custom_and_foreign_bindings_intact(self):
        local = orm_members.OrmMemberItem(name='recent', member_kind='method',
            model_label='blog.Post', receiver_kind='queryset', detail='Custom recent',
            source='runtime', return_kind='queryset', return_model_label='blog.Other',
            manager_name='published', file_path=str(self.path), line=11, column=4,
            signature='recent(days: int) -> QuerySet')
        builtin = dataclasses.replace(local, name='filter', source='builtin',
            return_model_label='blog.Post', file_path=None, line=None, column=None)
        foreign = dataclasses.replace(builtin, name='foreign', model_label='blog.Other')
        unbound = dataclasses.replace(builtin, name='property', member_kind='property',
            manager_name=None, return_model_label=None, return_kind='scalar', field_kind='BooleanField')
        expected = [builtin, local, foreign, unbound]
        packed = orm_members._CachedMemberSurface(expected, 'blog.Post', 'published')
        self.assertEqual(list(packed), expected)
        self.assertIs(packed[1], local)
        self.assertIs(packed[2], foreign)
        self.assertEqual(packed[3].manager_name, None)
        self.assertEqual(list(orm_members._surface_metadata(packed)),
                         list(orm_members._surface_metadata(expected)))
        self.assertEqual(pickle.loads(pickle.dumps(packed)), packed)
        for item in expected:
            self.assertEqual(packed.find(item.name).to_dict(), item.to_dict())

    def test_failed_cache_construction_preserves_direct_bound_member_records(self):
        with mock.patch.object(orm_members, '_member_surface', side_effect=ValueError('surface failed')):
            with self.assertRaisesRegex(ValueError, 'surface failed'):
                self.get(self.original)
        direct = orm_members._member_surface(static_index=self.original, runtime=self.runtime,
            model_graph=None, model_label='blog.Post', receiver_kind='instance', manager_name=None)
        self.assertTrue(direct)
        self.assertTrue(all(type(item) is orm_members.OrmMemberItem for item in direct))
        self.assertTrue(all(item.model_label == 'blog.Post' for item in direct))
        self.assertEqual(list(self.get(self.original)), direct)

    def test_blocked_cache_build_does_not_change_another_threads_direct_member_bindings(self):
        entered, resume = threading.Event(), threading.Event()
        original = orm_members._member_surface
        def held(**kwargs):
            if kwargs['model_label'] == 'blog.Post':
                entered.set()
                if not resume.wait(5):
                    raise RuntimeError('Surface gate timed out')
            return original(**kwargs)
        with ThreadPoolExecutor(max_workers=1) as executor, \
                mock.patch.object(orm_members, '_member_surface', held):
            cached = executor.submit(self.get, self.original)
            try:
                self.assertTrue(entered.wait(3))
                direct = orm_members._member_surface(static_index=self.original, runtime=self.runtime,
                    model_graph=None, model_label='blog.Other', receiver_kind='manager', manager_name='published')
                self.assertTrue(direct)
                self.assertTrue(all(type(item) is orm_members.OrmMemberItem for item in direct))
                self.assertTrue(all(item.model_label == 'blog.Other' for item in direct))
                self.assertTrue(all(item.manager_name == 'published' for item in direct))
            finally:
                resume.set()
            self.assertTrue(cached.result(timeout=5))

    def test_surface_export_uses_shared_metadata_without_materializing_builtins(self):
        graph = build_model_graph(self.original, self.runtime)
        with mock.patch.object(orm_members, '_surface_cache', self.cache):
            expected = orm_members.build_surface_index(self.original, self.runtime, graph)
            with mock.patch.object(orm_members._CachedMemberSurface, '__getitem__',
                                   side_effect=AssertionError('Full export bound a builtin record')):
                actual = orm_members.build_surface_index(self.original, self.runtime, graph)
            self.assertEqual(actual, expected)
            self.assertEqual(orm_members.fingerprint_surface_index(actual),
                             orm_members.fingerprint_surface_index(expected))


if __name__ == '__main__':
    unittest.main()
