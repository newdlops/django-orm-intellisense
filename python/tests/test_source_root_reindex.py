"""Restored roots publish complete current sources once, or leave owners untouched."""
import dataclasses
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.server import app
from django_orm_intellisense.static_index.indexer import build_static_index


class SourceRootReindexTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='djls-root-reindex-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.root, self.external = self.base / 'project', self.base / 'external'
        self.root.mkdir()
        (self.external / 'ns').mkdir(parents=True)
        self.alias = self.base / 'alias'
        self.alias.symlink_to(self.external, target_is_directory=True)
        self.helper = self.external / 'ns/helper.py'
        self.helper.write_text('LIMIT = 20\n')
        self.source = self.external / 'ns/models.py'
        self.source.write_text('from django.db import models\nfrom ns.helper import LIMIT\n'
            'class Item(models.Model):\n    value=models.CharField(max_length=LIMIT)\n')
        (self.root / 'models.py').write_text('from django.db import models\n'
            'class Local(models.Model):\n    value=models.IntegerField()\n')
        self.imports = (str(self.alias), str(self.alias / 'ns'))
        self.server = self.make_server()

    def scan(self):
        return snapshot_python_sources(self.root, [self.alias])

    def build(self):
        return build_static_index(self.root, self.scan().files, import_roots=self.imports)

    def make_server(self):
        output = sys.stdout
        try:
            server = app.DaemonServer(self.root)
        finally:
            sys.stdout = output
        server.static_index = self.build()
        server.runtime_inspection = create_pending_runtime_inspection(None)
        server.model_graph = build_model_graph(server.static_index, server.runtime_inspection)
        server._source_root_aliases = ((str(self.root), str(self.root)),
            (str(self.alias), str(self.external)))
        server._editable_source_roots = (self.external,)
        return server

    def reindex(self, root=None):
        with mock.patch.object(self.server, '_schedule_runtime_member_refresh') as refresh:
            result = self.server._reindex_source_root({'filePath': str(root or self.external)})
        return result, refresh

    def assert_cold(self):
        cold = self.build()
        self.assertEqual(self.server.static_index.to_cache_dict(), cold.to_cache_dict())
        graph = build_model_graph(cold, self.server.runtime_inspection)
        actual = self.server.model_graph.fields_by_model_label
        self.assertEqual(actual.keys(), graph.fields_by_model_label.keys())
        for label, fields in graph.fields_by_model_label.items():
            self.assertEqual(actual[label].keys(), fields.keys())
            for name, field in fields.items():
                first, second = dataclasses.asdict(actual[label][name]), dataclasses.asdict(field)
                changed = {key for key in first if first[key] != second[key]}
                # Incremental graph fields retain the existing static_edit
                # origin until runtime refresh; every other field is exact.
                self.assertTrue(not changed or (changed == {'source'}
                    and first['source'] == 'static_edit' and second['source'] == 'static'),
                    (label, name, first, second))
        self.assertTrue(self.server.static_index._runtime_source_epoch.matches(self.scan()))
        self.assertEqual(self.server.static_index._source_import_roots, self.imports)

    def test_alias_root_restoration_is_one_complete_commit_in_same_server(self):
        parked = self.external.with_name('parked')
        self.external.rename(parked)
        self.server = self.make_server()
        parked.rename(self.external)
        for number in range(160):
            (self.external / 'ns' / ('helper_' + str(number) + '.py')).write_text('VALUE=1\n')
        serial = self.server._reindex_serial
        result, refresh = self.reindex(self.alias)
        self.assertNotIn('error', result)
        self.assertEqual(self.server._reindex_serial, serial + 1)
        refresh.assert_called_once_with()
        self.assert_cold()

    def test_multiple_helpers_models_and_package_collision_match_cold(self):
        self.helper.write_text('LIMIT=120\n')
        self.source.write_text(self.source.read_text().replace('CharField(max_length=LIMIT)', 'DateField()'))
        (self.external / 'ns/collision.py').write_text('VALUE=1\n')
        (self.external / 'ns/collision').mkdir()
        (self.external / 'ns/collision/__init__.py').write_text('VALUE=2\n')
        result, _ = self.reindex()
        self.assertNotIn('error', result)
        self.assert_cold()

    def test_unchanged_model_records_do_not_enter_root_delta(self):
        self.source.write_text(self.source.read_text().replace('CharField(max_length=LIMIT)', 'DateField()'))
        result, _ = self.reindex()
        self.assertNotIn('error', result)
        self.assertNotIn('models.Local', result.get('changedLabels', []))
        self.assertNotIn('models.Local', result.get('surfaceIndexDelta', {}))
        self.assertIn('ns.Item', result.get('surfaceIndexDelta', {}))
        self.assert_cold()

    def test_method_body_only_change_outside_returning_root_is_not_missed(self):
        local = self.root / 'models.py'
        local.write_text(local.read_text() + '    def custom(self):\n        return 1\n')
        self.server = self.make_server()
        local.write_text(local.read_text().replace('return 1', 'return 2'))
        result, _ = self.reindex()
        self.assertNotIn('error', result)
        self.assertIn('models.Local', result.get('surfaceIndexDelta', {}))
        self.assertNotIn('ns.Item', result.get('surfaceIndexDelta', {}))
        self.assert_cold()

    def test_missing_and_empty_declared_roots_reconcile_without_restart(self):
        parked = self.external.with_name('parked')
        self.external.rename(parked)
        result, _ = self.reindex()
        self.assertNotIn('error', result)
        self.assert_cold()
        self.external.mkdir()
        result, _ = self.reindex()
        self.assertNotIn('error', result)
        self.assert_cold()

    def test_outside_root_and_undeclared_child_do_not_change_state(self):
        for root in (self.base, self.external / 'ns'):
            with self.subTest(root=root):
                before, serial = self.server.static_index, self.server._reindex_serial
                result, refresh = self.reindex(root)
                self.assertIn('error', result)
                self.assertIs(self.server.static_index, before)
                self.assertEqual(self.server._reindex_serial, serial)
                refresh.assert_not_called()

    def directory_reindex(self, directory):
        with mock.patch.object(self.server, '_schedule_runtime_member_refresh') as refresh:
            result = self.server._reindex_source_directory({'filePath': str(directory)})
        return result, refresh

    def test_directory_rpc_restores_populated_owned_subtree_once(self):
        directory, parked = self.external / 'ns', self.base / 'parked-ns'
        directory.rename(parked)
        self.server = self.make_server()
        parked.rename(directory)
        serial = self.server._reindex_serial
        result, refresh = self.directory_reindex(self.alias / 'ns')
        self.assertNotIn('error', result)
        self.assertEqual(self.server._reindex_serial, serial + 1)
        refresh.assert_called_once_with()
        self.assert_cold()

    def test_directory_rpc_rejects_outside_parent_and_escaping_alias(self):
        outside = self.base / 'outside'
        outside.mkdir()
        escape = self.external / 'escape'
        escape.symlink_to(outside, target_is_directory=True)
        for directory in (self.base, outside, escape):
            with self.subTest(directory=directory):
                before, serial = self.server.static_index, self.server._reindex_serial
                result, refresh = self.directory_reindex(directory)
                self.assertIn('error', result)
                self.assertIs(self.server.static_index, before)
                self.assertEqual(self.server._reindex_serial, serial)
                refresh.assert_not_called()

    def test_directory_rpc_missing_and_source_change_fail_closed(self):
        directory, parked = self.external / 'ns', self.base / 'parked-ns'
        directory.rename(parked)
        self.assertNotIn('error', self.directory_reindex(directory)[0])
        self.assert_cold()
        parked.rename(directory)
        before = self.server.static_index
        compute = self.server._compute_reindex_from_static
        def changed(**kwargs):
            result = compute(**kwargs)
            self.helper.write_text('LIMIT=40\n')
            return result
        with mock.patch.object(self.server, '_compute_reindex_from_static', side_effect=changed):
            result, refresh = self.directory_reindex(directory)
        self.assertIn('error', result)
        self.assertIs(self.server.static_index, before)
        refresh.assert_not_called()
        self.assertNotIn('error', self.directory_reindex(directory)[0])
        self.assert_cold()

    def test_directory_rpc_superseded_commit_leaves_prior_owner_untouched(self):
        before = self.server.static_index
        compute = self.server._compute_reindex_from_static
        def changed(**kwargs):
            result = compute(**kwargs)
            self.server._reindex_serial += 1
            return result
        with mock.patch.object(self.server, '_compute_reindex_from_static', side_effect=changed), \
                mock.patch.object(self.server, '_commit_reindex', side_effect=AssertionError('stale directory commit')):
            result, refresh = self.directory_reindex(self.external / 'ns')
        self.assertIn('error', result)
        self.assertIs(self.server.static_index, before)
        refresh.assert_not_called()

    def test_retargeted_declared_alias_is_rejected(self):
        outside = self.base / 'outside'
        outside.mkdir()
        replacement = self.base / 'replacement'
        replacement.symlink_to(outside, target_is_directory=True)
        replacement.replace(self.alias)
        before = self.server.static_index
        result, refresh = self.reindex()
        self.assertIn('error', result)
        self.assertIs(self.server.static_index, before)
        refresh.assert_not_called()

    def test_same_mtime_source_change_rejects_then_current_retry_matches_cold(self):
        before, serial = self.server.static_index, self.server._reindex_serial
        compute = self.server._compute_reindex_from_static
        def changed(**kwargs):
            result = compute(**kwargs)
            stamp = self.helper.stat()
            self.helper.write_text('LIMIT = 30\n')
            os.utime(self.helper, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
            return result
        with mock.patch.object(self.server, '_compute_reindex_from_static', side_effect=changed):
            result, refresh = self.reindex()
        self.assertIn('error', result)
        self.assertIs(self.server.static_index, before)
        self.assertEqual(self.server._reindex_serial, serial)
        refresh.assert_not_called()
        self.assertNotIn('error', self.reindex()[0])
        self.assert_cold()

    def test_superseded_state_and_stop_never_commit_or_schedule(self):
        for key in ('generation', 'serial', 'static', 'runtime', 'graph', 'surface', 'aliases', 'workspace', 'stop'):
            with self.subTest(owner=key):
                self.server = self.make_server()
                compute = self.server._compute_reindex_from_static
                def changed(**kwargs):
                    result = compute(**kwargs)
                    if key == 'generation': self.server._state_generation += 1
                    elif key == 'serial': self.server._reindex_serial += 1
                    elif key == 'stop': self.server._stopping.set()
                    else:
                        name = {'static':'static_index', 'runtime':'runtime_inspection', 'graph':'model_graph',
                            'surface':'_last_surface_index', 'aliases':'_source_root_aliases', 'workspace':'workspace_root'}[key]
                        setattr(self.server, name, object())
                    return result
                with mock.patch.object(self.server, '_compute_reindex_from_static', side_effect=changed), \
                        mock.patch.object(self.server, '_commit_reindex', side_effect=AssertionError('stale commit')):
                    result, refresh = self.reindex()
                self.assertIn('error', result)
                refresh.assert_not_called()

    def test_hardlink_leaf_retarget_is_rejected_even_with_same_source_stat(self):
        first, second = self.base / 'first.py', self.base / 'second.py'
        first.write_text(self.source.read_text())
        os.link(first, second)
        self.source.unlink()
        self.source.symlink_to(first)
        self.server = self.make_server()
        before = self.server.static_index
        compute = self.server._compute_reindex_from_static
        def changed(**kwargs):
            result = compute(**kwargs)
            replacement = self.source.with_suffix('.next')
            replacement.symlink_to(second)
            replacement.replace(self.source)
            return result
        with mock.patch.object(self.server, '_compute_reindex_from_static', side_effect=changed):
            result, refresh = self.reindex()
        self.assertIn('error', result)
        self.assertIs(self.server.static_index, before)
        refresh.assert_not_called()
        self.assertNotIn('error', self.reindex()[0])
        self.assert_cold()

    def test_directory_aba_and_partial_scan_fail_closed(self):
        walk = app.os.walk
        error = PermissionError('controlled unreadable descendant')
        def partial(root, **kwargs):
            yield from walk(root, **kwargs)
            kwargs['onerror'](error)
        before = self.server.static_index
        with mock.patch.object(app.os, 'walk', side_effect=partial):
            with self.assertRaises(PermissionError) as caught:
                self.reindex()
        self.assertIs(caught.exception, error)
        self.assertIs(self.server.static_index, before)
        compute = self.server._compute_reindex_from_static
        def replaced(**kwargs):
            result = compute(**kwargs)
            parked = self.external.with_name('parked')
            self.external.rename(parked)
            self.external.mkdir()
            (parked / 'ns').rename(self.external / 'ns')
            return result
        with mock.patch.object(self.server, '_compute_reindex_from_static', side_effect=replaced):
            result, refresh = self.reindex()
        self.assertIn('error', result)
        self.assertIs(self.server.static_index, before)
        refresh.assert_not_called()

    def test_broken_leaf_and_syntax_failure_match_complete_cold_index(self):
        self.source.unlink()
        self.source.symlink_to(self.base / 'missing.py')
        self.helper.write_text('broken syntax %\n')
        self.assertNotIn('error', self.reindex()[0])
        self.assert_cold()
