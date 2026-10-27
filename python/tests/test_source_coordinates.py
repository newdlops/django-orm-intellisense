"""Protocol positions keep UTF16 units through parsing, reindex and cache restore."""
import ast
import copy
import dataclasses
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from django_orm_intellisense.cache import store
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.features import orm_members
from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection, RuntimeModelSummary
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.static_index.class_members import SourceMemberDeclarations, class_declaration
from django_orm_intellisense.static_index.indexer import build_static_index, reindex_single_file


SOURCE = '''from django.db import models
prefix = "한😀"; exported: int = 3
class Target(models.Model):
    key = models.UUIDField(primary_key=True)
class Base(models.Model):
    marker = "한😀"; title: str = models.CharField(max_length=20); 다음 = models.IntegerField()
    marker2 = "é𝄞"; objects = models.Manager()
    def custom(self) -> str:
        return self.title
    class Meta:
        abstract = True
class Child(Base):
    marker = "한😀"; child = models.IntegerField()
'''


def expected_position(text, anchor):
    # Independent source oracle: count Unicode scalars, with two units for
    # non-BMP scalars; do not consult AST byte offsets or product converters.
    lines = text.replace('\r\n', '\n').replace('\r', '\n').split('\n')
    matches = [(number, line.index(anchor)) for number, line in enumerate(lines, 1) if anchor in line]
    assert len(matches) == 1, anchor
    number, offset = matches[0]
    return number, 1 + sum(2 if ord(value) > 0xffff else 1 for value in lines[number-1][:offset])


class SourceCoordinateTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='djls-source-coordinates-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve() / 'project'
        package = self.root / 'blog'
        package.mkdir(parents=True)
        (package / '__init__.py').write_text('')
        self.source = package / 'models.py'
        self.source.write_text(SOURCE)
        (package / 'derived.py').write_text('from django.db import models\nfrom .models import Base\nclass Imported(Base):\n'
            '    marker = "한😀"; inherited_child = models.IntegerField()\n')
        self.index = build_static_index(self.root)
        self.snapshot = snapshot_python_sources(self.root)
        patcher = mock.patch.object(store, '_workspace_cache_dir', return_value=self.root.parent / 'cache')
        patcher.start(); self.addCleanup(patcher.stop)
        self.addCleanup(orm_members._parse_class_node_cached.cache_clear)
        orm_members._parse_class_node_cached.cache_clear()

    def assert_field(self, index, label, name, text=SOURCE, anchor=None):
        field = index.find_field(label, name)
        self.assertIsNotNone(field)
        self.assertEqual((field.line, field.column), expected_position(text, anchor or name + ':'))
        return field

    def test_direct_fields_symbols_and_source_member_assignments_use_utf16(self):
        self.assert_field(self.index, 'blog.Child', 'title')
        self.assert_field(self.index, 'blog.Child', '다음', anchor='다음 =')
        self.assert_field(self.index, 'blog.Child', 'child', anchor='child =')
        module = self.index.modules['blog.models']
        exported = module.symbol_definitions['exported']
        self.assertEqual((exported.line, exported.column), expected_position(SOURCE, 'exported:'))
        declaration = module.source_member_declarations.classes['Base']
        manager = next(item for item in declaration.assignments if item.name == 'objects')
        self.assertEqual((manager.line, manager.column), expected_position(SOURCE, 'objects ='))
        method = next(item for item in declaration.functions if item.name == 'custom')
        self.assertEqual((method.line, method.column), expected_position(SOURCE, 'def custom'))

    def test_imported_inheritance_uses_the_same_source_units(self):
        text = (self.root / 'blog/derived.py').read_text()
        self.assert_field(self.index, 'blog.Imported', 'inherited_child', text, 'inherited_child =')
        self.assert_field(self.index, 'blog.Imported', 'title')

    def test_same_byte_size_reindex_keeps_the_old_snapshot_and_new_utf16_column(self):
        previous = self.index.find_field('blog.Child', 'child')
        stamp = self.source.stat()
        changed = SOURCE.replace('marker = "한😀"; child', 'marker = "한abcd"; child')
        self.assertEqual(len(SOURCE.encode()), len(changed.encode()))
        self.source.write_text(changed)
        os.utime(self.source, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        updated, old_labels, new_labels = reindex_single_file(self.root, self.source, self.index)
        self.assertEqual(old_labels, new_labels)
        self.assert_field(updated, 'blog.Child', 'child', changed, 'child =')
        self.assertEqual((previous.line, previous.column), expected_position(SOURCE, 'child ='))
        self.assertEqual(updated.find_field('blog.Child', 'child').column, previous.column + 2)

    def test_ast_fallback_matches_current_declarations_without_a_second_source_read(self):
        node = orm_members._parse_class_node(str(self.source), 'Base')
        with mock.patch.object(Path, 'read_text', side_effect=AssertionError('New source read')):
            declaration = class_declaration(node)
        self.assertEqual(declaration, self.index.modules['blog.models'].source_member_declarations.classes['Base'])
        manager = next(item for item in declaration.assignments if item.name == 'objects')
        self.assertEqual((manager.line, manager.column), expected_position(SOURCE, 'objects ='))

    def test_original_ast_offsets_segments_and_dump_remain_valid(self):
        for newline in ('\n', '\r\n', '\r'):
            for prefix in ('ascii', '한😀', 'é𝄞é', '\u2028한😀', '\t한😀'):
                text = ('class C:\n\tmarker = "' + prefix + '"; title = 4\n').replace('\n', newline)
                tree = ast.parse(text)
                dump = ast.dump(tree, include_attributes=True)
                node = tree.body[0].body[1]
                byte_column = node.col_offset
                declaration = SourceMemberDeclarations.from_source(tree, text).classes['C']
                value = next(item for item in declaration.assignments if item.name == 'title')
                with self.subTest(newline=repr(newline), prefix=prefix):
                    self.assertEqual((value.line, value.column), expected_position(text, 'title ='))
                    self.assertEqual(node.col_offset, byte_column)
                    self.assertEqual(ast.dump(tree, include_attributes=True), dump)
                    self.assertEqual(ast.get_source_segment(text, node), 'title = 4')
                    compile(tree, '<coordinate-test>', 'exec')

    def test_static_full_partial_dictionary_and_stream_restore_preserve_positions(self):
        store.save_static_index(self.root, self.snapshot, self.index)
        for threshold in (0, 1 << 50):
            with mock.patch.object(store, '_STATIC_MODULE_STREAM_MIN_BYTES', threshold):
                restored, hit = store.load_cached_static_index(self.root, self.snapshot)
                self.assertEqual(hit, 'full')
                self.assert_field(restored, 'blog.Child', 'title')
        directory = store._workspace_cache_dir(self.root)
        full = directory / store.STATIC_INDEX_FULL_CACHE_NAME
        wire = store._read_cache_payload(full)
        self.assertEqual(wire['metadata']['sourceCoordinatesVersion'], 'utf16-1based-v1')
        store._write_cache_payload(full, wire)
        self.assert_field(store.load_cached_static_index(self.root, self.snapshot)[0], 'blog.Child', 'title')
        full.unlink()
        restored, hit = store.load_cached_static_index(self.root, self.snapshot)
        self.assertEqual(hit, 'partial')
        self.assert_field(restored, 'blog.Child', 'title')

    def test_type_ignore_nodes_without_column_offsets_preserve_type_comment_ast(self):
        text = 'class C:\n    marker="한😀"; title=4  # type: ignore[assignment]\n'
        tree = ast.parse(text, type_comments=True)
        dump = ast.dump(tree, include_attributes=True)
        self.assertTrue(tree.type_ignores)
        declaration = SourceMemberDeclarations.from_source(tree, text).classes['C']
        title = next(value for value in declaration.assignments if value.name == 'title')
        self.assertEqual((title.line, title.column), expected_position(text, 'title='))
        self.assertEqual(ast.dump(tree, include_attributes=True), dump)

    def test_old_or_unknown_static_cache_unit_cannot_restore_even_unchanged_sources(self):
        store.save_static_index(self.root, self.snapshot, self.index)
        directory = store._workspace_cache_dir(self.root)
        original = {name:json.loads((directory/name).read_text()) for name in (store.STATIC_INDEX_CACHE_NAME, store.STATIC_INDEX_FULL_CACHE_NAME)}
        for version in (None, 'utf8-byte-1based-v0', 'future', 1):
            for name, payload in original.items():
                wire = copy.deepcopy(payload)
                if version is None:
                    wire['metadata'].pop('sourceCoordinatesVersion', None)
                else:
                    wire['metadata']['sourceCoordinatesVersion'] = version
                (directory/name).write_text(json.dumps(wire))
            with self.subTest(version=version):
                self.assertEqual(store.load_cached_static_index(self.root, self.snapshot), (None, 'miss'))

    def test_graph_cache_requires_units_with_and_without_static_owners(self):
        graph = build_model_graph(self.index, create_pending_runtime_inspection(None))
        store.save_model_graph(self.root, self.snapshot.fingerprint, 'runtime', graph)
        path = store._workspace_cache_dir(self.root) / store.MODEL_GRAPH_CACHE_NAME
        original = json.loads(path.read_text())
        for threshold in (0, 1 << 50):
            for owner in (None, self.index):
                with mock.patch.object(store, '_GRAPH_FIELDS_STREAM_MIN_BYTES', threshold):
                    restored = store.load_cached_model_graph(self.root, self.snapshot.fingerprint, 'runtime', static_index=owner)
                    value = restored.find_field('blog.Child', 'title')
                    self.assertEqual((value.line, value.column), expected_position(SOURCE, 'title:'))
        for version in (None, 'future'):
            wire = copy.deepcopy(original)
            if version is None:
                wire['metadata'].pop('sourceCoordinatesVersion', None)
            else:
                wire['metadata']['sourceCoordinatesVersion'] = version
            path.write_text(json.dumps(wire))
            self.assertIsNone(store.load_cached_model_graph(self.root, self.snapshot.fingerprint, 'runtime', static_index=self.index))

    def test_unaffected_source_and_runtime_snapshot_caches_remain_usable(self):
        runtime = dataclasses.replace(create_pending_runtime_inspection(None), bootstrap_status='ready')
        store.save_source_snapshot(self.root, self.snapshot)
        store.save_runtime_inspection(self.root, self.snapshot.fingerprint, None, runtime)
        restored = store.load_cached_source_snapshot(self.root)
        self.assertEqual(restored.to_cache_dict(), self.snapshot.to_cache_dict())
        self.assertEqual(store.load_cached_runtime_inspection(self.root, self.snapshot.fingerprint, None).to_cache_dict(), runtime.to_cache_dict())
        self.assertEqual(store.CACHE_SCHEMA_VERSION, 34)


class RuntimeMemberCoordinateCacheTests(unittest.TestCase):
    def test_catalog_rejects_old_units_while_base_surface_reader_remains_compatible(self):
        with tempfile.TemporaryDirectory(prefix='djls-member-coordinate-') as folder:
            root = Path(folder).resolve() / 'project'
            package = root / 'blog'
            package.mkdir(parents=True)
            (package / '__init__.py').write_text('')
            source = package / 'models.py'
            text = 'from django.db import models\nclass Post(models.Model):\n    marker="한😀"; title=models.CharField()\n'
            source.write_text(text)
            static = build_static_index(root)
            runtime = dataclasses.replace(create_pending_runtime_inspection('blog.settings'), bootstrap_status='ready', django_version='test')
            graph = build_model_graph(static, runtime)
            surface = orm_members.build_surface_index(static, runtime, graph)
            line, column = expected_position(text, 'title=')
            item = orm_members.OrmMemberItem(name='attached', member_kind='method', model_label='blog.Post',
                receiver_kind='instance', detail='메서드 😀', source='runtime', return_kind='instance',
                return_model_label='blog.Post', file_path=str(source), line=line, column=column,
                signature='attached(self, value: str = "한글") -> Post')
            model = RuntimeModelSummary('blog.Post', 'blog.models', [], [], [], [], [], ['objects'])
            catalog = orm_members.RuntimeMemberSnapshot(orm_members._runtime_member_identity(runtime),
                {('blog.Post','instance',None):(item,)}, {'blog.Post':('objects',)}, frozenset({'blog.Post'}),
                models={('blog.models','Post'):model})
            with mock.patch.object(store, '_workspace_cache_dir', return_value=Path(folder)/'cache'):
                store.save_surface_index(root, 'source', 'runtime', surface, runtime_members=catalog)
                path = store._workspace_cache_dir(root) / store.SURFACE_INDEX_CACHE_NAME
                wire = json.loads(path.read_text())
                kwargs = dict(static_index=static, model_graph=graph, runtime_inspection=runtime, with_runtime_members=True)
                restored = store.load_cached_surface_index(root, 'source', 'runtime', **kwargs)
                self.assertEqual(restored[2].items[('blog.Post','instance',None)][0].to_dict(), item.to_dict())
                for version in (None, 'future'):
                    changed = copy.deepcopy(wire)
                    if version is None:
                        changed['metadata'].pop('sourceCoordinatesVersion', None)
                    else:
                        changed['metadata']['sourceCoordinatesVersion'] = version
                    path.write_text(json.dumps(changed))
                    self.assertIsNone(store.load_cached_surface_index(root, 'source', 'runtime', **kwargs))
                    self.assertEqual(store.load_cached_surface_index(root, 'source', 'runtime'), surface)


if __name__ == '__main__':
    unittest.main()
