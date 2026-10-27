import copy
import io
import json
import threading
import unittest
from pathlib import Path
from unittest import mock

from django_orm_intellisense.server.app import DaemonServer
from django_orm_intellisense.server.surface_transport import SurfaceSnapshotEncoder


def payload(changed=False):
    return {'surfaceIndex': {'app.A': {'instance': {'name': ['scalar', None, 'field', 'TextField' if changed else 'CharField']}},
        'app.B': {'queryset': {'filter': ['queryset', 'app.B', 'method', None]}}},
        'surfaceFingerprints': {'app.A': 'a2' if changed else 'a1', 'app.B': 'b1'},
        'health': {'phase': 'ready'}, 'runtimeMembersPending': False,
        'lookupCatalog': {'types': {'custom': {'fieldKind': 'TextField' if changed else 'CharField'}}},
        'modelNames': ['A', 'B'], 'futureMetadata': {'signature': 'all preserved'}}


class SurfaceTransportTests(unittest.TestCase):
    def test_delta_uses_last_written_notification_and_preserves_every_other_field(self):
        encoder = SurfaceSnapshotEncoder()
        first = encoder.prepare(payload())
        self.assertEqual(first.payload['surfaceTransport']['kind'], 'full')
        encoder.commit(first)
        current = payload(True)
        before = copy.deepcopy(current)
        second = encoder.prepare(current)
        self.assertEqual(second.payload['surfaceTransport'], {'version': 1, 'sequence': 2, 'kind': 'delta', 'baseSequence': 1})
        self.assertEqual(set(second.payload['surfaceIndexDelta']), {'app.A'})
        self.assertEqual(second.payload['surfaceFingerprints'], {'app.A': 'a2'})
        for key in current.keys() - {'surfaceIndex', 'surfaceFingerprints'}:
            self.assertEqual(second.payload[key], current[key])
        self.assertEqual(current, before)

    def test_baseline_is_owned_and_failed_or_superseded_preparation_cannot_advance_it(self):
        encoder = SurfaceSnapshotEncoder()
        current = payload()
        first = encoder.prepare(current)
        encoder.commit(first)
        current['surfaceFingerprints']['app.A'] = 'poison'
        self.assertEqual(encoder.prepare(payload()).payload['surfaceIndexDelta'], {})
        older = encoder.prepare(payload(True))
        newer = encoder.prepare(payload())
        encoder.commit(newer)
        with self.assertRaises(RuntimeError):
            encoder.commit(older)

    def test_added_and_removed_models_empty_tables_missing_fingerprints_and_reset(self):
        encoder = SurfaceSnapshotEncoder()
        original = payload()
        original['surfaceIndex']['app.C'] = {}
        original['surfaceFingerprints']['app.C'] = 'c1'
        encoder.commit(encoder.prepare(original))
        current = payload()
        current['surfaceIndex']['app.D'] = {}
        current['surfaceFingerprints']['app.D'] = 'd1'
        frame = encoder.prepare(current)
        self.assertEqual(frame.payload['removedSurfaceLabels'], ['app.C'])
        self.assertEqual(frame.payload['surfaceIndexDelta'], {'app.D': {}})
        for malformed in ({}, {'app.A': 'a1'}):
            value = payload()
            value['surfaceFingerprints'] = malformed
            prepared = encoder.prepare(value)
            self.assertEqual(prepared.payload['surfaceTransport']['kind'], 'full')
            encoder.commit(prepared)
            self.assertEqual(encoder.prepare(payload()).payload['surfaceTransport']['kind'], 'full')
        encoder.commit(encoder.prepare(payload()))
        encoder.reset()
        self.assertEqual(encoder.prepare(payload()).payload['surfaceTransport']['kind'], 'full')
        empty = encoder.prepare({'surfaceIndex': {}, 'surfaceFingerprints': {}})
        self.assertEqual(empty.payload['surfaceTransport']['kind'], 'full')

    def server(self):
        server = DaemonServer(workspace_root=Path('/workspace'))
        server._real_stdout = io.StringIO()
        server._surface_transport_enabled = True
        return server

    def test_real_writer_legacy_optin_failure_and_forced_resync(self):
        server = self.server()
        server._surface_transport_enabled = False
        server._write_notification('surfaceIndexChanged', payload())
        self.assertNotIn('surfaceTransport', json.loads(server._real_stdout.getvalue())['params'])
        server._real_stdout = io.StringIO()
        server._surface_transport_enabled = True
        with mock.patch.object(server, '_write_message', side_effect=OSError('pipe failed')):
            with self.assertRaises(OSError):
                server._write_notification('surfaceIndexChanged', payload())
        self.assertEqual(server._surface_transport.baseline.sequence, 0)
        server._write_notification('surfaceIndexChanged', payload())
        server._write_notification('surfaceIndexChanged', payload(True))
        with mock.patch.object(server, '_surface_index_changed_payload', return_value=payload(True)):
            self.assertEqual(server._resync_surface_snapshot(), {'resynced': True})
        frames = [json.loads(line)['params'] for line in server._real_stdout.getvalue().splitlines()]
        self.assertEqual([frame['surfaceTransport']['kind'] for frame in frames], ['full', 'delta', 'full'])

    def test_publication_retries_when_another_notification_advances_the_wire_baseline(self):
        server = self.server()
        server._state_generation = 3
        prepare = server._prepare_message
        intervened = []
        def preparing(message):
            value = prepare(message)
            if not intervened:
                intervened.append(True)
                server._write_notification('surfaceIndexChanged', payload())
            return value
        with mock.patch.object(server, '_surface_index_changed_payload', return_value=payload(True)), \
                mock.patch.object(server, '_prepare_message', side_effect=preparing):
            server._publish_current_surface_snapshot(3)
        frames = [json.loads(line)['params'] for line in server._real_stdout.getvalue().splitlines()]
        self.assertEqual(len(frames), 2)
        self.assertEqual(frames[1]['surfaceTransport']['baseSequence'], 1)
        self.assertEqual(frames[1]['surfaceIndexDelta'], {'app.A': payload(True)['surfaceIndex']['app.A']})

    def test_delta_preparation_holds_neither_state_nor_write_lock_and_save_rejects_old_frame(self):
        server = self.server()
        server._state_generation = 3
        server._write_notification('surfaceIndexChanged', payload())
        entered, resume = threading.Event(), threading.Event()
        prepare = server._prepare_message
        calls = []
        current = [payload(True)]
        def blocked(message):
            if not calls:
                calls.append(True)
                entered.set()
                self.assertTrue(resume.wait(3))
            return prepare(message)
        with mock.patch.object(server, '_surface_index_changed_payload', side_effect=lambda: current[0]), \
                mock.patch.object(server, '_prepare_message', side_effect=blocked):
            worker = threading.Thread(target=server._publish_current_surface_snapshot, args=(3,))
            worker.start()
            try:
                self.assertTrue(entered.wait(3))
                with server._state_lock:
                    server._reindex_serial += 1
                    current[0] = payload()
                server._write_response(42, {'responsive': True})
            finally:
                resume.set()
            worker.join(3)
            self.assertFalse(worker.is_alive())
        messages = [json.loads(line) for line in server._real_stdout.getvalue().splitlines()]
        self.assertEqual(messages[1]['id'], 42)
        self.assertEqual(messages[-1]['params']['surfaceTransport']['sequence'], 2)
        self.assertEqual(messages[-1]['params']['surfaceIndexDelta'], {})
        self.assertEqual(messages[-1]['params']['lookupCatalog'], payload()['lookupCatalog'])

    def test_retired_generation_cannot_write_or_advance_the_transport_baseline(self):
        server = self.server()
        server._state_generation = 3
        server._write_notification('surfaceIndexChanged', payload())
        prepare = server._prepare_message
        def retire(message):
            value = prepare(message)
            with server._state_lock:
                server._state_generation = 4
            return value
        with mock.patch.object(server, '_surface_index_changed_payload', return_value=payload(True)), \
                mock.patch.object(server, '_prepare_message', side_effect=retire):
            server._publish_current_surface_snapshot(3)
        self.assertEqual(len(server._real_stdout.getvalue().splitlines()), 1)
        self.assertEqual(server._surface_transport.baseline.sequence, 1)


if __name__ == '__main__':
    unittest.main()
