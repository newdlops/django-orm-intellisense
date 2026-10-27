"""Source events keep a file link's declared module namespace and owner."""
import io
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


class SourceFileLinkTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='djls-source-file-links-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.root = self.base / 'workspace'
        package = self.root / 'blog'
        package.mkdir(parents=True)
        (package / '__init__.py').write_text('')
        self.target = self.base / 'external-model.txt'
        self.target.write_text('from django.db import models\nclass Post(models.Model):\n    value=models.CharField()\n')
        self.source = package / 'models.py'
        self.source.symlink_to(self.target)
        output = sys.stdout
        try:
            self.server = app.DaemonServer(self.root)
        finally:
            sys.stdout = output
        self.server._real_stdout = io.StringIO()
        self.addCleanup(self.server._cancel_runtime_member_refresh)
        self.install(build_static_index(self.root))
        self.server._source_root_aliases = ((str(self.root), str(self.root)),)

    def install(self, index):
        server = self.server
        server.static_index = index
        server.runtime_inspection = create_pending_runtime_inspection(None)
        server.model_graph = build_model_graph(index, server.runtime_inspection)
        server.workspace_profile = WorkspaceProfile(str(self.root), None, None, None, [])
        server.semantic_graph = build_semantic_graph(server.workspace_profile, index, server.runtime_inspection)
        server.health_snapshot = build_health_snapshot(workspace=server.workspace_profile,
            static_index=index, runtime=server.runtime_inspection, semantic_graph=server.semantic_graph,
            initialized_at=server.initialized_at)
        index._runtime_source_epoch = runtime_members.RuntimeSourceEpoch.from_snapshot(snapshot_python_sources(self.root))

    def reindex(self, source=None):
        with mock.patch.object(self.server, '_schedule_runtime_member_refresh'):
            return self.server._reindex_file({'filePath': str(source or self.source)})

    def assert_fresh(self):
        # Initialize builds from the complete current stat-bound inventory;
        # dangling links are absent from that inventory, as in a full restart.
        snapshot = snapshot_python_sources(self.root, max_workers=1)
        expected = build_static_index(self.root, snapshot.files)
        self.assertEqual(self.server.static_index.to_cache_dict(), expected.to_cache_dict())
        self.assertEqual(self.server.static_index.fields, expected.fields)

    def test_equal_size_restored_mtime_linked_edit_matches_the_entire_fresh_static_index(self):
        previous = self.server.static_index
        before = previous.to_cache_dict()
        stamp = self.target.stat()
        self.target.write_text(self.target.read_text().replace('CharField', 'DateField'))
        os.utime(self.target, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        self.assertNotIn('error', self.reindex())
        self.assertEqual(self.server.static_index.find_field('blog.Post', 'value').field_kind, 'DateField')
        self.assertEqual(self.server.static_index.modules['blog.models'].file_path, str(self.source))
        self.assert_fresh()
        self.assertEqual(previous.to_cache_dict(), before)

    def test_external_target_and_unrelated_files_do_not_gain_workspace_ownership(self):
        for source in (self.target, self.base / 'unrelated.py'):
            with self.subTest(source=source):
                self.assertEqual(self.reindex(source), {'error': 'file outside workspace'})

    def test_outside_file_alias_can_still_update_an_owned_regular_source(self):
        owned = self.root / 'owned.py'
        owned.write_text('value=1\n')
        alias = self.base / 'outside-alias.py'
        alias.symlink_to(owned)
        self.assertNotIn('error', self.reindex(alias))
        self.assertEqual(self.server.static_index.modules['owned'].file_path, str(owned))
        self.assertNotIn('outside-alias', self.server.static_index.modules)

    def test_retargeted_file_link_keeps_module_name_and_reads_the_new_target(self):
        replacement = self.base / 'replacement.txt'
        replacement.write_text(self.target.read_text().replace('CharField', 'IntegerField'))
        self.source.unlink()
        self.source.symlink_to(replacement)
        self.assertNotIn('error', self.reindex())
        self.assertEqual(self.server.static_index.find_field('blog.Post', 'value').field_kind, 'IntegerField')
        self.assert_fresh()
        self.assertIn('CharField', self.target.read_text())

    def test_two_file_link_namespaces_are_not_merged_by_their_shared_target(self):
        other = self.root / 'other.py'
        other.symlink_to(self.target)
        self.install(build_static_index(self.root))
        previous = self.server.static_index.modules['other']
        self.target.write_text(self.target.read_text().replace('CharField', 'DateField'))
        self.assertNotIn('error', self.reindex())
        self.assertEqual(self.server.static_index.modules['blog.models'].file_path, str(self.source))
        self.assertEqual(self.server.static_index.modules['other'].file_path, str(other))
        self.assertIs(self.server.static_index.modules['other'], previous)
        self.assertNotIn('error', self.reindex(other))
        self.assert_fresh()

    def test_missing_target_is_reported_as_the_logical_file_deletion(self):
        self.target.unlink()
        self.assertTrue(self.source.is_symlink())
        self.assertEqual(self.server._deleted_source_files({'filePath': str(self.source)}),
                         {'filePaths': [str(self.source)]})
        self.assertNotIn('error', self.reindex())
        self.assertIsNone(self.server.model_graph.node_for_model('blog.Post'))
        self.assert_fresh()

    def test_removing_only_the_link_does_not_delete_its_live_external_target(self):
        self.source.unlink()
        self.assertEqual(self.server._deleted_source_files({'filePath': str(self.source)}),
                         {'filePaths': [str(self.source)]})
        self.assertNotIn('error', self.reindex())
        self.assertTrue(self.target.is_file())
        self.assert_fresh()

    def test_parent_directory_alias_preserves_the_logical_leaf_name(self):
        alias = self.base / 'workspace-alias'
        alias.symlink_to(self.root, target_is_directory=True)
        self.target.write_text(self.target.read_text().replace('CharField', 'DateField'))
        self.assertNotIn('error', self.reindex(alias / 'blog/models.py'))
        self.assertEqual(self.server.static_index.modules['blog.models'].file_path, str(self.source))
        self.assert_fresh()

    @unittest.skipUnless(os.name == 'posix', 'POSIX symlink/.. order')
    def test_parent_traversal_is_resolved_before_preserving_the_file_link(self):
        inner = self.source.parent / 'inner'
        inner.mkdir()
        enter = self.base / 'enter'
        enter.symlink_to(inner, target_is_directory=True)
        self.target.write_text(self.target.read_text().replace('CharField', 'DateField'))
        self.assertNotIn('error', self.reindex(enter / '..' / 'models.py'))
        self.assertEqual(self.server.static_index.modules['blog.models'].file_path, str(self.source))
        self.assert_fresh()

    def test_link_chain_keeps_its_first_declared_filename(self):
        middle = self.base / 'middle.txt'
        middle.symlink_to(self.target)
        self.source.unlink()
        self.source.symlink_to(middle)
        self.target.write_text(self.target.read_text().replace('CharField', 'DateField'))
        self.assertNotIn('error', self.reindex())
        self.assert_fresh()

    def test_a_leaf_link_loop_can_revoke_its_old_module_without_resolving_forever(self):
        self.source.unlink()
        self.source.symlink_to(self.source.name)
        self.assertEqual(self.server._deleted_source_files({'filePath': str(self.source)}),
                         {'filePaths': [str(self.source)]})
        self.assertNotIn('error', self.reindex())
        self.assertIsNone(self.server.model_graph.node_for_model('blog.Post'))
        self.assertTrue(self.target.is_file())

    def test_configured_editable_file_link_is_accepted_only_while_its_root_is_owned(self):
        editable = self.base / 'editable'
        shared = editable / 'shared'
        shared.mkdir(parents=True)
        (shared / '__init__.py').write_text('')
        source = shared / 'models.py'
        source.symlink_to(self.target)
        snapshot = snapshot_python_sources(self.root, [editable], max_workers=1)
        self.install(build_static_index(self.root, snapshot.files, import_roots=(str(editable),)))
        self.server._editable_source_roots = (editable,)
        self.target.write_text(self.target.read_text().replace('CharField', 'DateField'))
        self.assertNotIn('error', self.reindex(source))
        self.assertEqual(self.server.static_index.modules['shared.models'].file_path, str(source))
        self.server._editable_source_roots = ()
        self.assertEqual(self.reindex(source), {'error': 'file outside workspace'})


if __name__ == '__main__':
    unittest.main()
