"""Current source caches release replaced ASTs and share a module parse."""
from __future__ import annotations

import gc
import tempfile
import threading
import unittest
import weakref
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from django_orm_intellisense.features import orm_members
from django_orm_intellisense.runtime import source_fields
from django_orm_intellisense.static_index.field_declarations import source_stat_key
from django_orm_intellisense.static_index import field_declarations


class SourceAstCacheTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary.name) / 'models.py'
        orm_members._parse_class_node_cached.cache_clear()
        source_fields._source_module.cache_clear()
        field_declarations._module_constants.cache_clear()

    def tearDown(self):
        orm_members._parse_class_node_cached.cache_clear()
        source_fields._source_module.cache_clear()
        field_declarations._module_constants.cache_clear()
        self.temporary.cleanup()

    def test_replaced_class_asts_are_released_while_returned_snapshots_stay_valid(self):
        references = []
        self.path.write_text('class Post:\n    value = 0\n')
        held = orm_members._parse_class_node(str(self.path), 'Post')
        for revision in range(1, 21):
            self.path.write_text(f'class Post:\n    value = {revision}\n')
            node = orm_members._parse_class_node(str(self.path), 'Post')
            self.assertEqual(node.body[0].value.value, revision)
            references.append(weakref.ref(node))
        del node
        gc.collect()
        self.assertTrue(all(reference() is None for reference in references[:-1]),
                        'Cache retains obsolete source revisions')
        self.assertEqual(held.body[0].value.value, 0)
        self.assertEqual(orm_members._parse_class_node(str(self.path), 'Post').body[0].value.value, 20)

    def test_classes_in_one_current_file_share_a_parse_and_deleted_classes_retire(self):
        self.path.write_text('class First:\n    value = 1\nclass Second:\n    value = 2\n')
        original_parse = orm_members.ast.parse
        with mock.patch.object(orm_members.ast, 'parse', wraps=original_parse) as parse:
            first = orm_members._parse_class_node(str(self.path), 'First')
            second = orm_members._parse_class_node(str(self.path), 'Second')
            self.assertEqual((first.body[0].value.value, second.body[0].value.value), (1, 2))
            self.assertEqual(parse.call_count, 1, 'Same source file was parsed once per class')
        self.path.write_text('class First:\n    value = 3\n')
        self.assertIsNone(orm_members._parse_class_node(str(self.path), 'Second'))
        self.assertEqual(orm_members._parse_class_node(str(self.path), 'First').body[0].value.value, 3)
        self.assertEqual(second.body[0].value.value, 2)

    def test_replaced_field_declaration_trees_are_released(self):
        references = []
        for revision in range(20):
            self.path.write_text(f'class Post:\n    value = {revision}\n')
            tree, contexts = source_fields._source_module(str(self.path), source_stat_key(self.path.stat()), 'models')
            self.assertEqual(tree.body[0].body[0].value.value, revision)
            references.append(weakref.ref(tree))
        del tree, contexts
        gc.collect()
        self.assertTrue(all(reference() is None for reference in references[:-1]),
                        'Field declaration cache retains obsolete source revisions')

    def test_replaced_imported_constants_release_old_expressions(self):
        references = []
        for revision in range(20):
            self.path.write_text(f'VALUE = {revision}\n')
            context = field_declarations._module_constants(str(self.path), source_stat_key(self.path.stat()), 'models', False)
            self.assertEqual(context.bindings['VALUE'].value, revision)
            references.append(weakref.ref(context.bindings['VALUE']))
        del context
        gc.collect()
        self.assertTrue(all(reference() is None for reference in references[:-1]),
                        'Constant cache retains obsolete expression snapshots')

    def test_delayed_old_parse_cannot_replace_a_newer_source_snapshot(self):
        self.path.write_text('class Post:\n    value = 1\n')
        captured = threading.Event()
        release = threading.Event()
        original_read = Path.read_text

        def held_read(path, *args, **kwargs):
            text = original_read(path, *args, **kwargs)
            if threading.current_thread().name.startswith('old-source'):
                captured.set()
                self.assertTrue(release.wait(5), 'Old parse was never released')
            return text

        with mock.patch.object(Path, 'read_text', held_read), ThreadPoolExecutor(max_workers=1, thread_name_prefix='old-source') as executor:
            delayed = executor.submit(orm_members._parse_class_node, str(self.path), 'Post')
            try:
                self.assertTrue(captured.wait(5), 'Old parse did not capture its source')
                self.path.write_text('class Post:\n    value = 2\n')
                newest = orm_members._parse_class_node(str(self.path), 'Post')
                self.assertEqual(newest.body[0].value.value, 2)
            finally:
                release.set()
            older = delayed.result(timeout=5)
        self.assertEqual(older.body[0].value.value, 1)
        with mock.patch.object(Path, 'read_text', side_effect=AssertionError('Newest source cache was displaced')):
            self.assertIs(orm_members._parse_class_node(str(self.path), 'Post'), newest)

    def test_parse_failure_releases_previous_tree_and_valid_source_recovers(self):
        self.path.write_text('class Post:\n    value = 1\n')
        node = orm_members._parse_class_node(str(self.path), 'Post')
        previous = weakref.ref(node)
        del node
        self.path.write_text('class Post:\n    invalid = (\n')
        self.assertIsNone(orm_members._parse_class_node(str(self.path), 'Post'))
        gc.collect()
        self.assertIsNone(previous())
        self.path.write_text('class Post:\n    value = 3\n')
        self.assertEqual(orm_members._parse_class_node(str(self.path), 'Post').body[0].value.value, 3)

    def test_deleted_source_releases_its_class_tree_and_recreation_is_current(self):
        self.path.write_text('class Post:\n    value = 1\n')
        node = orm_members._parse_class_node(str(self.path), 'Post')
        previous = weakref.ref(node)
        del node
        self.path.unlink()
        self.assertIsNone(orm_members._parse_class_node(str(self.path), 'Post'))
        gc.collect()
        self.assertIsNone(previous())
        self.path.write_text('class Post:\n    value = 2\n')
        self.assertEqual(orm_members._parse_class_node(str(self.path), 'Post').body[0].value.value, 2)

    def test_class_file_capacity_releases_evicted_trees_without_losing_source(self):
        self.path.write_text('class Post:\n    value = 0\n')
        node = orm_members._parse_class_node(str(self.path), 'Post')
        oldest = weakref.ref(node)
        del node
        for number in range(512):
            other = self.path.parent / f'model_{number}.py'
            other.write_text(f'class Post:\n    value = {number + 1}\n')
            self.assertEqual(orm_members._parse_class_node(str(other), 'Post').body[0].value.value, number + 1)
        gc.collect()
        self.assertIsNone(oldest(), 'Evicted source AST is retained')
        self.assertEqual(orm_members._parse_class_node(str(self.path), 'Post').body[0].value.value, 0)

    def test_keyword_and_positional_declarations_share_the_same_current_source(self):
        self.path.write_text('class Post:\n    value = 1\n')
        stamp = source_stat_key(self.path.stat())
        first = source_fields._source_module(str(self.path), stamp, 'models')
        with mock.patch.object(Path, 'read_text', side_effect=AssertionError('Equivalent arguments missed the cache')):
            keyword = source_fields._source_module(file_path=str(self.path), source_stamp=stamp, module_name='models')
        self.assertIs(keyword, first)


if __name__ == '__main__':
    unittest.main()
