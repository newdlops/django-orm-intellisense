import dataclasses
import hashlib
import os
import unittest
from pathlib import Path
from unittest import mock

import test_duplicate_reindex as original
from django_orm_intellisense.features import orm_members
from django_orm_intellisense.server import app, runtime_members


class RefreshDuplicateOwnerTests(unittest.TestCase):
    setUp = original.DuplicateReindexTests.setUp
    reindex = original.DuplicateReindexTests.reindex
    prime = original.DuplicateReindexTests.prime

    def captured(self, mode='surface'):
        server = self.server
        label = 'models.Post'
        item = orm_members.OrmMemberItem(name='captured', member_kind='method', model_label=label,
            receiver_kind='instance', detail='owned fresh capture', source='runtime',
            return_kind='instance', return_model_label=label)
        snapshot = orm_members.RuntimeMemberSnapshot(orm_members._runtime_member_identity(server.runtime_inspection),
            {(label, 'instance', None): (item,)}, {label: ('objects', 'refreshed')}, frozenset({label}))
        surface = {label: {'instance': {'value': ('scalar', label, 'field', 'CharField'),
            'captured': ('instance', label, 'method', None)}}}
        graph_delta = None
        if mode in ('graph', 'both'):
            graph = server.model_graph
            node = dataclasses.replace(graph.nodes_by_label[label], manager_names=('objects', 'refreshed'))
            updated = dataclasses.replace(graph, nodes_by_label={label: node},
                nodes_by_object_name={'Post': (node,)}, node_by_import_path={node.import_path: node})
            graph_delta = runtime_members.model_graph_delta(graph, updated)
        lookup_delta = None
        if mode in ('lookup', 'both'):
            lookup_delta = {label: {'fields': {label: {'value': 'field'}}, 'types': {
                'field': {'fieldKind': 'CharField', 'lookups': ['exact'], 'transforms': {'field_size': 'size'}},
                'size': {'fieldKind': 'DateField', 'lookups': ['exact'], 'transforms': {}}}}}
        return runtime_members.RuntimeMemberRefresh(snapshot, surface,
            orm_members.fingerprint_surface_index(surface), graph_delta=graph_delta,
            lookup_catalog_delta=lookup_delta)

    def run_capture(self, result=None, capture=None, publish=None):
        server = self.server
        arguments = (server._runtime_member_refresh_token, server._state_generation,
            server._reindex_serial, server.static_index, server.runtime_inspection,
            server.model_graph, self.root, ())
        with mock.patch.object(app, 'refresh_in_process', side_effect=capture,
                return_value=result or self.captured()) as worker, \
                mock.patch.object(server, '_publish_current_surface_snapshot', side_effect=publish) as publication:
            server._refresh_runtime_members(*arguments)
        return worker, publication

    def assert_transfer(self, mode):
        self.prime()
        server = self.server
        previous = server._last_reindex_source
        self.assertIsNotNone(previous)
        self.assertTrue(previous.matches_owner(server))
        runtime, graph, static = server.runtime_inspection, server.model_graph, server.static_index
        serial = server._reindex_serial
        result = self.captured(mode)
        worker, publication = self.run_capture(result)
        worker.assert_called_once()
        publication.assert_called_once()
        self.assertEqual(server._reindex_serial, serial + 1)
        self.assertIs(server.static_index, static)
        self.assertEqual(server._last_surface_index, result.surface)
        self.assertEqual(server.runtime_inspection is runtime, mode not in ('lookup', 'both'))
        self.assertEqual(server.model_graph is graph, mode not in ('graph', 'both'))
        current = server._last_reindex_source
        self.assertTrue(current.matches_owner(server), 'Successful verified refresh expired the recent parsed source')
        self.assertIsNot(current, previous)
        self.assertEqual((current.path, current.identity, current.fingerprint),
            (previous.path, previous.identity, previous.fingerprint))
        self.assertEqual(previous.serial, serial)
        self.assertIs(current.static(), static)
        self.assertIs(current.runtime(), server.runtime_inspection)
        self.assertIs(current.graph(), server.model_graph)
        owners = (server.static_index, server.runtime_inspection, server.model_graph,
            server._last_surface_index, server.health_snapshot)
        with mock.patch.object(server, '_compute_reindex', side_effect=AssertionError('Verified duplicate reparsed source')), \
                mock.patch.object(server, '_discard_bg_pool', side_effect=AssertionError('Verified duplicate discarded workers')), \
                mock.patch.object(server, '_schedule_runtime_member_refresh') as recovery:
            self.assertEqual(self.reindex(), {'unchanged': True, 'sourceUnchanged': True})
        recovery.assert_called_once_with()
        self.assertEqual(server._reindex_serial, serial + 1)
        for before, after in zip(owners, (server.static_index, server.runtime_inspection, server.model_graph,
                server._last_surface_index, server.health_snapshot)):
            self.assertIs(before, after)
        if mode in ('lookup', 'both'):
            catalog = server.runtime_inspection.lookup_catalog
            field = catalog['types'][catalog['fields']['models.Post']['value']]
            self.assertEqual(catalog['types'][field['transforms']['field_size']]['fieldKind'], 'DateField')

    def test_complete_same_graph_refresh_keeps_recent_parse_for_next_duplicate(self):
        self.assert_transfer('surface')

    def test_graph_delta_refresh_keeps_parsed_source_on_new_graph(self):
        self.assert_transfer('graph')

    def test_lookup_delta_refresh_keeps_parsed_source_on_new_runtime(self):
        self.assert_transfer('lookup')

    def test_both_deltas_keep_current_metadata_when_source_is_duplicate(self):
        self.assert_transfer('both')

    def test_expired_recent_source_is_not_resurrected_by_a_valid_refresh(self):
        self.prime()
        server = self.server
        expired = server._last_reindex_source
        server._reindex_serial += 1
        worker, publication = self.run_capture(self.captured('both'))
        worker.assert_called_once(); publication.assert_called_once()
        self.assertIs(server._last_reindex_source, expired)
        self.assertFalse(expired.matches_owner(server))
        with mock.patch.object(server, '_compute_reindex', wraps=server._compute_reindex) as compute, \
                mock.patch.object(server, '_schedule_runtime_member_refresh'):
            self.reindex()
        self.assertTrue(compute.called)

    def test_equal_size_restored_mtime_changed_content_still_reindexes_after_refresh(self):
        self.prime()
        self.run_capture(self.captured('both'))
        cached = self.server._last_reindex_source
        stamp = self.source.stat()
        before = self.source.read_bytes()
        self.source.write_bytes(before.replace(b'CharField', b'DateField'))
        os.utime(self.source, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        self.assertEqual(self.source.stat().st_size, stamp.st_size)
        self.assertEqual(self.source.stat().st_mtime_ns, stamp.st_mtime_ns)
        # A coarse/stubbed identity still must reach the original content proof.
        with mock.patch.object(app, 'source_identity', return_value=(cached.identity, True)), \
                mock.patch.object(self.server, '_compute_reindex', wraps=self.server._compute_reindex) as compute, \
                mock.patch.object(self.server, '_schedule_runtime_member_refresh'):
            self.assertIsNot(self.reindex().get('sourceUnchanged'), True)
        self.assertTrue(compute.called)
        self.assertEqual(self.server.static_index.find_field('models.Post', 'value').field_kind, 'DateField')

    def test_rejected_capture_does_not_transfer_recent_source_to_a_new_generation(self):
        self.prime()
        server = self.server
        previous = server._last_reindex_source
        result = self.captured('both')
        def replaced(*args):
            server._state_generation += 1
            return result
        worker, publication = self.run_capture(capture=replaced)
        worker.assert_called_once(); publication.assert_not_called()
        self.assertIs(server._last_reindex_source, previous)
        self.assertFalse(previous.matches_owner(server))

    def test_publish_reentrant_save_keeps_its_newer_source_record(self):
        self.prime()
        server = self.server
        def saved(*args):
            self.source.write_bytes(self.source.read_bytes().replace(b'CharField', b'DateField'))
            with mock.patch.object(server, '_schedule_runtime_member_refresh'):
                self.reindex()
        worker, publication = self.run_capture(self.captured('both'), publish=saved)
        worker.assert_called_once(); publication.assert_called_once()
        self.assertEqual(server._last_reindex_source.fingerprint, hashlib.sha256(self.source.read_bytes()).digest())
        self.assertTrue(server._last_reindex_source.matches_owner(server))
        with mock.patch.object(server, '_compute_reindex', side_effect=AssertionError('Newer source record lost')), \
                mock.patch.object(server, '_schedule_runtime_member_refresh'):
            self.assertIs(self.reindex().get('sourceUnchanged'), True)
        self.assertEqual(server.static_index.find_field('models.Post', 'value').field_kind, 'DateField')

    def test_duplicate_hash_inflight_before_transfer_cannot_return_the_old_owner_hit(self):
        self.prime()
        server = self.server
        read = Path.read_bytes
        entered = False
        result = self.captured('both')
        def refreshed(path):
            nonlocal entered
            content = read(path)
            if path == self.source and not entered:
                entered = True
                self.run_capture(result)
            return content
        with mock.patch.object(Path, 'read_bytes', refreshed), \
                mock.patch.object(server, '_compute_reindex', wraps=server._compute_reindex) as compute, \
                mock.patch.object(server, '_schedule_runtime_member_refresh'):
            self.assertIsNot(self.reindex().get('sourceUnchanged'), True)
        self.assertTrue(entered)
        self.assertTrue(compute.called)


if __name__ == '__main__':
    unittest.main()
