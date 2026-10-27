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

from django_orm_intellisense.discovery.workspace import WorkspaceProfile, snapshot_python_sources
from django_orm_intellisense.features.health import build_health_snapshot
from django_orm_intellisense.features import orm_members
from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection
from django_orm_intellisense.semantic.graph import build_model_graph, build_semantic_graph
from django_orm_intellisense.server import app, runtime_members
from django_orm_intellisense.static_index.indexer import build_static_index


class AsyncRuntimeMemberTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='djls-async-member-test-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        package = self.root / 'blog'
        package.mkdir()
        (package / '__init__.py').write_text('')
        self.source = package / 'models.py'
        self.source.write_text('from django.db import models\nclass Post(models.Model):\n    value=models.CharField()\n')
        self.static = build_static_index(self.root)
        self.runtime = dataclasses.replace(create_pending_runtime_inspection(None),
            bootstrap_status='ready', settings_module='fixture_settings')
        self.graph = build_model_graph(self.static, self.runtime)
        self.epoch = runtime_members.RuntimeSourceEpoch.from_snapshot(snapshot_python_sources(self.root))
        self.static._runtime_source_epoch = self.epoch
        self.label = 'blog.Post'

    def snapshot(self, name):
        item = orm_members.OrmMemberItem(name=name, member_kind='method', model_label=self.label,
            receiver_kind='instance', detail='runtime function', source='runtime',
            return_kind='instance', return_model_label=self.label)
        return orm_members.RuntimeMemberSnapshot(orm_members._runtime_member_identity(self.runtime),
            {(self.label, 'instance', None): (item,)}, {self.label: ('objects', 'named')}, frozenset({self.label}))

    def server(self):
        stdout = sys.stdout
        try:
            server = app.DaemonServer(self.root)
        finally:
            sys.stdout = stdout
        server.static_index, server.runtime_inspection, server.model_graph = self.static, self.runtime, self.graph
        server.workspace_profile = WorkspaceProfile(str(self.root), None, None, 'fixture_settings', [])
        server.semantic_graph = build_semantic_graph(server.workspace_profile, self.static, self.runtime)
        server.health_snapshot = build_health_snapshot(workspace=server.workspace_profile,
            static_index=self.static, runtime=self.runtime, semantic_graph=server.semantic_graph,
            initialized_at=server.initialized_at)
        server.health_snapshot['runtime']['futureField'] = {'keep': True}
        self.addCleanup(server._cancel_runtime_member_refresh)
        return server

    def refresh(self, server):
        server._refresh_runtime_members(server._runtime_member_refresh_token,
            server._state_generation, server._reindex_serial, self.static,
            self.runtime, self.graph, self.root, ())

    def result(self):
        surface = {self.label: {'instance': {'value': ('scalar', self.label, 'field', 'CharField'),
            'current': ('instance', self.label, 'method', None)}}}
        return runtime_members.RuntimeMemberRefresh(self.snapshot('current'), surface,
            orm_members.fingerprint_surface_index(surface), runtime_metadata={
                'appCount': 1, 'modelCount': 2, 'fieldCount': 3, 'relationCount': 4,
                'reverseRelationCount': 5, 'managerCount': 6,
                'modelPreview': [{'label': self.label, 'managerNames': ['objects', 'named']}],
            })

    def graph_result(self):
        node = dataclasses.replace(self.graph.nodes_by_label[self.label], manager_names=('objects', 'named'))
        graph = dataclasses.replace(self.graph, nodes_by_label={self.label: node},
            nodes_by_object_name={'Post': (node,)}, node_by_import_path={node.import_path: node})
        chunk = {'fields': {self.label: {'value': 'new'}}, 'types': {
            'new': {'fieldKind': 'DateField', 'lookups': ['exact'], 'transforms': {}}}}
        return dataclasses.replace(self.result(), graph_delta=runtime_members.model_graph_delta(self.graph, graph),
            lookup_catalog_delta={self.label: chunk})

    def test_epoch_tracks_equal_size_restored_mtime_and_unnotified_changes(self):
        initial = snapshot_python_sources(self.root)
        stamp = self.source.stat()
        self.source.write_text(self.source.read_text().replace('CharField', 'DateField'))
        os.utime(self.source, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        identity, reliable = runtime_members.source_identity(self.source)
        updated = self.epoch.after_reindex(self.source, (), identity, identity, reliable)
        current = snapshot_python_sources(self.root)
        self.assertTrue(self.epoch.matches(initial))
        self.assertFalse(self.epoch.matches(current))
        self.assertTrue(updated.matches(current))
        helper = self.root / 'extra.py'
        helper.write_text('value=1\n')
        self.assertFalse(updated.matches(snapshot_python_sources(self.root)))

    def test_epoch_preserves_aliases_for_create_and_delete(self):
        alias = self.root.parent / (self.root.name + '-alias')
        alias.symlink_to(self.root, target_is_directory=True)
        self.addCleanup(alias.unlink)
        epoch = runtime_members.RuntimeSourceEpoch.from_snapshot(snapshot_python_sources(alias))
        source = self.root / 'created.py'
        source.write_text('value=1\n')
        identity, reliable = runtime_members.source_identity(source)
        aliases = ((str(alias), str(self.root)),)
        created = epoch.after_reindex(source, aliases, identity, identity, reliable)
        self.assertTrue(created.matches(snapshot_python_sources(alias)))
        source.unlink()
        removed = created.after_reindex(source, aliases, None, None, True)
        self.assertTrue(removed.matches(snapshot_python_sources(alias)))
        self.assertEqual(epoch.changes, {})

    def test_epoch_rejects_reindex_read_races_and_denied_metadata_until_a_stable_reindex(self):
        old, _ = runtime_members.source_identity(self.source)
        self.source.write_text(self.source.read_text() + '\nvalue=1\n')
        current, _ = runtime_members.source_identity(self.source)
        for reliable in (True, False):
            with self.subTest(reliable=reliable):
                raced = self.epoch.after_reindex(self.source, (), old, current, reliable)
                self.assertFalse(raced.matches(snapshot_python_sources(self.root)))
                stable = raced.after_reindex(self.source, (), current, current, True)
                self.assertTrue(stable.matches(snapshot_python_sources(self.root)))

    def test_pending_snapshot_excludes_edited_runtime_and_old_manager_names_without_changing_previous_owner(self):
        previous = self.snapshot('old')
        self.static._runtime_member_snapshot = previous
        new = build_static_index(self.root)
        orm_members.invalidate_runtime_members(self.static, new, self.runtime, {self.label})
        self.assertEqual(orm_members._captured_runtime_items(new, self.runtime, self.label, 'instance', None), ())
        self.assertEqual(orm_members._manager_names(new, self.runtime, self.label), ['objects'])
        self.assertEqual(orm_members._manager_names(self.static, self.runtime, self.label), ['objects', 'named'])
        self.assertEqual(previous.invalidated_labels, frozenset())
        self.assertEqual(previous.items[(self.label, 'instance', None)][0].name, 'old')

    def test_install_retires_same_owner_inflight_member_builds(self):
        self.static._runtime_member_snapshot = self.snapshot('old')
        started, resume = threading.Event(), threading.Event()
        original = orm_members._compact_member_surface
        calls = []
        def held(**kwargs):
            result = original(**kwargs)
            calls.append(1)
            if len(calls) == 1:
                started.set()
                self.assertTrue(resume.wait(5))
            return result
        cache = orm_members._MemberSurfaceCache()
        with mock.patch.object(orm_members, '_surface_cache', cache), \
                mock.patch.object(orm_members, '_compact_member_surface', held), \
                ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(cache.get_list, self.static, self.runtime, self.graph,
                self.label, 'instance', None)
            try:
                self.assertTrue(started.wait(5))
                orm_members.install_runtime_members(self.static, self.runtime, self.graph, self.snapshot('current'))
            finally:
                resume.set()
            names = {item.name for item in future.result(timeout=5)}
            self.assertIn('current', names)
            self.assertNotIn('old', names)
            self.assertGreaterEqual(len(calls), 2)
            self.assertEqual(cache._inflight, {})

    def test_snapshot_and_source_epoch_preserve_pickle_protocols_zero_through_five(self):
        for protocol in range(pickle.HIGHEST_PROTOCOL + 1):
            with self.subTest(protocol=protocol):
                value = (self.snapshot('current'), self.epoch, self.result())
                self.assertEqual(pickle.loads(pickle.dumps(value, protocol=protocol)), value)

    def test_nested_runtime_label_scopes_use_their_own_graph_and_reset_after_failure(self):
        first, second = mock.Mock(), mock.Mock()
        first.static_to_graph_labels.return_value = {self.label: 'first.Post'}
        second.static_to_graph_labels.return_value = {self.label: 'second.Post'}
        @orm_members._with_runtime_source_paths
        def probe(static_index, runtime, model_graph=None, nested=False):
            if nested:
                self.assertEqual(probe(static_index, runtime, second), ('second', 'Post'))
                self.assertEqual(probe(static_index, runtime), ('blog', 'Post'))
                with self.assertRaisesRegex(ValueError, 'interrupted'):
                    fail(static_index=static_index, runtime=runtime, model_graph=second)
            return orm_members._runtime_model_class(self.label)
        @orm_members._with_runtime_source_paths
        def fail(**kwargs):
            self.assertEqual(orm_members._runtime_model_class(self.label), ('second', 'Post'))
            raise ValueError('interrupted')
        from django.apps import apps
        with mock.patch.object(apps, 'get_model', side_effect=lambda app, name: (app, name)):
            self.assertEqual(probe(self.static, self.runtime, first, nested=True), ('first', 'Post'))
            self.assertEqual(orm_members._runtime_model_class(self.label), ('blog', 'Post'))
        self.assertIsNone(orm_members._runtime_capture_labels.get())
        self.assertIsNone(orm_members._runtime_source_paths.get())

    def test_first_unknown_owner_and_forced_full_capture_require_complete_surface(self):
        snapshot = self.snapshot('current')
        different = dataclasses.replace(snapshot, runtime_identity=('different',))
        for previous, keys in ((None, {'custom.Post'}), (different, {'custom.Post'}), (snapshot, None)):
            with self.subTest(previous=previous, keys=keys):
                self.assertIsNone(runtime_members.changed_runtime_surface_labels(previous, snapshot,
                    {self.label: 'custom.Post'}, keys))

    def test_unchanged_complete_capture_reuses_all_available_surface_entries(self):
        snapshot = self.snapshot('current')
        self.assertEqual(runtime_members.changed_runtime_surface_labels(snapshot, snapshot,
            {self.label: 'custom.Post'}, {'custom.Post'}), frozenset())
        self.assertEqual(runtime_members.changed_runtime_surface_labels(snapshot, snapshot,
            {self.label: 'custom.Post'}, set()), frozenset({self.label}))

    def test_all_fresh_member_fields_and_named_groups_are_compared_beyond_invalidated_labels(self):
        previous = self.snapshot('current')
        key = (self.label, 'instance', None)
        item = previous.items[key][0]
        named = ('unrelated.Other', 'queryset', 'archive')
        variants = (
            dataclasses.replace(previous, items={key: (dataclasses.replace(item, signature='(new) -> Post'),)}),
            dataclasses.replace(previous, items={key: (dataclasses.replace(item, line=99),)}),
            dataclasses.replace(previous, items={}),
            dataclasses.replace(previous, items={**previous.items, named: (dataclasses.replace(item,
                model_label='unrelated.Other', receiver_kind='queryset', manager_name='archive'),)}),
            dataclasses.replace(previous, manager_names={**previous.manager_names, 'unrelated.Other': ('new',)}),
        )
        for current in variants:
            with self.subTest(current=current):
                expected = 'unrelated.Other' if named in current.items or 'unrelated.Other' in current.manager_names else self.label
                self.assertEqual(runtime_members.changed_runtime_surface_labels(previous, current,
                    {self.label: 'custom.Post'}, {'custom.Post'}), frozenset({expected}))

    def test_partial_composition_shares_unchanged_entries_removes_deleted_keys_and_preserves_inputs(self):
        old, unchanged, current = {'old': ()}, {'stable': ()}, {'current': ()}
        existing = {'custom.Post': old, 'custom.Other': unchanged, 'deleted.Gone': old}
        fingerprints = {'custom.Post': 'old', 'custom.Other': 'stable', 'deleted.Gone': 'gone'}
        result = runtime_members.RuntimeMemberRefresh(self.snapshot('current'),
            {'custom.Post': current}, {'custom.Post': 'current'}, complete=False)
        with mock.patch.object(runtime_members, '_surface_keys_by_label',
                return_value={self.label: 'custom.Post', 'blog.Other': 'custom.Other'}):
            surface, updated = runtime_members.compose_runtime_member_surface(self.static, self.graph,
                result, existing, fingerprints)
        self.assertIs(surface['custom.Other'], unchanged)
        self.assertIs(surface['custom.Post'], current)
        self.assertEqual(updated, {'custom.Post': 'current', 'custom.Other': 'stable'})
        self.assertEqual(set(surface), {'custom.Post', 'custom.Other'})
        self.assertIs(existing['custom.Post'], old)
        self.assertIn('deleted.Gone', existing)
        self.assertEqual(fingerprints['custom.Post'], 'old')

    def test_partial_composition_rejects_missing_fingerprints_models_and_unexpected_keys(self):
        result = runtime_members.RuntimeMemberRefresh(self.snapshot('current'), {}, {}, complete=False)
        for surface, fingerprints in (({}, {}), ({self.label: {}}, {}),
                ({self.label: {}}, {self.label: 'current', 'unexpected': 'old'})):
            with self.subTest(surface=surface, fingerprints=fingerprints):
                if 'unexpected' in fingerprints:
                    result = dataclasses.replace(result, surface={'unexpected': {}}, fingerprints={'unexpected': 'new'})
                with self.assertRaisesRegex(RuntimeError, 'complete current model surface'):
                    runtime_members.compose_runtime_member_surface(self.static, self.graph,
                        result, surface, fingerprints)

    def test_partial_refresh_installs_complete_current_surface_with_its_own_fingerprints(self):
        server = self.server()
        old = {self.label: {'instance': {'old': ('instance', self.label, 'method', None)}}, 'deleted.Old': {}}
        server._last_surface_index = old
        server._last_surface_fingerprints = {self.label: 'old', 'deleted.Old': 'old'}
        result = dataclasses.replace(self.result(), complete=False)
        with mock.patch.object(app, 'refresh_in_process', return_value=result) as capture, \
                mock.patch.object(server, '_publish_current_surface_snapshot') as publish:
            self.refresh(server)
        self.assertEqual(server._last_surface_index, result.surface)
        self.assertEqual(server._last_surface_fingerprints, result.fingerprints)
        self.assertEqual(capture.call_args.args[-1], frozenset({self.label, 'deleted.Old'}))
        self.assertIn('old', old[self.label]['instance'])
        publish.assert_called_once()

    def test_runtime_label_scope_does_not_change_another_thread(self):
        started, resume = threading.Event(), threading.Event()
        graph = mock.Mock()
        graph.static_to_graph_labels.return_value = {self.label: 'other.Post'}
        @orm_members._with_runtime_source_paths
        def held(static_index, runtime, model_graph):
            started.set()
            self.assertTrue(resume.wait(5))
            return orm_members._runtime_model_class(self.label)
        from django.apps import apps
        with mock.patch.object(apps, 'get_model', side_effect=lambda app, name: (app, name)), \
                ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(held, self.static, self.runtime, graph)
            try:
                self.assertTrue(started.wait(5))
                self.assertEqual(orm_members._runtime_model_class(self.label), ('blog', 'Post'))
            finally:
                resume.set()
            self.assertEqual(future.result(timeout=5), ('other', 'Post'))

    def test_old_timer_cannot_start_or_clear_current_timer(self):
        server = self.server()
        server._runtime_member_refresh_token = 2
        marker = server._runtime_member_refresh_timer = mock.Mock()
        server._runtime_member_refresh_pending = True
        with mock.patch.object(app.threading, 'Thread') as thread:
            server._start_runtime_member_refresh(1)
        thread.assert_not_called()
        self.assertIs(server._runtime_member_refresh_timer, marker)

    def test_burst_schedules_only_latest_timer_and_cancellation_revokes_pending(self):
        server = self.server()
        with mock.patch.object(app.threading, 'Timer') as timer:
            timers = [mock.Mock() for _ in range(10)]
            timer.side_effect = timers
            for _ in range(10):
                server._schedule_runtime_member_refresh()
            self.assertEqual(server._runtime_member_refresh_token, 10)
            self.assertTrue(server._runtime_members_pending())
            self.assertEqual(timer.call_args.kwargs['args'], (10,))
            for retired in timers[:-1]:
                retired.cancel.assert_called_once()
            server._cancel_runtime_member_refresh()
            timers[-1].cancel.assert_called_once()
            self.assertFalse(server._runtime_member_refresh_pending)

    def test_save_during_active_capture_waits_for_owned_worker_then_starts_latest_token(self):
        server = self.server()
        active = threading.current_thread()
        server._runtime_member_refresh_thread = active
        timers = [mock.Mock(), mock.Mock()]
        def capture(*args):
            server._schedule_runtime_member_refresh()
            with mock.patch.object(app.threading, 'Thread') as spawn:
                server._start_runtime_member_refresh(server._runtime_member_refresh_token)
                spawn.assert_not_called()
            self.assertIs(server._runtime_member_refresh_thread, active)
            return self.result()
        with mock.patch.object(app.threading, 'Timer', side_effect=timers) as timer, \
                mock.patch.object(app, 'refresh_in_process', capture), \
                mock.patch.object(server, '_publish_current_surface_snapshot') as publish:
            self.refresh(server)
        publish.assert_not_called()
        self.assertIsNone(server._runtime_member_refresh_thread)
        self.assertTrue(server._runtime_member_refresh_pending)
        self.assertIs(server._runtime_member_refresh_timer, timers[-1])
        self.assertEqual(timer.call_args.kwargs['args'], (server._runtime_member_refresh_token,))
        timers[-1].start.assert_called_once()

    def test_source_changed_before_capture_is_rejected(self):
        server = self.server()
        health = server.health_snapshot
        self.source.write_text(self.source.read_text() + '\nchanged=1\n')
        with mock.patch.object(app, 'refresh_in_process') as capture, \
                mock.patch.object(server, '_publish_current_surface_snapshot') as publish:
            self.refresh(server)
        capture.assert_not_called()
        publish.assert_not_called()
        self.assertIsNone(self.static._runtime_member_snapshot)
        self.assertIs(server.health_snapshot, health)

    def test_new_save_during_source_scan_is_discarded_as_superseded_and_schedules_latest_worker(self):
        server = self.server()
        active = threading.current_thread()
        server._runtime_member_refresh_thread = active
        snapshot = snapshot_python_sources(self.root)
        timers = [mock.Mock(), mock.Mock()]

        def scan(*args, **kwargs):
            server._reindex_serial += 1
            server._schedule_runtime_member_refresh()
            return snapshot

        with mock.patch.object(app.threading, 'Timer', side_effect=timers) as timer, \
                mock.patch.object(app, 'snapshot_python_sources', side_effect=scan), \
                mock.patch.object(app, 'refresh_in_process') as capture, \
                mock.patch.object(app, '_log_initialize_step') as log, \
                mock.patch.object(server, '_publish_current_surface_snapshot') as publish:
            self.refresh(server)
        capture.assert_not_called()
        publish.assert_not_called()
        log.assert_called_once_with('runtime_members(background) discarded reason=superseded_before_capture')
        self.assertTrue(server._runtime_member_refresh_pending)
        self.assertIsNone(server._runtime_member_refresh_thread)
        self.assertIs(server._runtime_member_refresh_timer, timers[-1])
        self.assertEqual(timer.call_args.kwargs['args'], (server._runtime_member_refresh_token,))
        timers[-1].start.assert_called_once()

    def test_current_source_mismatch_keeps_rejection_and_does_not_start_capture(self):
        server = self.server()
        self.source.write_text(self.source.read_text() + '\nchanged=1\n')
        with mock.patch.object(app, 'refresh_in_process') as capture, \
                mock.patch.object(app, '_log_initialize_step') as log:
            self.refresh(server)
        capture.assert_not_called()
        log.assert_called_once_with('runtime_members(background) rejected reason=source_changed_before_capture')
        self.assertIsNone(self.static._runtime_member_snapshot)

    def test_source_changed_during_capture_is_rejected(self):
        server = self.server()
        health = server.health_snapshot
        def capture(*args):
            self.source.write_text(self.source.read_text() + '\nchanged=1\n')
            return self.result()
        with mock.patch.object(app, 'refresh_in_process', capture), \
                mock.patch.object(server, '_publish_current_surface_snapshot') as publish:
            self.refresh(server)
        publish.assert_not_called()
        self.assertIsNone(self.static._runtime_member_snapshot)
        self.assertIs(server.health_snapshot, health)

    def test_late_capture_cannot_change_replaced_generation_serial_or_input_owner(self):
        for changed in ('generation', 'serial', 'static', 'runtime', 'graph', 'token', 'stop'):
            with self.subTest(changed=changed):
                server = self.server()
                health = server.health_snapshot
                def capture(*args):
                    if changed == 'stop':
                        server._stopping.set()
                    elif changed in ('generation', 'serial', 'token'):
                        field = {'generation': '_state_generation', 'serial': '_reindex_serial',
                            'token': '_runtime_member_refresh_token'}[changed]
                        setattr(server, field, getattr(server, field) + 1)
                    else:
                        field = {'static': 'static_index', 'runtime': 'runtime_inspection', 'graph': 'model_graph'}[changed]
                        setattr(server, field, object())
                    return self.graph_result()
                with mock.patch.object(app, 'refresh_in_process', capture), \
                        mock.patch.object(server, '_publish_current_surface_snapshot') as publish, \
                        mock.patch.object(app, 'install_runtime_members') as install:
                    self.refresh(server)
                publish.assert_not_called()
                install.assert_not_called()
                self.assertIs(server.health_snapshot, health)

    def test_graph_catalogue_surface_and_health_are_adopted_together_without_mutating_old_owners(self):
        server = self.server()
        health = pickle.loads(pickle.dumps(server.health_snapshot))
        old_catalogue = self.runtime.lookup_catalog
        old_node = self.graph.nodes_by_label[self.label]
        result = self.graph_result()
        cache = orm_members._MemberSurfaceCache()
        cache._set_owner(self.static, self.runtime, self.graph, clear=True)
        def publish(generation):
            self.assertEqual(server.model_graph.nodes_by_label[self.label].manager_names, ('objects', 'named'))
            catalogue = server.runtime_inspection.lookup_catalog
            self.assertEqual(catalogue['types'][catalogue['fields'][self.label]['value']]['fieldKind'], 'DateField')
            self.assertIs(self.static._runtime_member_snapshot, result.snapshot)
            self.assertIs(server._last_surface_index, result.surface)
            self.assertEqual(server.health_snapshot['runtime']['modelCount'], 2)
            self.assertTrue(cache._matches_owner(self.static, server.runtime_inspection, server.model_graph))
        with mock.patch.object(app, 'refresh_in_process', return_value=result), \
                mock.patch.object(server, '_publish_current_surface_snapshot', side_effect=publish) as published, \
                mock.patch.object(orm_members, '_surface_cache', cache):
            self.refresh(server)
        published.assert_called_once()
        self.assertIs(self.runtime.lookup_catalog, old_catalogue)
        self.assertNotIn(self.label, old_catalogue.get('fields', {}))
        self.assertIs(self.graph.nodes_by_label[self.label], old_node)
        self.assertEqual(old_node.manager_names, ())
        self.assertIs(server.runtime_inspection.model_catalog, self.runtime.model_catalog)
        self.assertEqual(health['runtime']['modelCount'], 0)

    def test_newer_token_during_surface_preparation_rejects_all_runtime_deltas(self):
        server = self.server()
        health = server.health_snapshot
        def fallback(**kwargs):
            server._runtime_member_refresh_token += 1
            return {}
        with mock.patch.object(app, 'refresh_in_process', return_value=self.graph_result()), \
                mock.patch.object(server, '_build_static_fallback', side_effect=fallback), \
                mock.patch.object(server, '_publish_current_surface_snapshot') as published:
            self.refresh(server)
        published.assert_not_called()
        self.assertIs(server.runtime_inspection, self.runtime)
        self.assertIs(server.model_graph, self.graph)
        self.assertIs(server.health_snapshot, health)
        self.assertIsNone(self.static._runtime_member_snapshot)

    def test_success_installs_surface_and_records_atomically_and_marks_old_surface_builds_stale(self):
        server = self.server()
        previous_health = server.health_snapshot
        previous_health_value = pickle.loads(pickle.dumps(previous_health))
        result = self.result()
        snapshot, surface, fingerprints = result.snapshot, result.surface, result.fingerprints
        observed = []
        def publish(generation):
            observed.append((self.static._runtime_member_snapshot, server._last_surface_index,
                server._last_surface_fingerprints, server._runtime_members_pending(), server._health()))
        with mock.patch.object(app, 'refresh_in_process', return_value=result), \
                mock.patch.object(server, '_publish_current_surface_snapshot', publish):
            self.refresh(server)
        self.assertEqual(observed, [(snapshot, surface, fingerprints, False, server._health())])
        for key, value in result.runtime_metadata.items():
            self.assertEqual(server._health()['runtime'][key], value)
        self.assertEqual(server.semantic_graph.runtime_model_count, result.runtime_metadata['modelCount'])
        self.assertEqual(server._health()['semanticGraph'], server.semantic_graph.to_dict())
        self.assertEqual(previous_health, previous_health_value)
        self.assertIs(server._health()['runtime']['futureField'], previous_health['runtime']['futureField'])
        self.assertIs(server.runtime_inspection, self.runtime)
        self.assertEqual(server._reindex_serial, 1)
        self.assertEqual(server._reindexed_labels, {self.label: 1})
        self.assertTrue(self.static._runtime_source_epoch.matches(snapshot_python_sources(self.root)))
        old_surface = {self.label: {'instance': {'old': ('instance', self.label, 'method', None)}}}
        with server._state_lock:
            server._commit_loaded_surface_index(old_surface,
                surface_fingerprints=orm_members.fingerprint_surface_index(old_surface),
                static_fallback=None, built_from_static_index=self.static,
                built_from_model_graph=self.graph, built_at_serial=0)
        self.assertEqual(server._last_surface_index, surface)
        self.assertEqual(server._last_surface_fingerprints, fingerprints)
        self.assertIs(self.static._runtime_member_snapshot, snapshot)
        self.assertFalse(server._runtime_members_pending())

    def test_refresh_without_optional_metadata_keeps_latest_health_and_runtime_owner(self):
        for missing in (False, True):
            with self.subTest(missing=missing):
                server = self.server()
                previous = server.health_snapshot['runtime']
                previous['modelCount'] = 19
                result = dataclasses.replace(self.result(), runtime_metadata=None)
                if missing:
                    object.__delattr__(result, 'runtime_metadata')
                    object.__delattr__(result, 'graph_delta')
                    object.__delattr__(result, 'lookup_catalog_delta')
                with mock.patch.object(app, 'refresh_in_process', return_value=result), \
                        mock.patch.object(server, '_publish_current_surface_snapshot'):
                    self.refresh(server)
                self.assertIs(server.health_snapshot['runtime'], previous)
                self.assertEqual(server.semantic_graph.runtime_model_count, 19)
                self.assertIs(server.runtime_inspection, self.runtime)

    def test_cancelled_process_closes_private_writer_and_removes_input_directory(self):
        captured = []
        class Process:
            returncode = None
            def __init__(process, argv, **kwargs):
                process.path = Path(argv[3])
                process.errors = kwargs['stderr']
                with process.path.open('rb') as stream:
                    self.assertEqual(len(pickle.load(stream)), 4)
                captured.append(process)
            def poll(process):
                return process.returncode
            def terminate(process):
                process.returncode = -15
            def wait(process, timeout):
                return process.returncode
        with mock.patch.object(runtime_members.subprocess, 'Popen', Process):
            result = runtime_members.refresh_in_process(self.static, self.runtime, self.graph,
                self.root, (), mock.Mock(side_effect=[True, False]), threading.Event())
        self.assertIsNone(result)
        self.assertEqual(captured[0].returncode, -15)
        self.assertTrue(captured[0].errors.closed)
        self.assertFalse(captured[0].path.parent.exists())

    def test_failed_process_spawn_and_nonzero_exit_release_owned_files(self):
        for failure in ('spawn', 'exit'):
            with self.subTest(failure=failure):
                captured = []
                def start(argv, **kwargs):
                    captured.append((Path(argv[3]), kwargs['stderr']))
                    if failure == 'spawn':
                        raise OSError('spawn failed')
                    return mock.Mock(returncode=7, poll=mock.Mock(return_value=7))
                with mock.patch.object(runtime_members.subprocess, 'Popen', start):
                    with self.assertRaisesRegex(OSError if failure == 'spawn' else RuntimeError,
                            'spawn failed' if failure == 'spawn' else 'code 7'):
                        runtime_members.refresh_in_process(self.static, self.runtime, self.graph,
                            self.root, (), lambda: True, threading.Event())
                self.assertFalse(captured[0][0].parent.exists())
                self.assertTrue(captured[0][1].closed)

    def test_unresponsive_owned_child_is_killed_and_reaped_on_cancellation(self):
        process = mock.Mock(returncode=None, poll=mock.Mock(return_value=None))
        process.wait.side_effect = [subprocess.TimeoutExpired('worker', 1), -9]
        paths = []
        def start(argv, **kwargs):
            paths.append(Path(argv[3]))
            return process
        with mock.patch.object(runtime_members.subprocess, 'Popen', start):
            result = runtime_members.refresh_in_process(self.static, self.runtime, self.graph,
                self.root, (), mock.Mock(side_effect=[True, False]), threading.Event())
        self.assertIsNone(result)
        process.terminate.assert_called_once()
        process.kill.assert_called_once()
        self.assertEqual(process.wait.call_count, 2)
        self.assertFalse(paths[0].parent.exists())

    def test_actual_daemon_consecutive_edits_update_default_and_named_member_chains(self):
        result = subprocess.run([sys.executable, '-m', 'benchmarks.check_async_runtime_member_refresh',
            '--output-dir', str(self.root / 'probe-output')], capture_output=True, text=True, timeout=35)
        self.assertEqual(result.returncode, 0, result.stderr[-4000:])
        value = json.loads(result.stdout)
        self.assertEqual(len(value['rows']), 2)
        self.assertEqual(value['daemonExitCode'], 0)
        self.assertTrue(all(row['allFiveReceiverNamesCurrent'] and row['namedManagerAndChainsCurrent']
            and row['oldNamesExcludedWhilePending'] for row in value['rows']))

    def test_actual_daemon_custom_app_label_has_initial_and_refreshed_runtime_members(self):
        result = subprocess.run([sys.executable, '-m', 'benchmarks.check_async_runtime_member_refresh',
            '--custom-app-label', '--dynamic-manager', '--output-dir', str(self.root / 'custom-label-output')],
            capture_output=True, text=True, timeout=35)
        self.assertEqual(result.returncode, 0, result.stderr[-4000:])
        value = json.loads(result.stdout)
        self.assertEqual(value['modelLabel'], 'custom_runtime.Post')
        self.assertTrue(value['initialAllFiveReceiverNamesPresent'])
        self.assertTrue(value['dynamicallyAttachedManager'])
        self.assertEqual(len(value['rows']), 2)
        self.assertEqual(value['daemonExitCode'], 0)
