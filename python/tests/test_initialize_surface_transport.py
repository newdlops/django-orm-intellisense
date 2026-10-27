import copy
import io
import json
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from django_orm_intellisense.server.app import DaemonServer


class InitializeSurfaceTransportTests(unittest.TestCase):
    def owner_fixture(self):
        server = DaemonServer(workspace_root=Path('/workspace'))
        server._real_stdout = io.StringIO()
        server._surface_transport_enabled = True
        server._source_configuration_fingerprint = 'current-configuration'
        server._state_generation = 3
        server._reindex_serial = 7
        server._source_snapshot_dirty = False
        server._source_provenance_runtime_owned = True
        server._surface_source_complete = True
        server._source_provenance = {'testOwner': 'current-live-owner'}
        server.health_snapshot = {'phase': 'ready'}
        server._last_model_names = ['A', 'B']
        server._last_surface_index = {
            'app.A': {'instance': {'value': ['scalar', None, 'field', 'CharField']}},
            'app.B': {'queryset': {'all': ['queryset', 'app.B', 'method', None]}}}
        server._last_surface_fingerprints = {'app.A': 'a1', 'app.B': 'b1'}
        server._last_custom_lookups_fingerprint = 'lookups-current'
        server._last_static_fallback = None
        server._last_static_fallback_fingerprint = None
        server.runtime_inspection = SimpleNamespace(bootstrap_status='ready',
            custom_lookups={'CharField': ['exact']}, lookup_catalog={'types': {'char': {'fieldKind': 'CharField'}}})
        frame = dict(serverName='django-orm-intellisense', protocolVersion='0.1',
            sourceObservationContext={'version': 1, 'roots': [], 'configurationFiles': [], 'sitePackages': []},
            sourceProvenance=server._source_provenance, health=server.health_snapshot,
            modelNames=server._last_model_names, surfaceIndex=server._last_surface_index,
            surfaceFingerprints=server._last_surface_fingerprints,
            customLookups=server.runtime_inspection.custom_lookups,
            lookupCatalog=server.runtime_inspection.lookup_catalog,
            customLookupsFingerprint=server._last_custom_lookups_fingerprint,
            staticFallback=server._last_static_fallback,
            staticFallbackFingerprint=server._last_static_fallback_fingerprint,
            venvInfo={'root': '/private/current-venv'}, futureMetadata={'signature': '(self) -> str', 'docs': 'all preserved'})
        return server, frame

    def messages(self, server):
        return [json.loads(line) for line in server._real_stdout.getvalue().splitlines()]

    def dispatch(self, server, frame, capability):
        params = {} if capability is None else {'initializeSurfaceTransport': capability}
        with mock.patch.object(server, '_initialize', return_value=frame):
            server._handle_request({'id': 'init-1', 'method': 'initialize', 'params': params})

    def test_negotiated_real_dispatch_writes_full_before_committing_and_preserves_all_values(self):
        server, frame = self.owner_fixture()
        before = copy.deepcopy(frame)
        write = server._write_message
        seen = []
        def writing(payload, **kwargs):
            seen.append(server._surface_transport.baseline.sequence)
            return write(payload, **kwargs)
        with mock.patch.object(server, '_write_message', side_effect=writing):
            self.dispatch(server, frame, 1)
        message, = self.messages(server)
        sent = message['result']
        self.assertEqual(sent.pop('surfaceTransport'), {'version': 1, 'sequence': 1, 'kind': 'full'})
        self.assertEqual(sent, before)
        self.assertEqual(frame, before)
        self.assertEqual(seen, [0])
        self.assertEqual(server._surface_transport.baseline.sequence, 1)

    def test_legacy_and_unsupported_capabilities_keep_original_response_and_no_baseline(self):
        for capability in (None, 0, False, True, 2, '1'):
            with self.subTest(capability=capability):
                server, frame = self.owner_fixture()
                self.dispatch(server, frame, capability)
                self.assertEqual(self.messages(server), [{'id': 'init-1', 'result': frame}])
                self.assertEqual(server._surface_transport.baseline.sequence, 0)

    def test_partial_source_pending_runtime_and_incomplete_fingerprints_keep_full_fallback(self):
        mutations = [lambda server, frame: setattr(server, '_surface_source_complete', False),
            lambda server, frame: setattr(server, '_source_snapshot_dirty', True),
            lambda server, frame: setattr(server, '_source_provenance_runtime_owned', False),
            lambda server, frame: setattr(server, '_runtime_member_refresh_token', 1),
            lambda server, frame: setattr(server.runtime_inspection, 'bootstrap_status', 'warming_up'),
            lambda server, frame: setattr(server, '_source_configuration_fingerprint', None),
            lambda server, frame: frame.pop('sourceObservationContext'),
            lambda server, frame: frame['surfaceFingerprints'].pop('app.B'),
            lambda server, frame: frame['surfaceFingerprints'].update({'app.B': 1}),
            lambda server, frame: setattr(server, '_surface_transport_enabled', False)]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                server, frame = self.owner_fixture(); mutate(server, frame)
                server._write_initialize_response('init-1', frame)
                self.assertEqual(self.messages(server), [{'id': 'init-1', 'result': frame}])
                self.assertEqual(server._surface_transport.baseline.sequence, 0)

    def test_equal_but_detached_provenance_or_metadata_cannot_claim_current_owner(self):
        for key in ('sourceProvenance', 'health', 'modelNames', 'surfaceIndex', 'surfaceFingerprints',
                'customLookups', 'lookupCatalog'):
            with self.subTest(key=key):
                server, frame = self.owner_fixture()
                frame[key] = copy.deepcopy(frame[key])
                server._write_initialize_response('init-1', frame)
                self.assertNotIn('surfaceTransport', self.messages(server)[0]['result'])
                self.assertEqual(server._surface_transport.baseline.sequence, 0)

    def test_initialize_forces_full_even_after_prior_written_notification(self):
        server, frame = self.owner_fixture()
        server._write_notification('surfaceIndexChanged', frame)
        server._write_initialize_response('init-1', frame)
        first, initialized = self.messages(server)
        self.assertEqual(first['params']['surfaceTransport']['sequence'], 1)
        self.assertEqual(initialized['result']['surfaceTransport'], {'version': 1, 'sequence': 2, 'kind': 'full'})
        self.assertEqual(initialized['result']['surfaceIndex'], frame['surfaceIndex'])

    def test_successor_delta_retains_unmodified_models_and_owned_fingerprint_baseline(self):
        server, frame = self.owner_fixture()
        server._write_initialize_response('init-1', frame)
        frame['surfaceFingerprints']['app.A'] = 'caller-only'
        next_frame = copy.deepcopy(frame)
        next_frame['surfaceFingerprints'] = {'app.A': 'a2', 'app.B': 'b1'}
        next_frame['surfaceIndex']['app.A']['instance']['value'][3] = 'TextField'
        server._write_notification('surfaceIndexChanged', next_frame)
        delta = self.messages(server)[1]['params']
        self.assertEqual(delta['surfaceTransport'], {'version': 1, 'sequence': 2, 'kind': 'delta', 'baseSequence': 1})
        self.assertEqual(set(delta['surfaceIndexDelta']), {'app.A'})
        self.assertEqual(delta['surfaceFingerprints'], {'app.A': 'a2'})
        self.assertEqual(delta['futureMetadata'], frame['futureMetadata'])

    def test_failed_write_never_commits_initialize_successor(self):
        server, frame = self.owner_fixture()
        previous = server._surface_transport.baseline
        with mock.patch.object(server, '_write_message', side_effect=OSError('closed owned pipe')):
            with self.assertRaises(OSError):
                server._write_initialize_response('init-1', frame)
        self.assertIs(server._surface_transport.baseline, previous)
        self.assertEqual(self.messages(server), [])

    def test_encoding_failure_never_commits_or_writes_a_transport_header(self):
        server, frame = self.owner_fixture()
        previous = server._surface_transport.baseline
        with mock.patch.object(server, '_prepare_message', side_effect=ValueError('owned encoder failed')):
            with self.assertRaises(ValueError):
                server._write_initialize_response('init-1', frame)
        self.assertIs(server._surface_transport.baseline, previous)
        self.assertEqual(self.messages(server), [])

    def test_owner_generation_reindex_configuration_and_member_races_use_original_response(self):
        mutations = [lambda server: setattr(server, '_state_generation', server._state_generation + 1),
            lambda server: setattr(server, '_reindex_serial', server._reindex_serial + 1),
            lambda server: setattr(server, '_source_configuration_fingerprint', 'changed-configuration'),
            lambda server: setattr(server, '_source_snapshot_dirty', True),
            lambda server: setattr(server, '_runtime_member_refresh_token', server._runtime_member_refresh_token + 1),
            lambda server: setattr(server, '_source_provenance', copy.deepcopy(server._source_provenance)),
            lambda server: server._stopping.set()]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                server, frame = self.owner_fixture()
                prepare = server._prepare_message
                calls = []
                def preparing(message):
                    prepared = prepare(message)
                    if not calls:
                        calls.append(True); mutate(server)
                    return prepared
                with mock.patch.object(server, '_prepare_message', side_effect=preparing):
                    server._write_initialize_response('init-1', frame)
                self.assertEqual(self.messages(server), [{'id': 'init-1', 'result': frame}])
                self.assertEqual(server._surface_transport.baseline.sequence, 0)

    def test_intervening_written_notification_prevents_old_initialize_baseline_commit(self):
        server, frame = self.owner_fixture()
        prepare, calls = server._prepare_message, []
        def preparing(message):
            prepared = prepare(message)
            if not calls:
                calls.append(True)
                server._write_notification('surfaceIndexChanged', frame)
            return prepared
        with mock.patch.object(server, '_prepare_message', side_effect=preparing):
            server._write_initialize_response('init-1', frame)
        notification, initialized = self.messages(server)
        self.assertEqual(notification['params']['surfaceTransport']['sequence'], 1)
        self.assertEqual(initialized, {'id': 'init-1', 'result': frame})
        self.assertEqual(server._surface_transport.baseline.sequence, 1)

    def test_preparation_holds_neither_lock_and_concurrent_save_rejects_prepared_frame(self):
        server, frame = self.owner_fixture()
        prepare, entered, resume = server._prepare_message, threading.Event(), threading.Event()
        calls, errors = [], []
        def preparing(message):
            if not calls:
                calls.append(True); entered.set()
                if not resume.wait(2): raise RuntimeError('test preparation was not resumed')
            return prepare(message)
        def write():
            try: server._write_initialize_response('init-1', frame)
            except Exception as error: errors.append(error)
        with mock.patch.object(server, '_prepare_message', side_effect=preparing):
            worker = threading.Thread(target=write)
            worker.start()
            try:
                self.assertTrue(entered.wait(2))
                acquired = server._state_lock.acquire(timeout=1)
                self.assertTrue(acquired)
                if acquired:
                    server._reindex_serial += 1
                    server._state_lock.release()
                acquired = server._write_lock.acquire(timeout=1)
                self.assertTrue(acquired)
                if acquired: server._write_lock.release()
            finally:
                resume.set(); worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(self.messages(server), [{'id': 'init-1', 'result': frame}])
        self.assertEqual(server._surface_transport.baseline.sequence, 0)

    def test_full_resync_still_recovers_after_negotiated_initialize(self):
        server, frame = self.owner_fixture()
        server._write_initialize_response('init-1', frame)
        with mock.patch.object(server, '_surface_index_changed_payload', return_value=frame):
            self.assertEqual(server._resync_surface_snapshot(), {'resynced': True})
        recovered = self.messages(server)[1]['params']
        self.assertEqual(recovered['surfaceTransport'], {'version': 1, 'sequence': 2, 'kind': 'full'})
        self.assertEqual(recovered['surfaceIndex'], frame['surfaceIndex'])

    def test_complete_empty_model_table_is_not_treated_as_partial_metadata(self):
        server, frame = self.owner_fixture()
        frame['surfaceIndex'].clear(); frame['surfaceFingerprints'].clear(); frame['modelNames'].clear()
        server._write_initialize_response('init-1', frame)
        initialized = self.messages(server)[0]['result']
        self.assertEqual(initialized['surfaceIndex'], {})
        self.assertEqual(initialized['surfaceTransport']['kind'], 'full')
        self.assertEqual(server._surface_transport.baseline.fingerprints, {})

if __name__ == '__main__':
    unittest.main()
