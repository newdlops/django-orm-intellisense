"""Background catalogs must retain their source and live state owner."""
import contextlib
import dataclasses
import io
import os
import sys
import unittest
from types import SimpleNamespace
from unittest import mock

import test_runtime_member_catalog_cache as cache_fixture
from django_orm_intellisense.cache import store
from django_orm_intellisense.features import orm_members
from django_orm_intellisense.discovery.workspace import snapshot_python_sources, source_membership_fingerprint
from django_orm_intellisense.server import app, worker_state


class RuntimeMemberCatalogBackgroundTests(unittest.TestCase):
    setUp = cache_fixture.RuntimeMemberCatalogCacheTests.setUp
    save = cache_fixture.RuntimeMemberCatalogCacheTests.save

    def server(self):
        output = sys.stdout
        try:
            server = app.DaemonServer(self.root)
        finally:
            sys.stdout = output
        server.static_index, server.runtime_inspection, server.model_graph = self.static, self.runtime, self.graph
        snapshot = snapshot_python_sources(self.root)
        server.source_snapshot = snapshot
        self.static._runtime_source_epoch = app.RuntimeSourceEpoch.from_snapshot(snapshot)
        return server, snapshot

    def run_build(self, *, mutate=None, source_dirty=False, invalidated=False, alias=False, cached=False, cached_snapshot=None):
        if alias:
            first, second = self.base / 'first.txt', self.base / 'second.txt'
            first.write_bytes(self.source.read_bytes())
            os.link(first, second)
            self.source.unlink()
            self.source.symlink_to(first)
            self.snapshot = dataclasses.replace(self.snapshot, items={key: tuple(dataclasses.replace(item,
                file_path=str(first)) for item in items) for key, items in self.snapshot.items.items()})
        server, sources = self.server()
        server._source_snapshot_dirty = source_dirty
        if invalidated:
            self.static._runtime_member_snapshot = dataclasses.replace(self.snapshot,
                invalidated_labels=frozenset({'blog.Post'}))
        original = self.static._runtime_member_snapshot
        snapshot = self.snapshot
        def capture(*args, **kwargs):
            if mutate is not None:
                mutate(server, kwargs)
            if alias:
                replacement = self.source.with_name('.alias-switch')
                replacement.symlink_to(second)
                replacement.replace(self.source)
            return snapshot
        surface = self.surface
        class Pool:
            def __init__(self, **kwargs):
                self.state = worker_state.load_surface_worker_state(kwargs['initargs'][0])
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def submit(self, function, members_path):
                worker_state.load_runtime_member_state(members_path)
                return SimpleNamespace(result=lambda: surface)
        log = io.StringIO()
        with contextlib.redirect_stderr(log), \
                mock.patch.object(app, 'load_cached_surface_index', return_value=(self.surface,
                    orm_members.fingerprint_surface_index(self.surface),
                    cached_snapshot if cached_snapshot is not None else self.snapshot) if cached else None), \
                mock.patch.object(app, 'capture_current_runtime_members', side_effect=capture) as full, \
                mock.patch.object(app, 'capture_runtime_member_surface', return_value={}) as legacy, \
                mock.patch.object(app, 'ProcessPoolExecutor', Pool), \
                mock.patch.object(app, 'save_surface_index', wraps=store.save_surface_index) as save, \
                mock.patch.object(server, '_publish_current_surface_snapshot') as publish:
            membership = source_membership_fingerprint(sources)
            runtime_source = app._runtime_source_fingerprint(source_snapshot=sources, static_index=self.static,
                settings_module=self.runtime.settings_module, membership_fingerprint=membership)
            server._start_surface_index_prebuild(generation=server._state_generation, workspace_root=self.root,
                source_snapshot=sources, static_index=self.static, runtime=self.runtime, model_graph=self.graph,
                reason='catalog-owner-test', runtime_source_fingerprint=runtime_source,
                source_membership=membership, source_dirty=source_dirty)
            worker = server._surface_prebuild_future
            if worker is not None:
                worker.join(5)
                self.assertFalse(worker.is_alive())
            self.assertIsNone(server._surface_prebuild_future)
        self.addCleanup(server._cancel_surface_index_idle_load)
        self.addCleanup(server._cancel_runtime_member_refresh)
        return SimpleNamespace(server=server, full=full, legacy=legacy, save=save, publish=publish,
            log=log.getvalue(), original=original, second=second if alias else None)

    def test_complete_snapshot_is_saved_and_installed_before_publication(self):
        result = self.run_build()
        result.full.assert_called_once()
        result.legacy.assert_not_called()
        result.save.assert_called_once()
        self.assertIs(result.save.call_args.kwargs['runtime_members'], self.snapshot)
        self.assertIs(result.server.static_index._runtime_member_snapshot, self.snapshot)
        self.assertEqual(result.server._last_surface_index, self.surface)
        result.publish.assert_called_once()

    def test_owner_switches_discard_older_catalog_before_persistence_or_publication(self):
        for changed in ('generation', 'serial', 'static', 'runtime', 'graph', 'stop'):
            def mutate(server, kwargs):
                if changed == 'generation': server._state_generation += 1
                elif changed == 'serial': server._reindex_serial += 1
                elif changed == 'static': server.static_index = dataclasses.replace(self.static)
                elif changed == 'runtime': server.runtime_inspection = dataclasses.replace(self.runtime)
                elif changed == 'graph': server.model_graph = dataclasses.replace(self.graph)
                else: server._stopping.set()
            with self.subTest(changed=changed):
                result = self.run_build(mutate=mutate)
                result.save.assert_not_called()
                result.publish.assert_not_called()
                self.assertIsNone(self.static._runtime_member_snapshot)

    def test_same_size_restored_mtime_source_change_rejects_catalog(self):
        def mutate(server, kwargs):
            stamp = self.source.stat()
            self.source.write_text(self.source.read_text().replace('CharField', 'DateField'))
            os.utime(self.source, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
            self.assertEqual(self.source.stat().st_size, stamp.st_size)
            self.assertEqual(self.source.stat().st_mtime_ns, stamp.st_mtime_ns)
        result = self.run_build(mutate=mutate)
        result.save.assert_not_called()
        result.publish.assert_not_called()
        self.assertIsNone(self.static._runtime_member_snapshot)

    def test_invalidated_owner_does_not_recapture_stale_parent_classes(self):
        result = self.run_build(invalidated=True)
        result.full.assert_not_called()
        result.legacy.assert_called_once()
        self.assertIs(self.static._runtime_member_snapshot, result.original)
        self.assertTrue(result.server._runtime_members_pending())
        self.assertNotIn('runtime_members', result.save.call_args.kwargs)

    def test_source_dirty_build_keeps_existing_capture_without_persisting_a_catalog(self):
        result = self.run_build(source_dirty=True)
        result.full.assert_not_called()
        result.legacy.assert_called_once()
        result.save.assert_not_called()
        self.assertIsNone(self.static._runtime_member_snapshot)

    def test_cached_catalog_cannot_clear_current_member_invalidations(self):
        result = self.run_build(invalidated=True, cached=True)
        self.assertIs(result.server.static_index._runtime_member_snapshot, result.original)
        self.assertTrue(result.server._runtime_members_pending())

    def test_dirty_source_cannot_adopt_the_initialize_time_cached_catalog(self):
        result = self.run_build(source_dirty=True, cached=True)
        result.save.assert_not_called()
        self.assertIsNone(result.server.static_index._runtime_member_snapshot)

    def test_already_cancelled_capture_does_not_import_or_prepare_django(self):
        with mock.patch.dict(sys.modules, {'django': None}):
            self.assertIsNone(orm_members.capture_current_runtime_members(self.static, self.runtime,
                self.graph, cancelled=lambda: True))
        self.assertIsNone(self.static._runtime_member_snapshot)

    def test_current_complete_capture_is_not_replaced_by_older_disk_records(self):
        old = self.snapshot
        key = ('blog.Post', 'instance', None)
        fresh = dataclasses.replace(old.items[key][0], name='newer_attached', signature='newer_attached() -> Post')
        self.snapshot = dataclasses.replace(old, items={**old.items, key: (fresh,)})
        self.static._runtime_member_snapshot = self.snapshot
        result = self.run_build(cached=True, cached_snapshot=old)
        self.assertEqual(result.server.static_index._runtime_member_snapshot, self.snapshot)
        self.assertEqual(result.server.static_index._runtime_member_snapshot.items[key][0].to_dict(), fresh.to_dict())

    def test_partial_owned_capture_is_completed_before_it_can_be_saved_as_full(self):
        self.static._runtime_member_snapshot = dataclasses.replace(self.snapshot, items={}, manager_names={},
            complete_labels=frozenset(), models={})
        result = self.run_build()
        self.assertEqual(result.server.static_index._runtime_member_snapshot, self.snapshot)
        self.assertEqual(result.save.call_args.kwargs['runtime_members'], self.snapshot)

    def test_capture_receives_owner_cancellation_and_does_not_publish_after_stop(self):
        def mutate(server, kwargs):
            self.assertFalse(kwargs['cancelled']())
            server._stopping.set()
            self.assertTrue(kwargs['cancelled']())
        result = self.run_build(mutate=mutate)
        self.assertNotIn('KeyError', result.log)
        result.save.assert_not_called()
        result.publish.assert_not_called()

    def test_alias_repair_rebases_full_records_and_cannot_persist_under_old_membership(self):
        result = self.run_build(alias=True)
        result.full.assert_called_once()
        result.save.assert_not_called()
        result.publish.assert_called_once()
        self.assertIsNot(result.server.static_index, self.static)
        self.assertIsNone(self.static._runtime_member_snapshot)
        snapshot = result.server.static_index._runtime_member_snapshot
        self.assertIsNotNone(snapshot)
        self.assertTrue(all(item.file_path == str(result.second)
            for values in snapshot.items.values() for item in values))
        self.assertEqual(snapshot.manager_names, self.snapshot.manager_names)


if __name__ == '__main__':
    unittest.main()
