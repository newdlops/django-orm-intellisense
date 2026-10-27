import os
import dataclasses
import sys
import unittest
from pathlib import Path
from unittest import mock

from django_orm_intellisense.server import app, source_provenance
from django_orm_intellisense.launch_environment import launch_environment_fingerprint
from django_orm_intellisense.discovery.workspace import source_membership_fingerprint
from tests import test_initialize_cached_surface as cached


class SourceProvenanceTests(unittest.TestCase):
    setUp = cached.InitializeCachedSurfaceTests.setUp
    initialize = cached.InitializeCachedSurfaceTests.initialize
    edit = cached.InitializeCachedSurfaceTests.edit

    def test_complete_initial_frame_and_notifications_retain_captured_witness(self):
        result = self.initialize()
        proof = result['sourceProvenance']
        self.assertEqual(proof['version'], 2)
        self.assertEqual(proof['launchEnvironmentFingerprint'], launch_environment_fingerprint())
        self.assertEqual(proof['sourceFingerprint'], self.snapshot.fingerprint)
        self.assertEqual(proof['membershipFingerprint'], source_membership_fingerprint(self.snapshot))
        self.assertEqual(proof['requestedSettingsModule'], None)
        self.assertEqual(proof['interpreter']['path'], os.path.abspath(sys.executable))
        stat = Path(sys.executable).stat()
        self.assertEqual(proof['interpreter']['identity'], [str(value) for value in (
            stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_dev, stat.st_ino)])
        for builder in (self.server._surface_index_notification, self.server._surface_index_changed_payload):
            self.assertEqual(builder()['sourceProvenance'], proof)

    def test_unwatched_edit_cannot_restamp_resident_old_frame_at_publication(self):
        proof = self.initialize()['sourceProvenance']
        self.edit()
        # Publication itself does no IO. Keeping the old producer witness
        # makes the native reader reject this frame against the changed tree.
        with mock.patch.object(app, 'snapshot_python_sources', side_effect=AssertionError('publication scan')), \
                mock.patch.object(app, 'capture_source_provenance', side_effect=AssertionError('restamp')):
            self.assertEqual(self.server._surface_index_changed_payload()['sourceProvenance'], proof)
        self.assertEqual(proof['sourceFingerprint'], self.snapshot.fingerprint)

    def test_dirty_reindexed_owner_cannot_publish_initial_proof(self):
        self.assertIsNotNone(self.initialize()['sourceProvenance'])
        self.server._source_snapshot_dirty = True
        self.assertIsNone(self.server._surface_index_changed_payload()['sourceProvenance'])

    def test_partial_and_unproved_runtime_frames_cannot_publish_proof(self):
        self.initialize()
        self.server._surface_source_complete = False
        self.assertIsNone(self.server._surface_index_notification()['sourceProvenance'])
        self.server._surface_source_complete = True
        self.server._source_provenance_runtime_owned = False
        self.assertIsNone(self.server._surface_index_notification()['sourceProvenance'])

    def test_runtime_refresh_pending_drops_proof(self):
        self.initialize()
        self.server._runtime_member_refresh_token += 1
        self.assertIsNone(self.server._surface_index_changed_payload()['sourceProvenance'])

    def test_reservation_retires_proof_even_when_root_repeats(self):
        self.initialize()
        self.server._reserve_state_generation(workspace_root=self.root, initialized_at=self.server.initialized_at)
        self.assertIsNone(self.server._surface_index_changed_payload()['sourceProvenance'])

    def test_capture_missing_interpreter_is_optional_and_preserves_extra_roots(self):
        membership = source_membership_fingerprint(self.snapshot)
        with mock.patch.object(source_provenance.sys, 'executable', str(self.base / 'missing')):
            self.assertIsNone(source_provenance.capture_source_provenance(self.snapshot, membership, [], None))
        proof = source_provenance.capture_source_provenance(self.snapshot, membership, [self.root / 'extra'], 'settings.production')
        self.assertEqual(proof['extraRoots'], [str(self.root / 'extra')])
        self.assertEqual(proof['requestedSettingsModule'], 'settings.production')

    def test_failed_and_pending_runtime_are_not_eligible_static_routes(self):
        for status in ('warming_up', 'setup_failed', 'future_status'):
            self.assertFalse(app._runtime_can_publish_source_provenance(
                dataclasses.replace(self.runtime, bootstrap_status=status)))
        for status in ('ready', 'skipped_missing_django', 'skipped_missing_settings'):
            self.assertTrue(app._runtime_can_publish_source_provenance(
                dataclasses.replace(self.runtime, bootstrap_status=status)))
