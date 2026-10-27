"""Source declarations keep complete legacy member semantics across epochs."""
import ast
import dataclasses
import gc
import gzip
import json
import os
import pickle
import tempfile
import threading
import unittest
import weakref
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from django_orm_intellisense.features import orm_members
from django_orm_intellisense.static_index import class_members
from django_orm_intellisense.static_index.class_members import SourceMemberDeclarations
from django_orm_intellisense.static_index.indexer import ModuleIndex, build_static_index, reindex_single_file


SOURCE = '''from django.db import models
from .queries import PostQuerySet, PostManager
class Post(models.Model):
    title = models.CharField(max_length=40)
    objects = PostQuerySet.as_manager()
    named: object = models.Manager.from_queryset(PostQuerySet)()
    custom = PostManager()
    @property
    def caption(self) -> str:
        return self.title
    @staticmethod
    def utility() -> "Post":
        return None
    @classmethod
    async def recent(cls) -> "models.QuerySet[Post]":
        return None
    def _private(self):
        pass
'''
QUERIES = '''from django.db import models
class PostQuerySet(models.QuerySet):
    def active(self) -> "PostQuerySet":
        return self
class ParentManager(models.Manager.from_queryset(PostQuerySet)):
    def available(self):
        return self.all()
class PostManager(ParentManager):
    pass
'''


class StaticMemberDeclarationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='djls-source-declarations-')
        self.root = Path(self.temporary.name).resolve()
        (self.root / 'blog').mkdir()
        (self.root / 'blog/__init__.py').write_text('')
        self.path = self.root / 'blog/models.py'
        self.path.write_text(SOURCE)
        (self.root / 'blog/queries.py').write_text(QUERIES)
        self.index = build_static_index(self.root)
        orm_members._parse_class_node_cached.cache_clear()
        orm_members._current_member_source_hash.cache_clear()

    def tearDown(self):
        orm_members._parse_class_node_cached.cache_clear()
        orm_members._current_member_source_hash.cache_clear()
        self.temporary.cleanup()

    def records(self, index=None):
        index = index or self.index
        candidate = index.find_model_candidate('blog.Post')
        return (
            orm_members._static_class_method_items(static_index=index, module_name='blog.models', class_name='Post',
                receiver_kind='instance', model_label='blog.Post', manager_name=None, default_return_kind='unknown'),
            orm_members._manager_binding_definitions(index, candidate),
            orm_members._queryset_class_reference_from_manager(static_index=index, module_name='blog.queries',
                class_name='PostManager', visited_classes=set()),
            orm_members._static_manager_method_items(static_index=index, model_label='blog.Post', manager_name='custom'),
            orm_members._static_queryset_method_items(static_index=index, model_label='blog.Post', manager_name='named'))

    def test_current_source_declarations_match_parser_without_reparsing(self):
        legacy = dataclasses.replace(self.index, modules={name: dataclasses.replace(module, source_member_declarations=None)
            for name, module in self.index.modules.items()})
        expected = self.records(legacy)
        with mock.patch.object(orm_members, '_parse_class_node', side_effect=AssertionError('Current declarations reparsed')):
            actual = self.records()
        self.assertEqual(actual, expected)
        self.assertEqual([item.name for item in actual[0]], ['caption', 'recent', 'utility'])
        self.assertEqual(actual[0][0].member_kind, 'property')
        self.assertEqual(actual[2], ('blog.queries', 'PostQuerySet'))
        self.assertEqual(set(actual[1]), {'objects', 'named', 'custom'})

    def test_json_pickle_and_legacy_or_malformed_cache_records_keep_full_members(self):
        expected = self.records()
        module = self.index.modules['blog.models']
        for restored in [ModuleIndex.from_dict(module.to_dict()),
                ModuleIndex.from_dict(json.loads(json.dumps(module.to_dict()))), pickle.loads(pickle.dumps(module))]:
            self.assertEqual(restored.source_member_declarations, module.source_member_declarations)
            index = dataclasses.replace(self.index, modules={**self.index.modules, 'blog.models': restored})
            self.assertEqual(self.records(index), expected)
        malformed = [None, {}, {'sourceHash': 'bad', 'classes': {}},
            {'sourceHash': module.source_member_declarations.source_hash, 'classes': {'Post': [[], [['x', 'abc', 1, 1]], []]}}]
        for value in malformed:
            payload = module.to_dict(); payload['sourceMemberDeclarations'] = value
            restored = ModuleIndex.from_dict(payload)
            self.assertIsNone(restored.source_member_declarations)
            self.assertEqual(self.records(dataclasses.replace(self.index,
                modules={**self.index.modules, 'blog.models': restored})), expected)

    def test_equal_size_restored_mtime_source_edits_reject_old_declarations(self):
        before = self.records()
        stamp = self.path.stat()
        changed = SOURCE.replace('caption', 'summary').replace('PostQuerySet.as_manager()', 'NextQuerySet.as_manager()')
        self.assertEqual(len(SOURCE), len(changed))
        self.path.write_text(changed)
        os.utime(self.path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        after = self.records()
        self.assertEqual([item.name for item in after[0]], ['recent', 'summary', 'utility'])
        self.assertEqual(after[1]['objects']['querysetClassName'], 'NextQuerySet')
        self.assertEqual(before[1]['objects']['querysetClassName'], 'PostQuerySet')
        self.path.unlink()
        self.assertEqual(self.records()[0:2], ([], {}))
        self.path.write_text(SOURCE)
        self.assertEqual(self.records(), before)

    def test_malformed_late_declarations_fall_back_to_complete_source_members(self):
        import copy
        module = self.index.modules['blog.models']
        valid = module.source_member_declarations.to_dict()
        expected = self.records()
        changes = [(0, 0, 3, None), (0, 0, 4, True),
                   (1, 0, 1, [None, None, None]), (1, 0, 3, False),
                   (2, 0, 1, 1), (2, 0, 2, ['untrusted'])]
        for part, record, position, value in changes:
            payload = copy.deepcopy(valid)
            # An earlier healthy class must not survive as a partial cache
            # result when a later class contains an invalid declaration.
            payload['classes'] = {'Earlier': [[], [], []], **payload['classes']}
            payload['classes']['Post'][part][record][position] = value
            with self.subTest(part=part, position=position):
                wire = module.to_dict(); wire['sourceMemberDeclarations'] = payload
                restored = ModuleIndex.from_dict(wire)
                self.assertIsNone(restored.source_member_declarations)
                restored_index = dataclasses.replace(self.index,
                    modules={**self.index.modules, 'blog.models': restored})
                self.assertEqual(self.records(restored_index), expected)

    def test_tuple_records_and_nonprimitive_callers_preserve_values_without_pooling_owners(self):
        declarations = self.index.modules['blog.models'].source_member_declarations
        payload = declarations.to_dict()
        for name, (functions, assignments, bases) in list(payload['classes'].items()):
            payload['classes'][name] = (tuple(tuple(value) for value in functions),
                tuple((name, tuple(call) if call is not None else None, line, column)
                      for name, call, line, column in assignments), tuple(tuple(value) for value in bases))
        self.assertEqual(SourceMemberDeclarations.from_dict(payload).to_dict(), declarations.to_dict())
        class Owner: pass
        class OwnedString(str): pass
        owner = Owner(); reference = weakref.ref(owner)
        owned = OwnedString('objects'); owned.owner = owner
        payload = {'sourceHash': 'a' * 32,
            'classes': {'Post': [[], [[owned, [owned, None, None], 1, 1]], []]}}
        pools = [class_members._shared_manager_call, class_members._shared_assignment]
        before = [pool.cache_info() for pool in pools]
        restored = SourceMemberDeclarations.from_dict(payload)
        self.assertIsNotNone(restored)
        self.assertEqual([pool.cache_info() for pool in pools], before)
        del owner, owned, payload, restored
        gc.collect(); self.assertIsNone(reference())

    def test_late_old_hash_read_does_not_displace_new_source_ownership(self):
        captured, release = threading.Event(), threading.Event()
        original = Path.read_text
        def held(path, *args, **kwargs):
            result = original(path, *args, **kwargs)
            if path == self.path and threading.current_thread().name.startswith('old-declaration'):
                captured.set()
                if not release.wait(5): raise AssertionError('Old declaration read was not released')
            return result
        with mock.patch.object(Path, 'read_text', held), ThreadPoolExecutor(max_workers=1, thread_name_prefix='old-declaration') as pool:
            older = pool.submit(self.records)
            try:
                self.assertTrue(captured.wait(5))
                self.path.write_text(SOURCE.replace('caption', 'summary'))
                latest = self.records()
                self.assertIn('summary', [item.name for item in latest[0]])
            finally:
                release.set()
            older.result(timeout=5)
        with mock.patch.object(Path, 'read_text', side_effect=AssertionError('Newest source snapshot displaced')):
            self.assertEqual(self.records(), latest)

    def test_symlink_retarget_and_function_only_reindex_keep_source_epoch(self):
        first, second = self.root / 'first.txt', self.root / 'second.txt'
        first.write_text(SOURCE); second.write_text(SOURCE.replace('caption', 'summary'))
        alias = self.root / 'alias.txt'; alias.symlink_to(first)
        module = dataclasses.replace(self.index.modules['blog.models'], file_path=str(alias))
        original = orm_members._current_class_declaration(module, str(alias), 'Post')
        self.assertEqual(original.functions[0].name, 'caption')
        alias.unlink(); alias.symlink_to(second)
        self.assertIsNone(orm_members._current_class_declaration(module, str(alias), 'Post'))
        fields = self.index.fields
        self.path.write_bytes(SOURCE.replace('caption', 'summary').replace('\n', '\r\n').encode())
        updated, _, _ = reindex_single_file(self.root, self.path, self.index)
        self.assertEqual(updated.fields, fields)
        with mock.patch.object(orm_members, '_parse_class_node', side_effect=AssertionError('CRLF declarations reparsed')):
            self.assertIn('summary', [item.name for item in self.records(updated)[0]])

    def test_declarations_release_asts_and_preserve_first_direct_class(self):
        source = 'class First:\n    def original(self): pass\nclass First:\n    def later(self): pass\nif True:\n    class Hidden: pass\n'
        tree = ast.parse(source); reference = weakref.ref(tree.body[0])
        declarations = SourceMemberDeclarations.from_source(tree, source)
        del tree; gc.collect()
        self.assertIsNone(reference())
        self.assertEqual(set(declarations.classes), {'First'})
        self.assertEqual([item.name for item in declarations.classes['First'].functions], ['original'])
        self.assertIsNone(orm_members._current_class_declaration(self.index.modules['blog.models'], str(self.path), 'Absent'))

    def test_shared_assignments_keep_each_modules_manager_resolution_and_locations(self):
        source = ('from django.db import models\nclass Selection(models.QuerySet): pass\n'
            'class Post(models.Model):\n    objects = Selection.as_manager()\n')
        for name in ['first', 'second', 'shifted']:
            package = self.root / name
            package.mkdir(); (package / '__init__.py').write_text('')
            (package / 'models.py').write_text(('\n' if name == 'shifted' else '') + source)
        index = build_static_index(self.root)
        modules = [index.modules[name + '.models'] for name in ['first', 'second', 'shifted']]
        assignments = [module.source_member_declarations.classes['Post'].assignments[0] for module in modules]
        self.assertIs(assignments[0], assignments[1])
        self.assertIsNot(assignments[0], assignments[2])
        self.assertEqual(assignments[2].line, assignments[0].line + 1)
        restored = ModuleIndex.from_dict(json.loads(json.dumps(modules[0].to_dict())))
        self.assertIs(restored.source_member_declarations.classes['Post'].assignments[0], assignments[0])
        restored_pair = pickle.loads(pickle.dumps(modules[:2]))
        self.assertIs(restored_pair[0].source_member_declarations.classes['Post'].assignments[0],
            restored_pair[1].source_member_declarations.classes['Post'].assignments[0])
        legacy = dataclasses.replace(index, modules={name: dataclasses.replace(module, source_member_declarations=None)
            for name, module in index.modules.items()})
        labels = ['first.Post', 'second.Post', 'shifted.Post']
        expected = [orm_members._manager_binding_definitions(legacy, legacy.find_model_candidate(label)) for label in labels]
        token = orm_members._static_manager_bindings.set({})
        try:
            with mock.patch.object(orm_members, '_parse_class_node', side_effect=AssertionError('Shared facts reparsed')):
                actual = [orm_members._manager_binding_definitions(index, index.find_model_candidate(label)) for label in labels]
        finally:
            orm_members._static_manager_bindings.reset(token)
        self.assertEqual(actual, expected)
        for name, value in zip(['first', 'second', 'shifted'], actual):
            self.assertEqual(value['objects']['querysetModule'], name + '.models')
            self.assertEqual(value['objects']['filePath'], str(self.root / name / 'models.py'))

    def test_shared_fact_pools_are_bounded_and_do_not_retain_nonprimitive_owners(self):
        pools = [class_members._shared_manager_call, class_members._shared_assignment]
        for pool in pools:
            pool.cache_clear(); self.addCleanup(pool.cache_clear)
        make_call, make_assignment = class_members.make_manager_call, class_members.make_assignment_declaration
        call = make_call('models.Manager', None, None)
        self.assertIs(make_assignment('objects', call, 1, 1), make_assignment('objects', call, 1, 1))
        for name, value, line in [('x' * 257, call, 1), ('objects', make_call('x' * 257, None, None), 1),
                ('objects', call, 2**31)]:
            first, second = make_assignment(name, value, line, 1), make_assignment(name, value, line, 1)
            self.assertEqual(first, second)
            self.assertIsNot(first, second)
        class Owner: pass
        class OwnedString(str): pass
        owner = Owner(); reference = weakref.ref(owner)
        name = OwnedString('objects'); name.owner = owner
        before = [pool.cache_info() for pool in pools]
        owned_call = make_call(name, None, None)
        owned_assignment = make_assignment(name, owned_call, 1, 1)
        self.assertEqual([pool.cache_info() for pool in pools], before)
        del owner, name, owned_call, owned_assignment
        gc.collect(); self.assertIsNone(reference())
        saved = None
        for number in range(1000):
            value = make_assignment('field' + str(number), make_call('Manager' + str(number), None, None), 1, 1)
            if number == 0: saved = value
        self.assertEqual([pool.cache_info().currsize for pool in pools], [256, 256])
        self.assertEqual(saved, make_assignment('field0', make_call('Manager0', None, None), 1, 1))


if __name__ == '__main__': unittest.main()
