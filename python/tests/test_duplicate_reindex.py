import dataclasses
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from django_orm_intellisense.discovery.workspace import WorkspaceProfile, snapshot_python_sources
from django_orm_intellisense.features.health import build_health_snapshot
from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection
from django_orm_intellisense.semantic.graph import build_model_graph, build_semantic_graph
from django_orm_intellisense.server import app, runtime_members
from django_orm_intellisense.static_index.indexer import build_static_index


class DuplicateReindexTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='djls-duplicate-reindex-test-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.source = self.root / 'models.py'
        self.source.write_text('from django.db import models\nclass Post(models.Model):\n    value=models.CharField(max_length=255)\n')
        output = sys.stdout
        try:
            self.server = app.DaemonServer(self.root)
        finally:
            sys.stdout = output
        self.addCleanup(self.server._cancel_runtime_member_refresh)
        server = self.server
        server.static_index = build_static_index(self.root)
        server.runtime_inspection = dataclasses.replace(create_pending_runtime_inspection(None), bootstrap_status='ready')
        server.model_graph = build_model_graph(server.static_index, server.runtime_inspection)
        server.workspace_profile = WorkspaceProfile(str(self.root), None, None, None, [])
        server.semantic_graph = build_semantic_graph(server.workspace_profile, server.static_index, server.runtime_inspection)
        server.health_snapshot = build_health_snapshot(workspace=server.workspace_profile,
            static_index=server.static_index, runtime=server.runtime_inspection,
            semantic_graph=server.semantic_graph, initialized_at=server.initialized_at)
        server.static_index._runtime_source_epoch = runtime_members.RuntimeSourceEpoch.from_snapshot(snapshot_python_sources(self.root))

    def reindex(self, source=None):
        return self.server._reindex_file({'filePath': str(source or self.source)})

    def prime(self):
        with mock.patch.object(self.server, '_schedule_runtime_member_refresh'):
            return self.reindex()

    def test_identical_stable_duplicate_preserves_index_graph_surface_epoch_and_serial(self):
        self.prime()
        server = self.server
        previous = (server.static_index, server.model_graph, server._last_surface_index,
            server.static_index._runtime_source_epoch, server.health_snapshot)
        serial = server._reindex_serial
        with mock.patch.object(server, '_compute_reindex', side_effect=AssertionError('duplicate rebuilt source')), \
                mock.patch.object(server, '_discard_bg_pool', side_effect=AssertionError('duplicate discarded workers')), \
                mock.patch.object(server, '_schedule_runtime_member_refresh') as refresh:
            self.assertEqual(self.reindex(), {'unchanged': True, 'sourceUnchanged': True})
        self.assertEqual(server._reindex_serial, serial)
        for old, current in zip(previous, (server.static_index, server.model_graph, server._last_surface_index,
                server.static_index._runtime_source_epoch, server.health_snapshot)):
            self.assertIs(old, current)
        refresh.assert_called_once_with()

    def test_duplicate_does_not_cancel_or_delay_pending_refresh(self):
        self.prime()
        server = self.server
        for pending, thread in [(True, None), (False, object()), (True, object())]:
            with self.subTest(pending=pending, active=thread is not None):
                server._runtime_member_refresh_pending = pending
                server._runtime_member_refresh_thread = thread
                server._runtime_member_refresh_token = 8
                server._runtime_member_ready_token = 7
                server._runtime_member_refresh_deadline = 12.5
                with mock.patch.object(server, '_schedule_runtime_member_refresh', side_effect=AssertionError('duplicate superseded refresh')):
                    self.assertEqual(self.reindex(), {'unchanged': True, 'sourceUnchanged': True, 'runtimeMembersPending': True})
                self.assertEqual(server._runtime_member_refresh_token, 8)
                self.assertEqual(server._runtime_member_refresh_deadline, 12.5)
        server._runtime_member_refresh_thread = None

    def test_equal_size_preserved_mtime_content_edit_is_reindexed(self):
        self.prime()
        stamp = self.source.stat()
        self.source.write_text(self.source.read_text().replace('CharField', 'DateField'))
        os.utime(self.source, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        with mock.patch.object(self.server, '_schedule_runtime_member_refresh'):
            self.assertNotIn('unchanged', self.reindex())
        self.assertEqual(self.server.static_index.find_field('models.Post', 'value').field_kind, 'DateField')

    def test_coarse_stat_identity_cannot_hide_changed_content(self):
        identity = runtime_members.source_identity(self.source)
        with mock.patch.object(app, 'source_identity', return_value=identity):
            self.prime()
            self.source.write_text(self.source.read_text().replace('CharField', 'DateField'))
            with mock.patch.object(self.server, '_schedule_runtime_member_refresh'):
                self.assertNotIn('unchanged', self.reindex())
        self.assertEqual(self.server.static_index.find_field('models.Post', 'value').field_kind, 'DateField')

    def test_function_body_change_with_identical_model_summary_is_reindexed(self):
        self.source.write_text(self.source.read_text() + '\ndef helper():\n    return 1\n')
        self.prime()
        identity = runtime_members.source_identity(self.source)
        self.source.write_text(self.source.read_text().replace('return 1', 'return 2'))
        serial = self.server._reindex_serial
        with mock.patch.object(app, 'source_identity', return_value=identity), \
                mock.patch.object(self.server, '_schedule_runtime_member_refresh'), \
                mock.patch.object(self.server, '_compute_reindex', wraps=self.server._compute_reindex) as compute:
            self.reindex()
        self.assertTrue(compute.called)
        self.assertGreater(self.server._reindex_serial, serial)

    def test_source_read_error_uses_existing_reindex_error_handling(self):
        self.prime()
        read = Path.read_bytes
        def denied(path):
            if path == self.source:
                raise PermissionError('denied')
            return read(path)
        with mock.patch.object(Path, 'read_bytes', denied), \
                mock.patch.object(self.server, '_schedule_runtime_member_refresh'), \
                mock.patch.object(self.server, '_compute_reindex', wraps=self.server._compute_reindex) as compute:
            self.reindex()
        self.assertTrue(compute.called)

    def test_state_generation_serial_static_runtime_and_graph_changes_expire_duplicate(self):
        server = self.server
        for owner in ['generation', 'serial', 'static', 'runtime', 'graph']:
            with self.subTest(owner=owner):
                self.prime()
                if owner == 'generation':
                    server._state_generation += 1
                elif owner == 'serial':
                    server._reindex_serial += 1
                elif owner == 'static':
                    server.static_index = build_static_index(self.root)
                elif owner == 'runtime':
                    server.runtime_inspection = dataclasses.replace(server.runtime_inspection)
                else:
                    server.model_graph = dataclasses.replace(server.model_graph)
                with mock.patch.object(server, '_schedule_runtime_member_refresh'), \
                        mock.patch.object(server, '_compute_reindex', wraps=server._compute_reindex) as compute:
                    self.reindex()
                self.assertTrue(compute.called)

    def test_edit_during_duplicate_hash_rechecks_source_and_reindexes(self):
        self.prime()
        read = Path.read_bytes
        changed = False
        def raced(path):
            nonlocal changed
            value = read(path)
            if path == self.source and not changed:
                changed = True
                path.write_bytes(value.replace(b'CharField', b'DateField'))
            return value
        with mock.patch.object(Path, 'read_bytes', raced), \
                mock.patch.object(self.server, '_schedule_runtime_member_refresh'):
            self.assertNotIn('unchanged', self.reindex())
        self.assertEqual(self.server.static_index.find_field('models.Post', 'value').field_kind, 'DateField')

    def test_unreliable_identity_never_bypasses_existing_reindex(self):
        self.prime()
        with mock.patch.object(app, 'source_identity', return_value=(None, False)), \
                mock.patch.object(self.server, '_schedule_runtime_member_refresh'), \
                mock.patch.object(self.server, '_compute_reindex', wraps=self.server._compute_reindex) as compute:
            self.reindex()
        self.assertTrue(compute.called)

    def test_parser_fingerprint_describes_consumed_bytes_instead_of_later_file(self):
        read = Path.read_bytes
        def different(path):
            value = read(path)
            return value.replace(b'CharField', b'DateField') if path == self.source else value
        with mock.patch.object(Path, 'read_bytes', different):
            self.prime()
        self.assertEqual(self.server.static_index.find_field('models.Post', 'value').field_kind, 'DateField')
        with mock.patch.object(self.server, '_schedule_runtime_member_refresh'):
            self.assertNotIn('unchanged', self.reindex())
        self.assertEqual(self.server.static_index.find_field('models.Post', 'value').field_kind, 'CharField')

    def test_new_package_sibling_is_promoted_even_when_module_bytes_are_unchanged(self):
        self.prime()
        sibling = self.root / 'models'
        sibling.mkdir()
        init = sibling / '__init__.py'
        init.write_text(self.source.read_text().replace('class Post', 'class PackagePost'))
        with mock.patch.object(self.server, '_schedule_runtime_member_refresh'):
            self.reindex()
        self.assertEqual(self.server.static_index.modules['models'].file_path, str(init))
        self.assertIn('models.PackagePost', {model.label for model in self.server.static_index.model_candidates})

    def test_delete_syntax_error_and_invalid_utf8_are_not_duplicate_hits(self):
        original = self.source.read_bytes()
        for invalid in [None, b'class invalid(\n', b'\xff\xfe']:
            with self.subTest(invalid=invalid):
                self.source.write_bytes(original)
                self.prime()
                if invalid is None:
                    self.source.unlink()
                else:
                    self.source.write_bytes(invalid)
                with mock.patch.object(self.server, '_schedule_runtime_member_refresh'), \
                        mock.patch.object(self.server, '_compute_reindex', wraps=self.server._compute_reindex) as compute:
                    self.reindex()
                self.assertTrue(compute.called)
                self.assertNotIn('models', self.server.static_index.modules)

    def test_helper_export_changes_and_intervening_file_commit_are_not_hidden(self):
        helper = self.root / 'helper.py'
        helper.write_text('old_export = 1\n')
        self.prime()
        with mock.patch.object(self.server, '_schedule_runtime_member_refresh'):
            self.reindex(helper)
            self.reindex()
        helper.write_text('new_export = 1\n')
        serial = self.server._reindex_serial
        with mock.patch.object(self.server, '_schedule_runtime_member_refresh'):
            self.assertEqual(self.reindex(helper), {'unchanged': True})
        self.assertGreater(self.server._reindex_serial, serial)
        self.assertEqual(self.server.static_index.modules['helper'].defined_symbols, {'new_export'})

    def test_only_verified_source_duplicates_report_source_unchanged(self):
        helper = self.root / 'helper.py'
        helper.write_text('old_export = 1\n')
        with mock.patch.object(self.server, '_schedule_runtime_member_refresh'):
            first = self.reindex(helper)
            self.assertEqual(first, {'unchanged': True})
            duplicate = self.reindex(helper)
            self.assertIs(duplicate.get('sourceUnchanged'), True)
            stamp = helper.stat()
            helper.write_text('new_export = 1\n')
            os.utime(helper, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
            changed = self.reindex(helper)
            self.assertEqual(changed, {'unchanged': True})
            self.assertEqual(self.server.static_index.modules['helper'].defined_symbols, {'new_export'})
            self.assertIs(self.reindex(helper).get('sourceUnchanged'), True)


if __name__ == '__main__':
    unittest.main()
