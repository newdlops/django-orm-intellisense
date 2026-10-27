"""Editable namespace names retain their explicit import-root ownership."""
import dataclasses
import os
import pickle
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from django_orm_intellisense.cache import store
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.static_index.indexer import build_static_index, reindex_single_file

class EditableNamespaceImportTests(unittest.TestCase):

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='djls-namespace-regression-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.root = self.base / 'project'
        self.external = self.base / 'external'
        (self.root / 'app').mkdir(parents=True)
        (self.external / 'ns').mkdir(parents=True)
        (self.root / 'app/__init__.py').write_text('')
        (self.root / 'app/models.py').write_text('from django.db import models\nfrom ns.helper import MAX\nclass Item(models.Model):\n    value=models.CharField(max_length=MAX)\n')
        self.helper = self.external / 'ns/helper.py'
        self.helper.write_text('MAX=20\n')
        self.imports = (str(self.external),)
        self.cache = self.base / 'cache'
        self.context = mock.patch.dict(os.environ, {'DJANGO_ORM_INTELLISENSE_CACHE_DIR': str(self.cache)})
        self.context.start()
        self.addCleanup(self.context.stop)

    def scan(self):
        return snapshot_python_sources(self.root, [self.external])

    def build(self):
        return build_static_index(self.root, self.scan().files, import_roots=self.imports)

    def value(self, index):
        return {'index': index.to_cache_dict(), 'fields': [dataclasses.asdict(field) for field in index.fields]}

    def test_external_namespace_constants_resolve_without_executing_source(self):
        self.helper.write_text('MAX=20\nraise AssertionError("must not import")\n')
        index = self.build()
        field = index.find_field('app.Item', 'value')
        self.assertIn('ns.helper', index.modules)
        self.assertNotIn('helper', index.modules)
        self.assertEqual(dict(field.imported_constants)['ns.helper.MAX'], '20')
        self.assertNotIn('ns.helper', sys.modules)

    def test_legacy_namespaced_cache_is_rejected_then_full_cache_restores_import_owner(self):
        scan = self.scan()
        legacy = build_static_index(self.root, scan.files)
        store.save_static_index(self.root, scan, legacy)
        self.assertEqual(store.load_cached_static_index(self.root, scan, import_roots=self.imports), (None, 'miss'))
        fresh = self.build()
        store.save_static_index(self.root, scan, fresh)
        restored, hit = store.load_cached_static_index(self.root, scan, import_roots=self.imports)
        self.assertEqual(hit, 'full')
        self.assertEqual(self.value(restored), self.value(fresh))
        self.assertEqual(restored._source_import_roots, self.imports)
        self.assertEqual(store.load_cached_static_index(self.root, scan), (None, 'miss'))

    def test_same_mtime_namespace_helper_edit_partial_cache_and_reindex_equal_fresh(self):
        original = self.build()
        old = self.value(original)
        scan = self.scan()
        store.save_static_index(self.root, scan, original)
        stamp = self.helper.stat()
        self.helper.write_text('MAX=10\n')
        os.utime(self.helper, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        current, hit = store.load_cached_static_index(self.root, self.scan(), import_roots=self.imports)
        self.assertEqual(hit, 'partial')
        fresh = self.build()
        self.assertEqual(self.value(current), self.value(fresh))
        reindexed, _, _ = reindex_single_file(self.root, self.helper, original)
        self.assertEqual(self.value(reindexed), self.value(fresh))
        self.assertEqual(dict(reindexed.find_field('app.Item', 'value').imported_constants)['ns.helper.MAX'], '10')
        self.assertEqual(self.value(original), old)

    def test_import_owner_survives_pickle_and_new_namespace_file_reindex(self):
        original = self.build()
        for protocol in range(pickle.HIGHEST_PROTOCOL + 1):
            loaded = pickle.loads(pickle.dumps(original, protocol=protocol))
            self.assertEqual(loaded._source_import_roots, self.imports)
            added = self.external / 'ns/added.py'
            added.write_text('VALUE=10\n')
            current, _, _ = reindex_single_file(self.root, added, loaded)
            self.assertIn('ns.added', current.modules)
            self.assertEqual(current._source_import_roots, self.imports)
            self.assertEqual(self.value(current), self.value(self.build()))
            added.unlink()


    def assert_alias_origin(self, index, name, symbol, source, line):
        resolution = index.resolve_export_origin(name, symbol)
        self.assertTrue(resolution.resolved, (name, symbol, resolution))
        self.assertEqual(resolution.requested_module, name)
        self.assertEqual(resolution.origin_file_path, str(source))
        self.assertEqual(resolution.origin_line, line)
        module = index.resolve_module(name)
        self.assertTrue(module.resolved)
        self.assertEqual(module.file_path, str(source))

    def overlapping_roots(self, order):
        inner = str(self.external / 'ns')
        outer = str(self.external)
        return (inner, outer) if order == 'inner-first' else (outer, inner)

    def build_with_roots(self, roots):
        return build_static_index(self.root, self.scan().files, import_roots=roots)

    def test_overlapping_namespace_roots_resolve_both_source_views_without_duplicate_modules(self):
        self.helper.write_text('MAX=20\nraise AssertionError("static resolver must not execute")\n')
        for order in ('inner-first', 'outer-first'):
            with self.subTest(order=order):
                index = self.build_with_roots(self.overlapping_roots(order))
                physical = dict(index.modules)
                for name in ('helper', 'ns.helper'):
                    self.assert_alias_origin(index, name, 'MAX', self.helper, 1)
                self.assertEqual(index.modules, physical)
                self.assertEqual(len({m.file_path for m in index.modules.values()}), len(physical))
                self.assertNotIn('ns.helper', sys.modules)
                self.assertNotIn('helper', sys.modules)

    def test_namespace_view_create_rename_delete_does_not_keep_negative_or_retired_index_answers(self):
        for order in ('inner-first', 'outer-first'):
            with self.subTest(order=order):
                roots = self.overlapping_roots(order)
                original = self.build_with_roots(roots)
                child_name = 'nested_' + order.replace('-', '_')
                old_names = (child_name + '.marker', 'ns.' + child_name + '.marker')
                self.assertFalse(original.resolve_export_origin(old_names[1], 'marker').resolved)
                directory = self.external / 'ns' / child_name
                directory.mkdir()
                marker = directory / 'marker.py'
                marker.write_text('\n\ndef marker():\n    pass\n')
                created, _, _ = reindex_single_file(self.root, marker, original)
                for name in old_names:
                    self.assert_alias_origin(created, name, 'marker', marker, 3)
                self.assertFalse(original.resolve_export_origin(old_names[1], 'marker').resolved)
                self.assertEqual(self.value(created), self.value(self.build_with_roots(roots)))
                moved_name = 'moved_' + order.replace('-', '_')
                moved_names = (moved_name + '.marker', 'ns.' + moved_name + '.marker')
                moved_directory = directory.with_name(moved_name)
                directory.rename(moved_directory)
                moved = moved_directory / 'marker.py'
                removed, _, _ = reindex_single_file(self.root, marker, created)
                renamed, _, _ = reindex_single_file(self.root, moved, removed)
                for name in old_names:
                    self.assertFalse(renamed.resolve_export_origin(name, 'marker').resolved)
                for name in moved_names:
                    self.assert_alias_origin(renamed, name, 'marker', moved, 3)
                self.assertEqual(self.value(renamed), self.value(self.build_with_roots(roots)))
                moved.unlink()
                deleted, _, _ = reindex_single_file(self.root, moved, renamed)
                for name in moved_names:
                    self.assertFalse(deleted.resolve_export_origin(name, 'marker').resolved)
                self.assertEqual(self.value(deleted), self.value(self.build_with_roots(roots)))
                moved_directory.rmdir()

    def test_full_and_partial_namespace_cache_restore_both_views_and_exact_import_owner(self):
        for order in ('inner-first', 'outer-first'):
            with self.subTest(order=order):
                self.helper.write_text('MAX=20\n')
                roots = self.overlapping_roots(order)
                index = self.build_with_roots(roots)
                store.save_static_index(self.root, self.scan(), index)
                restored, hit = store.load_cached_static_index(self.root, self.scan(), import_roots=roots)
                self.assertEqual(hit, 'full')
                self.assertEqual(restored._source_import_roots, roots)
                for name in ('helper', 'ns.helper'):
                    self.assert_alias_origin(restored, name, 'MAX', self.helper, 1)
                stamp = self.helper.stat()
                self.helper.write_text('MAX=10\n')
                os.utime(self.helper, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
                partial, hit = store.load_cached_static_index(self.root, self.scan(), import_roots=roots)
                self.assertEqual(hit, 'partial')
                self.assertEqual(partial._source_import_roots, roots)
                for name in ('helper', 'ns.helper'):
                    self.assert_alias_origin(partial, name, 'MAX', self.helper, 1)
                self.assertEqual(self.value(partial), self.value(self.build_with_roots(roots)))

    def test_namespace_alias_keeps_real_shadow_source_for_each_declared_root_order(self):
        shadow = self.external / 'ns/ns/helper.py'
        shadow.parent.mkdir(parents=True)
        shadow.write_text('\nMAX=30\nraise AssertionError("must not execute")\n')
        for order in ('inner-first', 'outer-first'):
            with self.subTest(order=order):
                index = self.build_with_roots(self.overlapping_roots(order))
                self.assert_alias_origin(index, 'helper', 'MAX', self.helper, 1)
                expected = shadow if order == 'inner-first' else self.helper
                self.assert_alias_origin(index, 'ns.helper', 'MAX', expected, 2 if order == 'inner-first' else 1)
                self.assertFalse(index.resolve_module('../ns.helper').resolved)
                self.assertFalse(index.resolve_module('unowned.ns.helper').resolved)
