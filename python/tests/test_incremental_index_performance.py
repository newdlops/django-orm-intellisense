"""Cache reuse must preserve field, inheritance and reverse-relation semantics."""
from __future__ import annotations

import sys
import dataclasses
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from django_orm_intellisense.static_index.indexer import StaticIndex, build_static_index, reindex_single_file
from django_orm_intellisense.semantic.graph import build_model_graph, rebuild_model_graph_for_labels
from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection, RuntimeModelSummary, RuntimeFieldSummary
from django_orm_intellisense.features.orm_members import build_surface_index
from django_orm_intellisense.features.orm_members import _workspace_files
from django_orm_intellisense.features.lookup_paths import resolve_lookup_path
from django_orm_intellisense.server.app import DaemonServer


class IncrementalFieldReuseTests(unittest.TestCase):
    def test_standalone_coverage_changes_do_not_read_unchanged_scalar_names(self):
        from django_orm_intellisense.static_index.indexer import FieldCandidate
        self.write('models.py', 'from django.db import models\nclass Post(models.Model):\n    title = models.CharField()\n    count = models.IntegerField()\n')
        original = self.index()
        original_fields = list(original.fields)
        path = self.write('other.py', 'from django.db import models\nclass Other(models.Model):\n    value = models.TextField()\n')
        get_attribute = FieldCandidate.__getattribute__
        def read(field, name):
            if name == 'name' and get_attribute(field, 'model_label') == 'blog.Post':
                raise AssertionError('Unchanged standalone scalar names scanned')
            return get_attribute(field, name)
        with mock.patch.object(FieldCandidate, '__getattribute__', read):
            added, _, _ = reindex_single_file(self.root, path, original)
            path.unlink()
            removed, _, _ = reindex_single_file(self.root, path, added)
        self.assertEqual(removed.fields, original_fields)
        self.assertEqual(removed._fields_by_model_and_name, self.index()._fields_by_model_and_name)
        self.assertIs(added._forward_field_groups['blog.Post'], original._forward_field_groups['blog.Post'])
        self.assertIs(removed._fields_by_model_label['blog.Post'], original._fields_by_model_label['blog.Post'])
        self.assertEqual(original.fields, original_fields)

    def test_general_field_partitions_match_fresh_inheritance_and_fk_lifecycle_order(self):
        source = ('from django.db import models\n'
                  'class Owner(models.Model):\n    title = models.CharField()\n'
                  'class Base(models.Model):\n    title = models.CharField()\n'
                  '    owner = models.ForeignKey(Owner, on_delete=models.CASCADE, related_name="%(class)s_rows")\n'
                  '    class Meta:\n        abstract = True\n'
                  'class Post(Base):\n    title = models.TextField()\n'
                  'class Empty(models.Model):\n    pass\n')
        path = self.write('models.py', source)
        original = self.index()
        current = StaticIndex.from_cache_dict(original.to_cache_dict())
        extra = self.write('extra.py', 'from .models import Base\nclass Child(Base):\n    count = models.IntegerField()\n')
        current, _, _ = reindex_single_file(self.root, extra, current)
        for text in (source.replace('related_name="%(class)s_rows"', 'related_name="%(class)s_entries"'),
                     source.replace('    title = models.TextField()', '    score = models.IntegerField()')):
            path.write_text(text)
            current, _, _ = reindex_single_file(self.root, path, current)
            fresh = self.index()
            self.assertEqual(current.fields, fresh.fields)
            self.assertEqual(current._fields_by_model_label, fresh._fields_by_model_label)
            self.assertEqual(current._fields_by_model_and_name, fresh._fields_by_model_and_name)
            self.assertEqual(current._forward_field_groups, fresh._forward_field_groups)
            self.assertEqual(current._reverse_fields, fresh._reverse_fields)
        extra.unlink()
        current, _, _ = reindex_single_file(self.root, extra, current)
        fresh = self.index()
        self.assertEqual(current.fields, fresh.fields)
        self.assertEqual(current._fields_by_model_label, fresh._fields_by_model_label)
        self.assertEqual(original.find_field('blog.Post', 'title').field_kind, 'TextField')

    def test_duplicate_labels_and_supplied_resolved_fields_preserve_exact_group_order(self):
        source = ('from django.db import models\nclass Item(models.Model):\n    value = models.CharField()\n'
                  '    class Meta:\n        app_label = "shared"\n')
        self.write('first.py', source)
        self.write('second.py', source.replace('CharField', 'IntegerField'))
        original = self.index()
        path = self.write('extra.py', 'from django.db import models\nclass Extra(models.Model):\n    value = models.TextField()\n')
        added, _, _ = reindex_single_file(self.root, path, original)
        fresh = self.index()
        # Incremental module insertion keeps the prior global order; a fresh
        # scan sorts file paths. Per-model contents and winners must match.
        self.assertEqual(added.fields[:len(original.fields)], original.fields)
        self.assertEqual(added._forward_field_groups, fresh._forward_field_groups)
        self.assertEqual(added._fields_by_model_label, fresh._fields_by_model_label)
        self.assertEqual(added._fields_by_model_and_name, fresh._fields_by_model_and_name)
        reverse = dataclasses.replace(added.find_field('shared.Item', 'value'),
            field_kind='reverse_ForeignKey', is_relation=True, relation_direction='reverse',
            related_model_label='blog.Extra', constructor_fingerprint=None)
        supplied_fields = [reverse, *reversed(added.fields)]
        restored = dataclasses.replace(added, _cached_fields=supplied_fields)
        self.assertEqual(restored.fields, supplied_fields)
        expected = {}
        for field in restored.fields:
            expected.setdefault(field.model_label, []).append(field)
        self.assertEqual(restored._fields_by_model_label, expected)
        self.assertEqual(restored._fields_by_model_and_name,
                         {(field.model_label, field.name): field for field in restored.fields})

    def test_cyclic_static_bases_and_cycle_removal_match_fresh_field_partitions(self):
        source = ('from django.db import models\n'
                  'class First(models.Model, Second):\n    one = models.CharField()\n'
                  'class Second(First):\n    two = models.IntegerField()\n')
        path = self.write('models.py', source)
        original = self.index()
        extra = self.write('zz_extra.py', 'from django.db import models\nclass Other(models.Model):\n    value = models.TextField()\n')
        added, _, _ = reindex_single_file(self.root, extra, original)
        fresh = self.index()
        self.assertEqual(added.fields, fresh.fields)
        self.assertEqual(added._forward_field_groups, fresh._forward_field_groups)
        self.assertEqual(added._fields_by_model_label, fresh._fields_by_model_label)
        path.write_text(source.replace('models.Model, Second', 'models.Model'))
        changed, _, _ = reindex_single_file(self.root, path, added)
        fresh = self.index()
        self.assertEqual(changed.fields, fresh.fields)
        self.assertEqual(changed._fields_by_model_and_name, fresh._fields_by_model_and_name)
        self.assertEqual(changed._reverse_fields, fresh._reverse_fields)

    def test_surface_build_reuses_static_manager_declarations_and_keeps_results_independent(self):
        from django_orm_intellisense.features.orm_members import (
            _manager_assignment_metadata, _manager_binding_definitions,
            _parse_class_node_cached, _with_runtime_source_paths)
        self.write('models.py', 'from django.db import models\n'
            'class PostQuerySet(models.QuerySet):\n    pass\n'
            'class Post(models.Model):\n    title = models.CharField()\n'
            '    objects = PostQuerySet.as_manager()\n')
        index = self.index()
        candidate = index.find_model_candidate('blog.Post')
        calls = []
        def metadata(value, module, static):
            calls.append(value)
            return _manager_assignment_metadata(value, module, static)
        @_with_runtime_source_paths
        def build():
            first = _manager_binding_definitions(index, candidate)
            expected = {name: dict(value) for name, value in first.items()}
            first['objects']['querysetClassName'] = 'ModifiedByCaller'
            second = _manager_binding_definitions(index, candidate)
            self.assertEqual(second, expected)
            third = _manager_binding_definitions(index, candidate)
            self.assertEqual(third, expected)
            return expected
        # Concurrent cold parser misses may allocate different AST objects
        # for one source stamp. Force that condition independently of timing.
        with mock.patch('django_orm_intellisense.features.orm_members._manager_assignment_metadata', metadata), \
             mock.patch('django_orm_intellisense.features.orm_members._parse_class_node_cached',
                        _parse_class_node_cached.__wrapped__):
            actual = build()
        self.assertEqual(len(calls), 2, 'Repeated receiver builds rescanned unchanged manager declarations')
        self.assertEqual(actual['objects']['querysetClassName'], 'PostQuerySet')
        self.assertEqual(actual, _manager_binding_definitions(index, candidate))
        calls.clear()
        with mock.patch('django_orm_intellisense.features.orm_members._manager_assignment_metadata', metadata):
            self.assertEqual(build(), actual)
        self.assertEqual(len(calls), 2, 'A new build reused prior transient declarations')

    def test_static_manager_declarations_refresh_after_same_mtime_source_changes(self):
        import os
        from django_orm_intellisense.features.orm_members import (
            _manager_binding_definitions, _with_runtime_source_paths)
        source = ('from django.db import models\nclass Post(models.Model):\n'
                  '    objects = AlphaQuerySet.as_manager()\n')
        path = self.write('models.py', source)
        index = self.index()
        candidate = index.find_model_candidate('blog.Post')
        initial_stat = path.stat()
        @_with_runtime_source_paths
        def build():
            before = _manager_binding_definitions(index, candidate)
            self.assertEqual(before['objects']['querysetClassName'], 'AlphaQuerySet')
            # Editors/tools can preserve mtime on replacement. Different size
            # and equal size replacements must both retire the parsed class.
            for name in ('VeryLongQuerySet', 'GammaQuerySet'):
                path.write_text(source.replace('AlphaQuerySet', name))
                os.utime(path, ns=(initial_stat.st_atime_ns, initial_stat.st_mtime_ns))
                after = _manager_binding_definitions(index, candidate)
                self.assertEqual(after['objects']['querysetClassName'], name)
            self.assertEqual(before['objects']['querysetClassName'], 'AlphaQuerySet')
            path.unlink()
            self.assertEqual(_manager_binding_definitions(index, candidate), {})
            path.write_text(source.replace('AlphaQuerySet', 'OmegaQuerySet'))
            self.assertEqual(_manager_binding_definitions(index, candidate)['objects']['querysetClassName'], 'OmegaQuerySet')
        build()

    def test_static_manager_parser_detects_symlink_retarget_with_matching_timestamps(self):
        import os
        from types import SimpleNamespace
        from django_orm_intellisense.features.orm_members import (
            _manager_binding_definitions, _with_runtime_source_paths)
        source = ('from django.db import models\nclass Post(models.Model):\n'
                  '    objects = AlphaQuerySet.as_manager()\n')
        path = self.write('models.py', source)
        index = self.index()
        first = self.root / 'first.txt'
        second = self.root / 'second.txt'
        first.write_text(source)
        second.write_text(source.replace('AlphaQuerySet', 'GammaQuerySet'))
        alias = self.root / 'model-alias.txt'
        alias.symlink_to(first)
        candidate = dataclasses.replace(index.find_model_candidate('blog.Post'), file_path=str(alias))
        stat = os.stat
        original_stamp = stat(first)
        def matched_stat(file_path, *args, **kwargs):
            actual = stat(file_path, *args, **kwargs)
            if str(file_path) == str(alias):
                return SimpleNamespace(st_mtime_ns=original_stamp.st_mtime_ns,
                    st_size=original_stamp.st_size, st_ctime_ns=original_stamp.st_ctime_ns,
                    st_dev=actual.st_dev, st_ino=actual.st_ino)
            return actual
        @_with_runtime_source_paths
        def build():
            before = _manager_binding_definitions(index, candidate)
            alias.unlink()
            alias.symlink_to(second)
            after = _manager_binding_definitions(index, candidate)
            self.assertEqual(before['objects']['querysetClassName'], 'AlphaQuerySet')
            self.assertEqual(after['objects']['querysetClassName'], 'GammaQuerySet')
        with mock.patch('django_orm_intellisense.features.orm_members.os.stat', matched_stat):
            build()

    def test_manager_declaration_reuse_separates_indexes_after_import_retarget(self):
        from django_orm_intellisense.features.orm_members import (
            _manager_binding_definitions, _with_runtime_source_paths)
        self.write('models.py', 'from django.db import models\nfrom .bindings import Q\n'
            'class Post(models.Model):\n    objects = Q.as_manager()\n'
            '    active: object = models.Manager.from_queryset(Q)()\n')
        bindings = self.write('bindings.py', 'from .first import FirstQuerySet as Q\n')
        self.write('first.py', 'class FirstQuerySet:\n    pass\n')
        self.write('second.py', 'class SecondQuerySet:\n    pass\n')
        original = self.index()
        candidate = original.find_model_candidate('blog.Post')
        @_with_runtime_source_paths
        def build():
            old = _manager_binding_definitions(original, candidate)
            self.assertEqual(old['objects']['querysetClassName'], 'FirstQuerySet')
            self.assertEqual(old['active']['querysetClassName'], 'FirstQuerySet')
            bindings.write_text('from .second import SecondQuerySet as Q\n')
            changed, _, _ = reindex_single_file(self.root, bindings, original)
            updated = _manager_binding_definitions(changed, changed.find_model_candidate('blog.Post'))
            self.assertEqual(updated['objects']['querysetModule'], 'blog.second')
            self.assertEqual(updated['active']['querysetClassName'], 'SecondQuerySet')
            self.assertEqual(_manager_binding_definitions(original, candidate), old)
            self.assertEqual(_manager_binding_definitions(changed, changed.find_model_candidate('blog.Post')), updated)
            return changed, updated
        changed, actual = build()
        self.assertEqual(actual, _manager_binding_definitions(changed, changed.find_model_candidate('blog.Post')))

    def test_manager_declaration_build_context_resets_and_isolates_threads(self):
        from collections import Counter
        from concurrent.futures import ThreadPoolExecutor
        import threading
        from django_orm_intellisense.features.orm_members import (
            _manager_assignment_metadata, _manager_binding_definitions,
            _static_manager_bindings, _with_runtime_source_paths)
        self.write('models.py', 'from django.db import models\nclass Post(models.Model):\n'
            '    title = models.CharField()\n    objects = models.Manager()\n')
        index = self.index()
        candidate = index.find_model_candidate('blog.Post')
        barrier = threading.Barrier(2)
        calls = []
        def metadata(value, module, static):
            calls.append(threading.get_ident())
            return _manager_assignment_metadata(value, module, static)
        @_with_runtime_source_paths
        def nested():
            return _manager_binding_definitions(index, candidate)
        @_with_runtime_source_paths
        def build():
            context = _static_manager_bindings.get()
            first = nested()
            self.assertIs(_static_manager_bindings.get(), context)
            barrier.wait(timeout=10)
            self.assertEqual(nested(), first)
            return context
        with mock.patch('django_orm_intellisense.features.orm_members._manager_assignment_metadata', metadata):
            with ThreadPoolExecutor(max_workers=2) as pool:
                first, second = list(pool.map(lambda _: build(), range(2)))
        self.assertIsNot(first, second)
        self.assertEqual(sorted(Counter(calls).values()), [2, 2])
        self.assertIsNone(_static_manager_bindings.get())
        @_with_runtime_source_paths
        def fail():
            nested()
            raise ValueError('abandoned manager build')
        with self.assertRaisesRegex(ValueError, 'abandoned manager build'):
            fail()
        self.assertIsNone(_static_manager_bindings.get())
        self.assertEqual(_manager_binding_definitions(index, candidate)['objects']['managerClassName'], 'Manager')

    def test_surface_build_shares_external_source_paths_across_receiver_kinds(self):
        from collections import Counter
        from django.db.models import QuerySet
        from django_orm_intellisense.features.orm_members import (
            _runtime_callable_member_items, _with_runtime_source_paths)
        files = frozenset({str(self.root / 'blog/models.py')})
        original_resolve = Path.resolve
        calls = []
        def resolve(path, *args, **kwargs):
            calls.append(str(path))
            return original_resolve(path, *args, **kwargs)

        @_with_runtime_source_paths
        def build():
            return [_runtime_callable_member_items(owner_classes=[QuerySet], workspace_files=files,
                    receiver_kind=kind, model_label='blog.Post', manager_name=None,
                    default_return_kind='queryset')
                    for kind in ('manager', 'queryset', 'related_manager')]

        with mock.patch.object(Path, 'resolve', resolve):
            actual = build()
        counts = Counter(calls)
        self.assertTrue(counts)
        self.assertTrue(all(count == 1 for count in counts.values()), counts)
        calls.clear()
        with mock.patch.object(Path, 'resolve', resolve):
            expected = build.__wrapped__()
        self.assertEqual(actual, expected)
        self.assertTrue(all(count == 3 for count in Counter(calls).values()))

    def test_surface_source_paths_reset_after_build_exception_and_symlink_retarget(self):
        from django_orm_intellisense.features.orm_members import (
            _runtime_callable_member_items, _runtime_source_paths, _with_runtime_source_paths)
        source = 'class Owner:\n    def value(self) -> int:\n        return 1\n'
        first = self.write('first.py', source)
        second = self.write('second.py', source)
        alias = self.root / 'blog/alias.py'
        alias.symlink_to(first)
        namespace = {}
        exec(compile(source, str(alias), 'exec'), namespace)
        owner = namespace['Owner']
        files = frozenset({str(first.resolve()), str(second.resolve())})

        @_with_runtime_source_paths
        def build(fail=False):
            items = _runtime_callable_member_items(owner_classes=[owner], workspace_files=files,
                receiver_kind='instance', model_label='blog.Post', manager_name=None,
                default_return_kind='unknown')
            if fail:
                raise ValueError('abandoned build')
            return items

        self.assertEqual(build()[0].file_path, str(first.resolve()))
        with self.assertRaisesRegex(ValueError, 'abandoned build'):
            build(fail=True)
        self.assertIsNone(_runtime_source_paths.get())
        alias.unlink()
        alias.symlink_to(second)
        self.assertEqual(build()[0].file_path, str(second.resolve()))
        alias.unlink()
        self.assertEqual(build(), [])

    def test_surface_source_path_reuse_keeps_membership_and_live_overrides_separate(self):
        from django_orm_intellisense.features.orm_members import (
            _runtime_callable_member_items, _with_runtime_source_paths)
        source = 'class Owner:\n    def value(self) -> int:\n        return 1\n'
        path = self.write('target.py', source)
        alias = self.root / 'blog/alias.py'
        alias.symlink_to(path)
        namespace = {}
        exec(compile(source, str(alias), 'exec'), namespace)
        owner = namespace['Owner']
        files = frozenset({str(path.resolve())})
        other_files = frozenset({str(self.root / 'blog/other.py')})

        def items(membership):
            return _runtime_callable_member_items(owner_classes=[owner], workspace_files=membership,
                receiver_kind='instance', model_label='blog.Post', manager_name=None,
                default_return_kind='unknown')

        @_with_runtime_source_paths
        def build():
            found = items(files)
            self.assertEqual(items(other_files), [])
            mutable = set(other_files)
            self.assertEqual(items(mutable), [])
            mutable.add(str(path.resolve()))
            self.assertEqual(items(mutable), found)
            saved = owner.value
            owner.value = None
            self.assertEqual(items(files), [])
            owner.value = saved
            self.assertEqual(items(files), found)
            return found

        self.assertEqual([item.name for item in build()], ['value'])

    def test_concurrent_surface_builds_keep_source_path_contexts_separate(self):
        from collections import Counter
        from concurrent.futures import ThreadPoolExecutor
        import threading
        from django.db.models import QuerySet
        from django_orm_intellisense.features.orm_members import (
            _runtime_callable_member_items, _runtime_source_paths, _with_runtime_source_paths)
        files = frozenset({str(self.root / 'blog/models.py')})
        barrier = threading.Barrier(2)
        lock = threading.Lock()
        calls = []
        original_resolve = Path.resolve
        def resolve(path, *args, **kwargs):
            with lock:
                calls.append((threading.get_ident(), str(path)))
            return original_resolve(path, *args, **kwargs)

        @_with_runtime_source_paths
        def build():
            barrier.wait(timeout=10)
            for kind in ('manager', 'queryset'):
                self.assertEqual(_runtime_callable_member_items(owner_classes=[QuerySet],
                    workspace_files=files, receiver_kind=kind, model_label='blog.Post',
                    manager_name=None, default_return_kind='queryset'), [])

        with mock.patch.object(Path, 'resolve', resolve), ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(build) for _ in range(2)]
            for future in futures:
                future.result(timeout=10)
        self.assertEqual(len({thread for thread, _ in calls}), 2)
        self.assertTrue(all(count == 1 for count in Counter(calls).values()))
        self.assertIsNone(_runtime_source_paths.get())

    def test_selected_runtime_members_match_complete_static_inspection_with_metaclass_and_overrides(self):
        import inspect
        from django.db.models import QuerySet
        from django_orm_intellisense.features.orm_members import _runtime_callable_member_items
        source = ('class LocalBase(QuerySet):\n'
                  '    def kept(self) -> "QuerySet":\n        return self\n'
                  '    def hidden(self):\n        return self\n'
                  '    @property\n    def total(self) -> int:\n        raise AssertionError("Property invoked")\n'
                  '    @classmethod\n    def named(cls) -> "QuerySet":\n        return cls\n'
                  '    @staticmethod\n    def scalar() -> int:\n        return 1\n'
                  'class ProjectMeta(type):\n'
                  '    @property\n    def report(cls) -> int:\n        raise AssertionError("Metaclass property invoked")\n'
                  '    def meta_method(cls) -> int:\n        return 2\n'
                  '    def __dir__(cls):\n        return [n for n in super().__dir__() if n != "scalar"] + ["report", "meta_method"]\n'
                  'class LocalQuery(LocalBase, metaclass=ProjectMeta):\n'
                  '    hidden = None\n    def kept(self) -> "QuerySet":\n        return self\n')
        path = self.write('querysets.py', source)
        namespace = {'QuerySet': QuerySet}
        exec(compile(source, str(path), 'exec'), namespace)
        cls = namespace['LocalQuery']
        args = dict(owner_classes=[cls], workspace_files=frozenset({str(path.resolve())}),
            receiver_kind='queryset', model_label='blog.Post', manager_name=None, default_return_kind='queryset')
        actual = _runtime_callable_member_items(**args)
        with mock.patch('django_orm_intellisense.features.orm_members._workspace_callable_members',
                        side_effect=lambda owner, resolver: inspect.getmembers_static(owner)):
            expected = _runtime_callable_member_items(**args)
        self.assertEqual(actual, expected)
        by_name = {item.name: item for item in actual}
        self.assertNotIn('hidden', by_name)
        self.assertNotIn('scalar', by_name)
        self.assertEqual(by_name['total'].member_kind, 'property')
        self.assertEqual(by_name['report'].member_kind, 'property')
        self.assertEqual(by_name['named'].return_kind, 'queryset')
        cls.hidden = namespace['LocalBase'].hidden
        restored = {item.name: item for item in _runtime_callable_member_items(**args)}
        self.assertIn('hidden', restored)
        before_line = restored['kept'].line
        del cls.kept
        inherited = {item.name: item for item in _runtime_callable_member_items(**args)}
        self.assertNotEqual(inherited['kept'].line, before_line)

    def test_dynamic_class_attribute_member_selection_retains_inspect_fallback(self):
        import inspect
        from types import DynamicClassAttribute
        from django_orm_intellisense.features.orm_members import _runtime_callable_member_items
        source = ('class Base:\n    @DynamicClassAttribute\n    def named(self):\n        return "dynamic"\n'
                  'class Child(Base):\n    def named(self) -> int:\n        return 1\n')
        path = self.write('dynamic.py', source)
        namespace = {'DynamicClassAttribute': DynamicClassAttribute}
        exec(compile(source, str(path), 'exec'), namespace)
        args = dict(owner_classes=[namespace['Child']], workspace_files=frozenset({str(path.resolve())}),
            receiver_kind='instance', model_label='blog.Post', manager_name=None, default_return_kind='unknown')
        actual = _runtime_callable_member_items(**args)
        with mock.patch('django_orm_intellisense.features.orm_members._workspace_callable_members',
                        side_effect=lambda owner, resolver: inspect.getmembers_static(owner)):
            expected = _runtime_callable_member_items(**args)
        self.assertEqual(actual, expected)
        self.assertEqual([item.name for item in actual], ['named'])

    def test_external_queryset_members_are_not_all_statically_inspected(self):
        from django.db.models import QuerySet
        from django_orm_intellisense.features.orm_members import _runtime_callable_member_items
        with mock.patch('django_orm_intellisense.features.orm_members.inspect.getmembers_static',
                        side_effect=AssertionError('Every external member inspected')):
            items = _runtime_callable_member_items(owner_classes=[QuerySet],
                workspace_files=frozenset({str(self.root / 'blog' / 'models.py')}),
                receiver_kind='queryset', model_label='blog.Post', manager_name=None,
                default_return_kind='queryset')
        self.assertEqual(items, [])

    def test_callable_candidate_reuse_detects_namespace_key_and_code_changes(self):
        from django_orm_intellisense.features.orm_members import (
            _runtime_callable_member_items, _with_runtime_source_paths)
        source = 'class Owner:\n    marker = None\n    def value(self) -> int:\n        return 1\n'
        path = self.write('selection.py', source)
        namespace = {}
        exec(compile(source, str(path), 'exec', dont_inherit=True), namespace)
        owner = namespace['Owner']
        files = frozenset({str(path.resolve())})
        def items():
            return _runtime_callable_member_items(owner_classes=[owner], workspace_files=files,
                receiver_kind='instance', model_label='blog.Post', manager_name=None,
                default_return_kind='unknown')
        extra = {}
        exec(compile('def fresh(self) -> str:\n    return "new"\n', str(path), 'exec', dont_inherit=True), extra)
        original_code = extra['fresh'].__code__
        external = {}
        exec(compile('def fresh(self) -> str:\n    return "external"\n', str(self.root / 'external.py'), 'exec', dont_inherit=True), external)
        @_with_runtime_source_paths
        def build():
            self.assertEqual([item.name for item in items()], ['value'])
            # Keep the namespace size unchanged while replacing a None-valued
            # name with a new function; identity checks also need key coverage.
            del owner.marker
            owner.fresh = extra['fresh']
            self.assertEqual([item.name for item in items()], ['fresh', 'value'])
            owner.fresh.__code__ = external['fresh'].__code__
            self.assertEqual([item.name for item in items()], ['value'])
            owner.fresh.__code__ = original_code
            self.assertEqual([item.name for item in items()], ['fresh', 'value'])
        build()

    def test_callable_candidate_guard_keeps_namespace_key_and_value_from_the_same_entry(self):
        from django_orm_intellisense.features import orm_members
        key, replacement_key = 'candidate', 'replacement'
        expected, wrong = object(), object()
        live = {key: wrong}
        snapshot = orm_members._CallableCandidateSnapshot((object,), ({key: expected},), (), frozenset())
        def interleaved_identity(previous, current):
            if previous is key and current is key:
                # The live namespace never matches the captured key/value pair:
                # its value is wrong before this switch, and its key afterward.
                live.clear()
                live[replacement_key] = expected
            return previous is current
        with mock.patch.object(orm_members, 'is_', interleaved_identity, create=True):
            self.assertFalse(snapshot.matches((object,), [live]))

    def test_callable_candidate_reuse_keeps_visibility_and_annotations_live(self):
        from django.db.models import QuerySet
        from django_orm_intellisense.features import orm_members
        source = ('class Meta(type):\n'
            '    def __dir__(cls):\n        return [name for name in super().__dir__() '
            'if visibility["show"] or name != "value"]\n'
            'class Owner(metaclass=Meta):\n    def value(self) -> int:\n        return 1\n')
        path = self.write('live_selection.py', source)
        namespace = {'visibility': {'show': True}}
        exec(compile(source, str(path), 'exec', dont_inherit=True), namespace)
        owner = namespace['Owner']
        files = frozenset({str(path.resolve())})
        def items():
            return orm_members._runtime_callable_member_items(owner_classes=[owner], workspace_files=files,
                receiver_kind='queryset', model_label='blog.Post', manager_name='published',
                default_return_kind='unknown')
        @orm_members._with_runtime_source_paths
        def build():
            first = items()[0]
            self.assertEqual(first.return_kind, 'unknown')
            owner.value.__annotations__['return'] = QuerySet
            second = items()[0]
            self.assertEqual((second.return_kind, second.return_model_label, second.manager_name),
                             ('queryset', 'blog.Post', 'published'))
            namespace['visibility']['show'] = False
            self.assertEqual(items(), [])
            namespace['visibility']['show'] = True
            self.assertEqual(items()[0], second)
        with mock.patch.object(orm_members, '_workspace_callable_candidate_names',
                wraps=orm_members._workspace_callable_candidate_names) as scan:
            build()
        self.assertEqual(scan.call_count, 1)
        self.assertIsNone(orm_members._runtime_callable_candidates.get())

    def test_callable_candidate_reuse_resets_after_failures_and_between_threads(self):
        from collections import Counter
        from concurrent.futures import ThreadPoolExecutor
        import threading
        from django.db.models import QuerySet
        from django_orm_intellisense.features import orm_members
        files = frozenset({str(self.root / 'blog' / 'models.py')})
        calls = []
        lock = threading.Lock()
        barrier = threading.Barrier(2)
        scan = orm_members._workspace_callable_candidate_names
        def recorded(*args):
            with lock:
                calls.append(threading.get_ident())
            return scan(*args)
        @orm_members._with_runtime_source_paths
        def build(concurrent=False, fail=False):
            if concurrent:
                barrier.wait(timeout=10)
            for kind in ('manager', 'queryset', 'related_manager'):
                self.assertEqual(orm_members._runtime_callable_member_items(owner_classes=[QuerySet],
                    workspace_files=files, receiver_kind=kind, model_label='blog.Post',
                    manager_name=None, default_return_kind='queryset'), [])
            if fail:
                raise ValueError('abandoned candidate scan')
        with mock.patch.object(orm_members, '_workspace_callable_candidate_names', recorded):
            with self.assertRaisesRegex(ValueError, 'abandoned candidate scan'):
                build(fail=True)
            self.assertIsNone(orm_members._runtime_callable_candidates.get())
            build()
            self.assertEqual(len(calls), 2)
            calls.clear()
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(build, concurrent=True) for _ in range(2)]
                for future in futures:
                    future.result(timeout=10)
        self.assertEqual(sorted(Counter(calls).values()), [1, 1])
        self.assertIsNone(orm_members._runtime_callable_candidates.get())

    def test_runtime_catalog_replacement_removes_old_graph_label_and_preserves_snapshot(self):
        self.write('models.py', 'from django.db import models\nclass Post(models.Model):\n    title = models.CharField()\n')
        index = self.index()
        summary = RuntimeModelSummary(label='old_db.Post', module='blog.models', field_names=['title'],
            relation_names=[], reverse_relation_names=[],
            fields=[RuntimeFieldSummary(name='title', field_kind='CharField', is_relation=False,
                related_model_label=None, direction=None)], relations=[], manager_names=['objects'])
        runtime = dataclasses.replace(create_pending_runtime_inspection(None),
            bootstrap_status='ready', model_catalog=[summary], model_count=1)
        graph = build_model_graph(index, runtime)
        new_runtime = dataclasses.replace(runtime, model_catalog=[dataclasses.replace(summary, label='new_db.Post')])
        rebuilt = rebuild_model_graph_for_labels(graph, old_static_index=index,
            static_index=index, runtime=new_runtime, affected_labels={'blog.Post'})
        fresh = build_model_graph(index, new_runtime)
        self.assertEqual(rebuilt.nodes_by_label, fresh.nodes_by_label)
        self.assertEqual(rebuilt.nodes_by_object_name, fresh.nodes_by_object_name)
        self.assertEqual(rebuilt.node_by_import_path, fresh.node_by_import_path)
        self.assertEqual(set(graph.nodes_by_label), {'old_db.Post'})

    def test_static_graph_label_join_reuses_unchanged_links_without_node_iteration(self):
        from django_orm_intellisense.features.orm_members import _build_static_to_graph_label_map
        source = 'from django.db import models\nclass Post(models.Model):\n    title = models.CharField(max_length=30)\n'
        path = self.write('models.py', source)
        index = self.index()
        runtime = create_pending_runtime_inspection(None)
        graph = build_model_graph(index, runtime)
        expected = _build_static_to_graph_label_map(index, graph)
        class NoNodeJoin(dict):
            def items(self):
                raise AssertionError('Unchanged graph nodes joined again')
        graph = dataclasses.replace(graph, nodes_by_label=NoNodeJoin(graph.nodes_by_label))
        object.__setattr__(graph, '_label_map_cache', (index._model_candidates_by_label, expected))
        self.assertIs(_build_static_to_graph_label_map(index, graph), expected)
        path.write_text(source.replace('max_length=30', 'max_length=10'))
        changed, _, _ = reindex_single_file(self.root, path, index)
        rebuilt = rebuild_model_graph_for_labels(graph, old_static_index=index,
            static_index=changed, runtime=runtime, affected_labels={'blog.Post'})
        self.assertIs(_build_static_to_graph_label_map(changed, rebuilt), expected)


    def test_runtime_catalog_input_list_mutation_does_not_change_published_membership(self):
        summary = RuntimeModelSummary(label='db.Post', module='blog.models', field_names=[],
            relation_names=[], reverse_relation_names=[], fields=[], relations=[], manager_names=['objects'])
        supplied = [summary]
        runtime = dataclasses.replace(create_pending_runtime_inspection(None), model_catalog=supplied)
        supplied.append(dataclasses.replace(summary, label='db.Other'))
        self.assertEqual(runtime.model_catalog, (summary,))
        replaced = dataclasses.replace(runtime, lookup_catalog={'types': {}})
        self.assertIs(replaced.model_catalog, runtime.model_catalog)
        restored = type(runtime).from_cache_dict(runtime.to_cache_dict())
        self.assertEqual(restored.model_catalog, runtime.model_catalog)

    def test_label_map_cache_refreshes_on_model_coverage_changes_and_cache_restoration(self):
        from django_orm_intellisense.features.orm_members import _build_static_to_graph_label_map
        path = self.write('models.py', 'from django.db import models\nclass Post(models.Model):\n    title = models.CharField()\n')
        summary = RuntimeModelSummary(label='db.Post', module='blog.models', field_names=['title'],
            relation_names=[], reverse_relation_names=[],
            fields=[RuntimeFieldSummary(name='title', field_kind='CharField', is_relation=False,
                related_model_label=None, direction=None)], relations=[], manager_names=['objects'])
        runtime = dataclasses.replace(create_pending_runtime_inspection(None),
            bootstrap_status='ready', model_catalog=[summary], model_count=1)
        index = self.index()
        graph = build_model_graph(index, runtime)
        previous_map = _build_static_to_graph_label_map(index, graph)
        other = self.write('other.py', 'from django.db import models\nclass Other(models.Model):\n    count = models.IntegerField()\n')
        added, old_labels, new_labels = reindex_single_file(self.root, other, index)
        added_graph = rebuild_model_graph_for_labels(graph, old_static_index=index,
            static_index=added, runtime=runtime, affected_labels=old_labels | new_labels)
        fresh = build_model_graph(added, runtime)
        self.assertEqual(added_graph.nodes_by_label, fresh.nodes_by_label)
        self.assertEqual(_build_static_to_graph_label_map(added, added_graph), {'blog.Post': 'db.Post'})
        restored = StaticIndex.from_cache_dict(added.to_cache_dict())
        restored_graph = build_model_graph(restored, runtime)
        self.assertEqual(_build_static_to_graph_label_map(restored, restored_graph), previous_map)
        path.unlink()
        deleted, old_labels, new_labels = reindex_single_file(self.root, path, added)
        deleted_graph = rebuild_model_graph_for_labels(added_graph, old_static_index=added,
            static_index=deleted, runtime=runtime, affected_labels=old_labels | new_labels)
        self.assertEqual(set(deleted_graph.nodes_by_label), {'blog.Other'})
        self.assertEqual(_build_static_to_graph_label_map(deleted, deleted_graph), {})
        self.assertEqual(previous_map, {'blog.Post': 'db.Post'})


    def test_scalar_graph_edits_reuse_runtime_label_maps_without_catalog_iteration(self):
        source = 'from django.db import models\nclass Post(models.Model):\n    title = models.CharField(max_length=30)\n'
        path = self.write('models.py', source)
        summary = RuntimeModelSummary(label='db.Post', module='blog.models', field_names=['title'],
            relation_names=[], reverse_relation_names=[],
            fields=[RuntimeFieldSummary(name='title', field_kind='CharField', is_relation=False,
                related_model_label=None, direction=None)], relations=[], manager_names=['objects'])
        class NoCatalogIteration(tuple):
            forbidden = False
            def __iter__(self):
                if self.forbidden:
                    raise AssertionError('Unchanged runtime catalog iterated')
                return super().__iter__()
        catalog = NoCatalogIteration((summary,))
        runtime = dataclasses.replace(create_pending_runtime_inspection(None),
            bootstrap_status='ready', model_catalog=catalog, model_count=1)
        index = self.index()
        graph = build_model_graph(index, runtime)
        catalog.forbidden = True
        for length in (10, 20):
            path.write_text(source.replace('max_length=30', f'max_length={length}'))
            changed, _, _ = reindex_single_file(self.root, path, index)
            graph = rebuild_model_graph_for_labels(graph, old_static_index=index,
                static_index=changed, runtime=runtime, affected_labels={'blog.Post'})
            self.assertEqual(set(graph.nodes_by_label), {'db.Post'})
            self.assertEqual(graph.unique_node_for_object_name('Post').label, 'db.Post')
            index = changed

    def test_scalar_saves_do_not_iterate_unrelated_forward_or_global_reverse_fields(self):
        source = 'from django.db import models\nclass Post(models.Model):\n    title = models.CharField(max_length=30)\n'
        path = self.write('models.py', source)
        self.write('other.py', 'from django.db import models\nclass Other(models.Model):\n'
            '    post = models.ForeignKey("blog.Post", on_delete=models.CASCADE)\n'
            '    value = models.IntegerField()\n')
        index = self.index()
        snapshot = list(index.fields)
        class NoFieldIteration(list):
            def __iter__(self):
                raise AssertionError('Unchanged fields iterated during scalar save')
        index.fields = NoFieldIteration(index.fields)
        index._fields_by_model_label['blog.Other'] = NoFieldIteration(index._fields_by_model_label['blog.Other'])
        for length in (10, 20):
            path.write_text(source.replace('max_length=30', f'max_length={length}'))
            changed, _, _ = reindex_single_file(self.root, path, index)
            self.assertEqual(changed.fields, self.index().fields)
            self.assertIs(changed.find_field('blog.Other', 'post'), index.find_field('blog.Other', 'post'))
            self.assertEqual(list(index.fields[:]), snapshot)
            snapshot = list(changed.fields)
            changed.fields = NoFieldIteration(changed.fields)
            index = changed

    def test_restored_partition_reuse_covers_add_type_change_and_last_field_removal(self):
        path = self.write('models.py', 'from django.db import models\nclass Post(models.Model):\n    title = models.CharField(max_length=30)\n')
        self.write('other.py', 'from django.db import models\nclass Other(models.Model):\n    value = models.IntegerField()\n')
        index = StaticIndex.from_cache_dict(self.index().to_cache_dict())
        unchanged = index.find_field('blog.Other', 'value')
        sources = [
            'from django.db import models\nclass Post(models.Model):\n    title = models.CharField(max_length=30)\n    count = models.IntegerField()\n',
            'from django.db import models\nclass Post(models.Model):\n    title = models.DateField()\n    count = models.IntegerField()\n',
            'from django.db import models\nclass Post(models.Model):\n    pass\n',
        ]
        for source in sources:
            with self.subTest(source=source):
                snapshot = list(index.fields)
                path.write_text(source)
                changed, _, _ = reindex_single_file(self.root, path, index)
                fresh = self.index()
                self.assertEqual(changed.fields, fresh.fields)
                self.assertEqual(changed._fields_by_model_and_name, fresh._fields_by_model_and_name)
                self.assertIs(changed.find_field('blog.Other', 'value'), unchanged)
                self.assertEqual(index.fields, snapshot)
                index = changed

    def test_relation_retarget_refreshes_reverse_partition_before_next_scalar_save(self):
        self.write('targets.py', 'from django.db import models\nclass Author(models.Model):\n    name = models.CharField()\n'
            'class Reviewer(models.Model):\n    name = models.CharField()\n')
        source = ('from django.db import models\nclass Post(models.Model):\n'
                  '    target = models.ForeignKey("blog.Author", on_delete=models.CASCADE, related_name="posts")\n'
                  '    title = models.CharField(max_length=30)\n')
        path = self.write('models.py', source)
        original = self.index()
        path.write_text(source.replace('blog.Author', 'blog.Reviewer'))
        retargeted, _, _ = reindex_single_file(self.root, path, original)
        self.assertIsNone(retargeted.find_field('blog.Author', 'posts'))
        self.assertIsNotNone(retargeted.find_field('blog.Reviewer', 'posts'))
        path.write_text(path.read_text().replace('max_length=30', 'max_length=10'))
        saved, _, _ = reindex_single_file(self.root, path, retargeted)
        self.assertEqual(saved.fields, self.index().fields)
        self.assertIsNone(saved.find_field('blog.Author', 'posts'))
        self.assertIs(saved.find_field('blog.Reviewer', 'posts'), retargeted.find_field('blog.Reviewer', 'posts'))
        self.assertIsNotNone(original.find_field('blog.Author', 'posts'))

    def test_duplicate_model_labels_preserve_both_source_declarations_on_scalar_save(self):
        source = ('from django.db import models\nclass Item(models.Model):\n    value = models.CharField(max_length=30)\n'
                  '    class Meta:\n        app_label = "shared"\n')
        path = self.write('first.py', source)
        self.write('second.py', source)
        original = self.index()
        path.write_text(source.replace('max_length=30', 'max_length=10'))
        changed, _, _ = reindex_single_file(self.root, path, original)
        fresh = self.index()
        self.assertEqual(changed.fields, fresh.fields)
        self.assertEqual(changed._fields_by_model_and_name, fresh._fields_by_model_and_name)
        self.assertEqual(len(changed.fields), len(original.fields))

    def test_runtime_label_split_reindex_does_not_create_a_duplicate_static_graph_node(self):
        path = self.write('models.py', 'from django.db import models\nclass Post(models.Model):\n    title = models.CharField()\n')
        original = self.index()
        summary = RuntimeModelSummary(label='db.Post', module='blog.models', field_names=['title'],
            relation_names=[], reverse_relation_names=[],
            fields=[RuntimeFieldSummary(name='title', field_kind='CharField', is_relation=False,
                related_model_label=None, direction=None)], relations=[], manager_names=['objects'])
        runtime = dataclasses.replace(create_pending_runtime_inspection(None),
            bootstrap_status='ready', model_catalog=[summary], model_count=1)
        graph = build_model_graph(original, runtime)
        path.write_text(path.read_text() + '    count = models.IntegerField()\n')
        changed, _, _ = reindex_single_file(self.root, path, original)
        rebuilt = rebuild_model_graph_for_labels(graph, old_static_index=original,
            static_index=changed, runtime=runtime, affected_labels={'blog.Post'})
        fresh = build_model_graph(changed, runtime)
        self.assertEqual(rebuilt.nodes_by_label, fresh.nodes_by_label)
        self.assertEqual(rebuilt.nodes_by_object_name, fresh.nodes_by_object_name)
        self.assertEqual(rebuilt.node_by_import_path, fresh.node_by_import_path)
        self.assertEqual(rebuilt.unique_node_for_object_name('Post').label, 'db.Post')
        self.assertEqual(set(graph.nodes_by_label), {'db.Post'})

        duplicate = dataclasses.replace(graph.nodes_by_label['db.Post'], label='blog.Post')
        legacy = dataclasses.replace(graph, nodes_by_label={**graph.nodes_by_label, 'blog.Post': duplicate},
            nodes_by_object_name={'Post': (duplicate, graph.nodes_by_label['db.Post'])},
            node_by_import_path={'blog.models.Post': duplicate})
        repaired = rebuild_model_graph_for_labels(legacy, old_static_index=original,
            static_index=changed, runtime=runtime, affected_labels={'blog.Post'})
        self.assertEqual(repaired.nodes_by_label, fresh.nodes_by_label)
        self.assertEqual(repaired.nodes_by_object_name, fresh.nodes_by_object_name)
        self.assertEqual(repaired.node_by_import_path, fresh.node_by_import_path)
        self.assertEqual(set(legacy.nodes_by_label), {'db.Post', 'blog.Post'})

    def test_import_path_collision_retains_full_dictionary_order_winner(self):
        from django_orm_intellisense.features.orm_members import _build_static_to_graph_label_map
        self.write('models.py', 'from django.db import models\nclass Post(models.Model):\n    title = models.CharField()\n')
        index = self.index()
        first = RuntimeModelSummary(label='first.Post', module='blog.models', field_names=['title'],
            relation_names=[], reverse_relation_names=[],
            fields=[RuntimeFieldSummary(name='title', field_kind='CharField', is_relation=False,
                related_model_label=None, direction=None)], relations=[], manager_names=['objects'])
        second = dataclasses.replace(first, label='second.Post')
        runtime = dataclasses.replace(create_pending_runtime_inspection(None),
            bootstrap_status='ready', model_catalog=[first, second], model_count=2)
        graph = build_model_graph(index, runtime)
        self.assertEqual(_build_static_to_graph_label_map(index, graph), {'blog.Post': 'first.Post'})
        self.assertEqual(graph.node_by_import_path['blog.models.Post'].label, 'second.Post')
        rebuilt = rebuild_model_graph_for_labels(graph, old_static_index=index,
            static_index=index, runtime=runtime, affected_labels={'first.Post'})
        expected = {node.import_path: node for node in rebuilt.nodes_by_label.values() if node.import_path}
        self.assertEqual(rebuilt.node_by_import_path, expected)
        self.assertEqual(rebuilt.node_by_import_path['blog.models.Post'].label, 'first.Post')
        self.assertEqual(_build_static_to_graph_label_map(index, rebuilt), {'blog.Post': 'second.Post'})
        self.assertEqual([node.label for node in rebuilt.nodes_by_object_name['Post']], ['first.Post', 'second.Post'])
        self.assertEqual(graph.node_by_import_path['blog.models.Post'].label, 'second.Post')

    def test_scalar_save_does_not_inspect_unrelated_surface_fields_for_fallback(self):
        path = self.write('models.py', 'from django.db import models\nclass Post(models.Model):\n    title = models.CharField()\n')
        self.write('other.py', 'from django.db import models\nclass Other(models.Model):\n    value = models.IntegerField()\n')
        original = self.index()
        runtime = create_pending_runtime_inspection(None)
        graph = build_model_graph(original, runtime)
        surface = build_surface_index(static_index=original, runtime=runtime, model_graph=graph)
        class UnrelatedSurface(dict):
            def get(self, *args):
                raise AssertionError('Unrelated surface inspected for fallback')
        surface['blog.Other'] = UnrelatedSurface(surface['blog.Other'])
        stdout = sys.stdout
        try:
            server = DaemonServer(self.root)
        finally:
            sys.stdout = stdout
        path.write_text(path.read_text() + '    count = models.IntegerField()\n')
        outcome = server._compute_reindex(file_path=path, static_index=original, runtime=runtime,
            previous_model_graph=graph, existing_surface=surface, previous_static_fallback=None)
        self.assertIs(outcome.surface_index['blog.Other'], surface['blog.Other'])
        self.assertNotIn('blog.Other', outcome.static_fallback_delta)
        self.assertIn('count', outcome.surface_index_delta['blog.Post']['instance'])

    def test_scalar_graph_rebuild_updates_only_changed_name_and_import_indexes(self):
        path = self.write('models.py', 'from django.db import models\nclass Post(models.Model):\n    title = models.CharField()\n')
        self.write('other.py', 'from django.db import models\nclass Other(models.Model):\n    value = models.IntegerField()\n')
        original = self.index()
        runtime = create_pending_runtime_inspection(None)
        graph = build_model_graph(original, runtime)
        path.write_text(path.read_text() + '    count = models.IntegerField()\n')
        changed, _, _ = reindex_single_file(self.root, path, original)
        with mock.patch('django_orm_intellisense.semantic.graph._index_nodes_by_object_name',
                        side_effect=AssertionError('Unrelated model names reindexed')):
            rebuilt = rebuild_model_graph_for_labels(graph, old_static_index=original,
                static_index=changed, runtime=runtime, affected_labels={'blog.Post'})
        fresh = build_model_graph(changed, runtime)
        self.assertEqual(rebuilt.nodes_by_object_name, fresh.nodes_by_object_name)
        self.assertEqual(rebuilt.node_by_import_path, fresh.node_by_import_path)
        self.assertIs(rebuilt.nodes_by_object_name['Other'], graph.nodes_by_object_name['Other'])
        self.assertIs(rebuilt.node_by_import_path['blog.other.Other'], graph.node_by_import_path['blog.other.Other'])
        self.assertNotIn('count', graph.unique_node_for_object_name('Post').field_names)
        self.assertIn('count', rebuilt.unique_node_for_object_name('Post').field_names)

    def test_graph_name_indexes_preserve_ambiguity_rename_create_and_delete(self):
        self.write('models.py', 'from django.db import models\nclass Post(models.Model):\n    title = models.CharField()\n')
        folder = self.root / 'other'
        folder.mkdir()
        (folder / '__init__.py').write_text('')
        path = folder / 'models.py'
        runtime = create_pending_runtime_inspection(None)
        index = self.index()
        graph = build_model_graph(index, runtime)
        sources = ['from django.db import models\nclass Post(models.Model):\n    value = models.IntegerField()\n',
                   'from django.db import models\nclass Article(models.Model):\n    value = models.IntegerField()\n', None]
        for source in sources:
            with self.subTest(source=source):
                if source is None:
                    path.unlink()
                else:
                    path.write_text(source)
                changed, old_labels, new_labels = reindex_single_file(self.root, path, index)
                rebuilt = rebuild_model_graph_for_labels(graph, old_static_index=index,
                    static_index=changed, runtime=runtime, affected_labels=old_labels | new_labels)
                fresh = build_model_graph(changed, runtime)
                self.assertEqual(rebuilt.nodes_by_object_name, fresh.nodes_by_object_name)
                self.assertEqual(rebuilt.node_by_import_path, fresh.node_by_import_path)
                self.assertEqual(rebuilt.unique_node_for_object_name('Post'), fresh.unique_node_for_object_name('Post'))
                self.assertEqual(graph.nodes_by_object_name, build_model_graph(index, runtime).nodes_by_object_name)
                index, graph = changed, rebuilt

    def test_unchanged_local_field_module_is_not_reclassified_on_model_coverage_change(self):
        self.write('models.py', 'from django.db import models\nclass Target(models.Model):\n    name = models.CharField()\nclass Post(models.Model):\n    title = models.CharField()\n    target = models.ForeignKey("blog.Target", on_delete=models.CASCADE)\n')
        original = self.index()
        class NoFieldScan(list):
            def __iter__(self):
                raise AssertionError('Unchanged local field declarations rescanned')
        original.modules['blog.models'] = dataclasses.replace(original.modules['blog.models'],
            pending_fields=NoFieldScan(original.modules['blog.models'].pending_fields))
        path = self.write('other.py', 'from django.db import models\nclass Other(models.Model):\n    value = models.IntegerField()\n')
        added, _, _ = reindex_single_file(self.root, path, original)
        path.unlink()
        removed, _, _ = reindex_single_file(self.root, path, added)
        self.assertIs(added._direct_fields_by_module['blog.models'], original._direct_fields_by_module['blog.models'])
        self.assertIs(removed._direct_fields_by_module['blog.models'], original._direct_fields_by_module['blog.models'])
        self.assertEqual(removed._fields_by_model_and_name, self.index()._fields_by_model_and_name)

    def test_field_locality_proof_is_dropped_when_an_edit_adds_symbol_relations(self):
        source = 'from django.db import models\nclass Post(models.Model):\n    title = models.CharField()\n'
        path = self.write('models.py', source)
        original = self.index()
        self.assertIn('blog.models', original._independent_field_modules)
        path.write_text(source + '    target = models.ForeignKey(Target, on_delete=models.CASCADE)\n')
        edited, _, _ = reindex_single_file(self.root, path, original)
        self.assertNotIn('blog.models', edited._independent_field_modules)
        target = self.write('target.py', 'from django.db import models\nclass Target(models.Model):\n    value = models.IntegerField()\n')
        added, _, _ = reindex_single_file(self.root, target, edited)
        self.assertEqual(added.find_field('blog.Post', 'target').related_model_label, 'blog.Target')
        self.assertEqual(added._fields_by_model_and_name, self.index()._fields_by_model_and_name)
        target.unlink()
        removed, _, _ = reindex_single_file(self.root, target, added)
        self.assertIsNone(removed.find_field('blog.Post', 'target').related_model_label)
        self.assertEqual(removed._fields_by_model_and_name, self.index()._fields_by_model_and_name)
        self.assertIn('blog.models', original._independent_field_modules)

    def test_restored_field_modules_gain_locality_proof_through_field_resolution(self):
        self.write('models.py', 'from django.db import models\nclass Post(models.Model):\n    title = models.CharField()\n')
        restored = StaticIndex.from_cache_dict(self.index().to_cache_dict())
        self.assertIn('blog.models', restored._independent_field_modules)
        first = self.write('other.py', 'from django.db import models\nclass Other(models.Model):\n    value = models.IntegerField()\n')
        added, _, _ = reindex_single_file(self.root, first, restored)
        self.assertIn('blog.models', added._independent_field_modules)
        self.assertEqual(added._fields_by_model_and_name, self.index()._fields_by_model_and_name)
        class NoFieldScan(list):
            def __iter__(self):
                raise AssertionError('Validated cache declarations rescanned')
        added.modules['blog.models'] = dataclasses.replace(added.modules['blog.models'],
            pending_fields=NoFieldScan(added.modules['blog.models'].pending_fields))
        second = self.write('second.py', 'from django.db import models\nclass Second(models.Model):\n    value = models.IntegerField()\n')
        changed, _, _ = reindex_single_file(self.root, second, added)
        self.assertEqual(changed._fields_by_model_and_name, self.index()._fields_by_model_and_name)

    def test_runtime_callable_surface_excludes_repeated_external_source_paths(self):
        from django.db.models import QuerySet
        from django_orm_intellisense.features.orm_members import _runtime_callable_member_items
        with mock.patch('django_orm_intellisense.features.orm_members._runtime_return_semantics',
                        side_effect=AssertionError('External method annotation inspection')):
            items = _runtime_callable_member_items(owner_classes=[QuerySet],
                workspace_files=frozenset({str(self.root / 'blog' / 'models.py')}),
                receiver_kind='queryset', model_label='blog.Post', manager_name=None,
                default_return_kind='queryset')
        self.assertEqual(items, [])

    def test_runtime_callable_surface_retains_local_methods_and_return_labels(self):
        from tests.lookup_catalog_fixture import build_fixture
        build_fixture()
        from django.db.models import QuerySet
        from django_orm_intellisense.features.orm_members import _runtime_callable_member_items
        source = ('class WorkspaceBase(QuerySet):\n'
                  '    def recent(self) -> "QuerySet":\n        return self\n'
                  '    def hidden(self):\n        return self\n'
                  'class WorkspaceQuerySet(WorkspaceBase):\n'
                  '    hidden = None\n'
                  '    def total(self) -> "QuerySet":\n        return self\n')
        path = self.write('querysets.py', source)
        namespace = {'QuerySet': QuerySet}
        exec(compile(source, str(path), 'exec'), namespace)
        items = _runtime_callable_member_items(owner_classes=[namespace['WorkspaceQuerySet']],
            workspace_files=frozenset({str(path.resolve())}), receiver_kind='queryset',
            model_label='blog.Post', manager_name=None, default_return_kind='queryset')
        by_name = {item.name: item for item in items}
        self.assertEqual(set(by_name), {'recent', 'total'})
        self.assertEqual(by_name['recent'].return_kind, 'queryset')
        self.assertEqual(by_name['recent'].return_model_label, 'blog.Post')
        self.assertEqual(by_name['recent'].file_path, str(path.resolve()))
        self.assertEqual(by_name['total'].return_kind, 'queryset')
        self.assertEqual(by_name['total'].return_model_label, 'blog.Post')

    def test_scalar_edit_preserves_unchanged_related_model_surface(self):
        path = self.write('author.py', 'from django.db import models\nclass Author(models.Model):\n    name = models.CharField(max_length=30)\n')
        self.write('post.py', 'from django.db import models\nclass Post(models.Model):\n    author = models.ForeignKey("blog.Author", on_delete=models.CASCADE, related_name="posts")\n    title = models.CharField()\n')
        original = self.index()
        runtime = create_pending_runtime_inspection(None)
        graph = build_model_graph(original, runtime)
        surface = build_surface_index(static_index=original, runtime=runtime, model_graph=graph)
        stdout = sys.stdout
        try:
            server = DaemonServer(self.root)
        finally:
            sys.stdout = stdout
        path.write_text(path.read_text().replace('max_length=30', 'max_length=10'))
        outcome = server._compute_reindex(file_path=path, static_index=original,
            runtime=runtime, previous_model_graph=graph, existing_surface=surface,
            previous_static_fallback=None)
        self.assertIn('blog.Post', outcome.affected_labels)
        self.assertIs(outcome.surface_index['blog.Post'], surface['blog.Post'])
        self.assertNotIn('blog.Post', outcome.surface_index_delta)
        fresh_graph = build_model_graph(outcome.new_static_index, runtime)
        fresh_surface = build_surface_index(static_index=outcome.new_static_index,
            runtime=runtime, model_graph=fresh_graph)
        self.assertEqual(outcome.surface_index, fresh_surface)

    def test_model_catalog_does_not_construct_unrelated_default_field_classes(self):
        from django.db import models
        from tests.lookup_catalog_fixture import build_fixture
        from django_orm_intellisense.runtime.lookup_catalog import collect_model_lookup_catalog
        _, _, runtime, _, _ = build_fixture()
        self.write('models.py', 'from django.db import models\nclass Item(models.Model):\n    count = models.IntegerField()\n    class Meta:\n        app_label = "lookup_test"\n')
        graph = build_model_graph(self.index(), runtime)
        expected = collect_model_lookup_catalog(graph, runtime, 'lookup_test.Item')
        with mock.patch.object(models.BinaryField, '__init__',
                               side_effect=AssertionError('Unrelated cold default field')):
            actual = collect_model_lookup_catalog(graph, runtime, 'lookup_test.Item')
        self.assertEqual(actual, expected)

    def test_same_kind_constructor_edit_updates_parameterized_transform_output(self):
        from tests.lookup_catalog_fixture import build_fixture
        _, _, runtime, _, _ = build_fixture()
        path = self.write('models.py', 'from django.db import models\nclass Item(models.Model):\n    title = models.CharField(max_length=30)\n    class Meta:\n        app_label = "lookup_test"\n')
        original = self.index()
        graph = build_model_graph(original, runtime)
        before = resolve_lookup_path(model_graph=graph, runtime=runtime,
            base_model_label='lookup_test.Item', path='title__size_aware', method='filter')
        self.assertEqual(before['terminalType']['outputFieldKind'], 'CharField')
        path.write_text(path.read_text().replace('max_length=30', 'max_length=10'))
        edited, _, _ = reindex_single_file(self.root, path, original)
        graph = rebuild_model_graph_for_labels(graph, old_static_index=original,
            static_index=edited, runtime=runtime, affected_labels={'lookup_test.Item'})
        after = resolve_lookup_path(model_graph=graph, runtime=runtime,
            base_model_label='lookup_test.Item', path='title__size_aware', method='filter')
        self.assertEqual(after['terminalType']['outputFieldKind'], 'IntegerField')
        self.assertTrue(resolve_lookup_path(model_graph=graph, runtime=runtime,
            base_model_label='lookup_test.Item', path='title__only_here', method='filter')['resolved'])

    def test_local_constant_edit_refreshes_constructor_fingerprint_and_runtime_lookup(self):
        from tests.lookup_catalog_fixture import build_fixture
        _, _, runtime, _, _ = build_fixture()
        source = ('from django.db import models\nMAX_LENGTH = 30\nLIMIT = MAX_LENGTH\n'
                  'class Item(models.Model):\n    title = models.CharField(max_length=LIMIT)\n'
                  '    class Meta:\n        app_label = "lookup_test"\n')
        path = self.write('models.py', source)
        original = self.index()
        graph = build_model_graph(original, runtime)
        path.write_text(source.replace('MAX_LENGTH = 30', 'MAX_LENGTH = 10'))
        changed, _, _ = reindex_single_file(self.root, path, original)
        self.assertNotEqual(changed.find_field('lookup_test.Item', 'title').constructor_fingerprint,
                            original.find_field('lookup_test.Item', 'title').constructor_fingerprint)
        graph = rebuild_model_graph_for_labels(graph, old_static_index=original,
            static_index=changed, runtime=runtime, affected_labels={'lookup_test.Item'})
        result = resolve_lookup_path(model_graph=graph, runtime=runtime,
            base_model_label='lookup_test.Item', path='title__size_aware', method='filter')
        self.assertEqual(result['terminalType']['outputFieldKind'], 'IntegerField')
        self.assertTrue(resolve_lookup_path(model_graph=graph, runtime=runtime,
            base_model_label='lookup_test.Item', path='title__only_here', method='filter')['resolved'])

    def test_imported_constant_edit_refreshes_fingerprint_lookup_and_bounded_delta(self):
        from tests.lookup_catalog_fixture import build_fixture
        _, _, runtime, _, _ = build_fixture()
        constants = self.write('constants.py', 'MAX_LENGTH = 30\n')
        self.write('models.py', 'from django.db import models\nfrom .constants import MAX_LENGTH as LIMIT\n'
            'class Item(models.Model):\n    title = models.CharField(max_length=LIMIT)\n'
            '    class Meta:\n        app_label = "lookup_test"\n')
        original = self.index()
        graph = build_model_graph(original, runtime)
        stdout = sys.stdout
        try:
            server = DaemonServer(self.root)
        finally:
            sys.stdout = stdout
        constants.write_text('MAX_LENGTH = 10\n')
        outcome = server._compute_reindex(file_path=constants, static_index=original, runtime=runtime,
            previous_model_graph=graph, existing_surface=build_surface_index(
                static_index=original, runtime=runtime, model_graph=graph), previous_static_fallback=None)
        changed = outcome.new_static_index
        self.assertNotEqual(changed.find_field('lookup_test.Item', 'title').constructor_fingerprint,
                            original.find_field('lookup_test.Item', 'title').constructor_fingerprint)
        self.assertEqual(set(outcome.lookup_catalog_delta), {'lookup_test.Item'})
        chunk = outcome.lookup_catalog_delta['lookup_test.Item']
        descriptor = chunk['types'][chunk['fields']['lookup_test.Item']['title']]
        self.assertEqual(chunk['types'][descriptor['transforms']['size_aware']]['fieldKind'], 'IntegerField')
        self.assertTrue(resolve_lookup_path(model_graph=outcome.model_graph, runtime=runtime,
            base_model_label='lookup_test.Item', path='title__only_here', method='filter')['resolved'])

    def test_imported_constants_preserve_reexports_attribute_aliases_and_snapshots(self):
        from django.db import models
        from django_orm_intellisense.runtime.source_fields import field_from_source
        constants = self.write('constants.py', 'FIRST = 30\nLIMIT = FIRST\nFIRST = 10\n')
        self.write('exports.py', 'import blog.constants as values\nSIZE = values.LIMIT\n')
        self.write('reexport.py', 'from .exports import SIZE\n')
        self.write('models.py', 'from django.db import models\nfrom .reexport import SIZE\n'
            'import blog.constants as options\nFROZEN = options.LIMIT\n'
            'class Post(models.Model):\n    first = models.CharField(max_length=SIZE)\n'
            '    second = models.CharField(max_length=FROZEN)\n')
        original = StaticIndex.from_cache_dict(self.index().to_cache_dict())
        self.assertEqual(field_from_source(original.find_field('blog.Post', 'first'), models.CharField()).max_length, 30)
        self.assertEqual(field_from_source(original.find_field('blog.Post', 'second'), models.CharField()).max_length, 30)
        constants.write_text('FIRST = 20\nLIMIT = FIRST\nFIRST = 10\n')
        changed, _, _ = reindex_single_file(self.root, constants, original)
        for name in ('first', 'second'):
            old, new = original.find_field('blog.Post', name), changed.find_field('blog.Post', name)
            self.assertNotEqual(old.constructor_fingerprint, new.constructor_fingerprint)
            self.assertEqual(field_from_source(new, models.CharField()).max_length, 20)
            self.assertEqual(field_from_source(old, models.CharField()).max_length, 30)
        self.assertEqual(changed._fields_by_model_and_name, self.index()._fields_by_model_and_name)

    def test_imported_dynamic_missing_and_cyclic_values_are_not_executed(self):
        from django.db import models
        from django_orm_intellisense.runtime.source_fields import field_from_source
        constants = self.write('constants.py', 'LIMIT = 30\n')
        self.write('models.py', 'from django.db import models\nfrom .constants import LIMIT\n'
            'class Post(models.Model):\n    title = models.CharField(max_length=LIMIT)\n')
        original = self.index()
        fingerprint = original.find_field('blog.Post', 'title').constructor_fingerprint
        marker = self.root / 'executed'
        for source in ('LIMIT = 30\nLIMIT += 1\n',
                       f'LIMIT = __import__("pathlib").Path({str(marker)!r}).write_text("bad")\n',
                       'from .cycle import LIMIT\n'):
            if '.cycle' in source:
                self.write('cycle.py', 'from .constants import LIMIT\n')
            constants.write_text(source)
            changed, _, _ = reindex_single_file(self.root, constants, original)
            field = changed.find_field('blog.Post', 'title')
            self.assertNotEqual(field.constructor_fingerprint, fingerprint)
            self.assertIsNone(field_from_source(field, models.CharField()))
            self.assertFalse(marker.exists())
        constants.unlink()
        changed, _, _ = reindex_single_file(self.root, constants, original)
        self.assertIsNone(field_from_source(changed.find_field('blog.Post', 'title'), models.CharField()))

    def test_imported_constant_survives_promoted_base_and_graph_cache(self):
        from django.db import models
        from django_orm_intellisense.runtime.source_fields import field_from_source
        from django_orm_intellisense.cache.store import save_model_graph, load_cached_model_graph
        import os
        constants = self.write('constants.py', 'LIMIT = 30\n')
        self.write('base.py', 'from django.db import models\nfrom .constants import LIMIT\n'
            'class Base(models.Model):\n    title = models.CharField(max_length=LIMIT)\n'
            '    class Meta:\n        abstract = True\n')
        self.write('models.py', 'from .base import Base\nclass Post(Base):\n    pass\n')
        original = StaticIndex.from_cache_dict(self.index().to_cache_dict())
        constants.write_text('LIMIT = 10\n')
        changed, _, _ = reindex_single_file(self.root, constants, original)
        field = changed.find_field('blog.Post', 'title')
        self.assertEqual(field_from_source(field, models.CharField()).max_length, 10)
        graph = build_model_graph(changed, create_pending_runtime_inspection(None))
        with mock.patch.dict(os.environ, {'DJANGO_ORM_INTELLISENSE_CACHE_DIR': str(self.root / 'cache')}):
            save_model_graph(self.root, 'source', 'runtime', graph)
            restored = load_cached_model_graph(self.root, 'source', 'runtime')
        restored_field = restored.find_field('blog.Post', 'title')
        self.assertEqual(restored_field.imported_constants, field.imported_constants)
        self.assertEqual(restored_field.declaration_module, 'blog.base')
        self.assertEqual(field_from_source(restored_field, models.CharField()).max_length, 10)

    def test_imported_constant_reinspection_does_not_read_unrelated_sources(self):
        constants = self.write('constants.py', 'LIMIT = 30\n')
        self.write('models.py', 'from django.db import models\nfrom .constants import LIMIT\n'
            'class Post(models.Model):\n    title = models.CharField(max_length=LIMIT)\n')
        unrelated = self.write('unrelated.py', 'from django.db import models\nclass Other(models.Model):\n    title = models.CharField(max_length=40)\n')
        original = self.index()
        original_group = original._forward_field_groups['blog.Other']
        constants.write_text('LIMIT = 10\n')
        read_text = Path.read_text
        reads = []
        def read(path, *args, **kwargs):
            self.assertNotEqual(path, unrelated, 'Unrelated source reparsed')
            reads.append(str(path))
            return read_text(path, *args, **kwargs)
        with mock.patch.object(Path, 'read_text', read):
            changed, _, _ = reindex_single_file(self.root, constants, original)
        self.assertIs(changed._forward_field_groups['blog.Other'], original_group)
        self.assertIs(changed._constructor_module_files, original._constructor_module_files)
        self.assertEqual(changed._fields_by_model_and_name, self.index()._fields_by_model_and_name)
        self.assertTrue(reads)
        # An unrelated edit should reuse the already-built import adjacency.
        helper = self.write('helper.py', 'value = 1\n')
        unchanged, _, _ = reindex_single_file(self.root, helper, changed)
        self.assertIs(unchanged._constructor_dependency_cache, changed._constructor_dependency_cache)
        self.assertIn('blog.helper', unchanged._constructor_module_files)
        self.assertNotIn('blog.helper', original._constructor_module_files)

    def test_scalar_helper_edit_skips_unrelated_direct_fields_and_reuses_reverse_partition(self):
        constants = self.write('constants.py', 'LIMIT = 30\n')
        self.write('models.py', 'from django.db import models\nfrom .constants import LIMIT\n'
            'class Post(models.Model):\n    title = models.CharField(max_length=LIMIT)\n')
        self.write('other.py', 'from django.db import models\nclass Other(models.Model):\n    value = models.IntegerField()\n')
        original = StaticIndex.from_cache_dict(self.index().to_cache_dict())
        before_fields = list(original.fields)
        resolve = StaticIndex._resolve_direct_module_fields
        visited = []
        def resolve_direct(index, module):
            visited.append(module.module_name)
            self.assertNotEqual(module.module_name, 'blog.other', 'Unrelated direct fields scanned')
            return resolve(index, module)
        constants.write_text('LIMIT = 10\n')
        with mock.patch.object(StaticIndex, '_resolve_direct_module_fields', resolve_direct):
            changed, _, _ = reindex_single_file(self.root, constants, original)
        self.assertEqual(visited, ['blog.models'])
        self.assertIs(changed._reverse_fields, original._reverse_fields)
        self.assertIs(changed._forward_field_groups['blog.Other'], original._forward_field_groups['blog.Other'])
        self.assertEqual(changed._changed_field_labels, {'blog.Post'})
        self.assertEqual(changed.fields, self.index().fields)
        self.assertEqual(original.fields, before_fields)

    def test_helper_scalar_shortcut_falls_back_for_inheritance_primary_and_unpacked_options(self):
        examples = (
            'class Base(models.Model):\n    title = models.CharField(max_length=LIMIT)\n    class Meta:\n        abstract = True\nclass Post(Base):\n    pass\n',
            'class Post(models.Model):\n    slug = models.CharField(max_length=LIMIT, primary_key=True)\n',
            'OPTIONS = {"max_length": LIMIT}\nclass Post(models.Model):\n    title = models.CharField(**OPTIONS)\n',
            'class Post(models.Model):\n    id = models.CharField(max_length=LIMIT)\n',
            'class Post(models.Model):\n    owner = models.ForeignKey("blog.Other", on_delete=models.CASCADE, related_name=LIMIT)\n',
            'class Other(models.Model):\n    value = models.CharField(max_length=LIMIT)\n',
        )
        for declaration in examples:
            with self.subTest(declaration=declaration):
                constants = self.write('constants.py', 'LIMIT = 30\n')
                self.write('models.py', 'from django.db import models\nfrom .constants import LIMIT\n' + declaration)
                self.write('other.py', 'from django.db import models\nclass Other(models.Model):\n    value = models.IntegerField()\n')
                original = StaticIndex.from_cache_dict(self.index().to_cache_dict())
                constants.write_text('LIMIT = 10\n')
                visited = []
                resolve = StaticIndex._resolve_direct_module_fields
                def resolve_direct(index, module):
                    visited.append(module.module_name)
                    return resolve(index, module)
                with mock.patch.object(StaticIndex, '_resolve_direct_module_fields', resolve_direct):
                    changed, _, _ = reindex_single_file(self.root, constants, original)
                self.assertIn('blog.other', visited, 'Protected field edit bypassed the general resolver')
                self.assertIsNotNone(changed._changed_field_labels)
                fresh = self.index()
                self.assertEqual(changed.fields, fresh.fields)
                self.assertEqual(changed._fields_by_model_and_name, fresh._fields_by_model_and_name)
                self.assertEqual(changed._reverse_fields, fresh._reverse_fields)

    def test_scalar_helper_edit_refreshes_multiple_modules_with_unchanged_relations(self):
        constants = self.write('constants.py', 'LIMIT = 30\n')
        self.write('models.py', 'from django.db import models\nfrom .constants import LIMIT\n'
            'class Post(models.Model):\n    title = models.CharField(max_length=LIMIT)\n'
            '    owner = models.ForeignKey("blog.Owner", on_delete=models.CASCADE, related_name="posts")\n')
        self.write('extra.py', 'from django.db import models\nfrom .constants import LIMIT\n'
            'class Extra(models.Model):\n    title = models.CharField(max_length=LIMIT)\n')
        self.write('other.py', 'from django.db import models\nclass Owner(models.Model):\n    value = models.IntegerField()\n')
        original = StaticIndex.from_cache_dict(self.index().to_cache_dict())
        before = original.to_cache_dict()
        resolve = StaticIndex._resolve_direct_module_fields
        visited = []
        def resolve_direct(index, module):
            visited.append(module.module_name)
            self.assertNotEqual(module.module_name, 'blog.other', 'Unrelated direct fields scanned')
            return resolve(index, module)
        constants.write_text('LIMIT = 10\n')
        with mock.patch.object(StaticIndex, '_resolve_direct_module_fields', resolve_direct):
            changed, _, _ = reindex_single_file(self.root, constants, original)
        self.assertCountEqual(visited, ['blog.models', 'blog.extra'])
        self.assertIs(changed._reverse_fields, original._reverse_fields)
        self.assertIs(changed._forward_field_groups['blog.Owner'], original._forward_field_groups['blog.Owner'])
        self.assertEqual(changed._changed_field_labels, {'blog.Post', 'blog.Extra'})
        fresh = self.index()
        self.assertEqual(changed.fields, fresh.fields)
        self.assertEqual(changed._fields_by_model_label, fresh._fields_by_model_label)
        self.assertEqual(changed._fields_by_model_and_name, fresh._fields_by_model_and_name)
        self.assertEqual(original.to_cache_dict(), before)

    def test_same_mtime_helper_edits_refresh_imported_constructor_values(self):
        import os
        from django.db import models
        from django_orm_intellisense.runtime.source_fields import field_from_source
        constants = self.write('constants.py', 'LIMIT = 30\n')
        self.write('models.py', 'from django.db import models\nfrom .constants import LIMIT\n'
            'class Post(models.Model):\n    title = models.CharField(max_length=LIMIT)\n')
        original = StaticIndex.from_cache_dict(self.index().to_cache_dict())
        previous = original.find_field('blog.Post', 'title')
        self.assertEqual(field_from_source(previous, models.CharField()).max_length, 30)
        source_stat = constants.stat()
        constants.write_text('LIMIT = 10\n')
        os.utime(constants, ns=(source_stat.st_atime_ns, source_stat.st_mtime_ns))
        changed, _, _ = reindex_single_file(self.root, constants, original)
        current = changed.find_field('blog.Post', 'title')
        self.assertNotEqual(current.constructor_fingerprint, previous.constructor_fingerprint)
        self.assertEqual(field_from_source(current, models.CharField()).max_length, 10)
        self.assertEqual(field_from_source(previous, models.CharField()).max_length, 30)
        self.assertEqual(changed.fields, self.index().fields)

    def test_same_mtime_model_edits_materialize_current_local_constructor_values(self):
        import os
        from django.db import models
        from django_orm_intellisense.runtime.source_fields import field_from_source
        source = ('from django.db import models\nLIMIT = 30\n'
                  'class Post(models.Model):\n    title = models.CharField(max_length=LIMIT)\n')
        path = self.write('models.py', source)
        original = self.index()
        previous = original.find_field('blog.Post', 'title')
        self.assertEqual(field_from_source(previous, models.CharField()).max_length, 30)
        source_stat = path.stat()
        path.write_text(source.replace('LIMIT = 30', 'LIMIT = 10'))
        os.utime(path, ns=(source_stat.st_atime_ns, source_stat.st_mtime_ns))
        changed, _, _ = reindex_single_file(self.root, path, original)
        current = changed.find_field('blog.Post', 'title')
        self.assertNotEqual(current.constructor_fingerprint, previous.constructor_fingerprint)
        self.assertEqual(field_from_source(current, models.CharField()).max_length, 10)
        self.assertEqual(changed.fields, self.index().fields)

    def test_imported_choices_and_conditional_mutations_remain_bounded(self):
        from django.db import models
        from django_orm_intellisense.runtime.source_fields import field_from_source
        constants = self.write('constants.py', 'CHOICES = [("a", "Alpha"), ("b", "Beta")]\n')
        self.write('models.py', 'from django.db import models\nfrom .constants import CHOICES\n'
            'class Post(models.Model):\n    title = models.CharField(max_length=30, choices=CHOICES)\n')
        original = self.index()
        self.assertEqual(field_from_source(original.find_field('blog.Post', 'title'), models.CharField()).choices,
                         [('a', 'Alpha'), ('b', 'Beta')])
        constants.write_text('CHOICES = [("a", "Alpha")]\nif enabled:\n    CHOICES = []\n')
        changed, _, _ = reindex_single_file(self.root, constants, original)
        self.assertIsNone(field_from_source(changed.find_field('blog.Post', 'title'), models.CharField()))
        constants.write_text('CHOICES = [("a", "Alpha")]\nCHOICES.append(("b", "Beta"))\n')
        changed, _, _ = reindex_single_file(self.root, constants, original)
        self.assertIsNone(field_from_source(changed.find_field('blog.Post', 'title'), models.CharField()))

    def test_mixed_local_containers_materialize_imported_literal_values(self):
        from django.db import models
        from django_orm_intellisense.runtime.source_fields import field_from_source
        constants = self.write('constants.py', 'CODE = "a"\nLABEL = "Alpha"\nLIMIT = 30\n')
        self.write('models.py', 'from django.db import models\nfrom .constants import CODE, LABEL, LIMIT\n'
            'CHOICES = [(CODE, LABEL), ("b", "Beta")]\n'
            'class Post(models.Model):\n    title = models.CharField(max_length=LIMIT, choices=CHOICES)\n')
        original = self.index()
        updated = field_from_source(original.find_field('blog.Post', 'title'), models.CharField())
        self.assertIsNotNone(updated)
        self.assertEqual(updated.choices, [('a', 'Alpha'), ('b', 'Beta')])
        constants.write_text('CODE = "c"\nLABEL = "Charlie"\nLIMIT = 10\n')
        changed, _, _ = reindex_single_file(self.root, constants, original)
        updated = field_from_source(changed.find_field('blog.Post', 'title'), models.CharField())
        self.assertEqual(updated.max_length, 10)
        self.assertEqual(updated.choices, [('c', 'Charlie'), ('b', 'Beta')])
        self.assertEqual(field_from_source(original.find_field('blog.Post', 'title'), models.CharField()).choices,
                         [('a', 'Alpha'), ('b', 'Beta')])

    def test_mutation_through_alias_does_not_materialize_stale_container(self):
        from django.db import models
        from django_orm_intellisense.runtime.source_fields import field_from_source
        for constants in (
            'CHOICES = [("a", "Alpha")]\nOTHER = CHOICES\nOTHER.append(("b", "Beta"))\n',
            'CHOICES = [("a", "Alpha")]\nOTHER = CHOICES\nOTHER[0] = ("b", "Beta")\n',
            'CHOICES = [("a", "Alpha")]\nOTHER = CHOICES\nif enabled:\n    OTHER.clear()\n',
        ):
            with self.subTest(constants=constants):
                self.write('constants.py', constants)
                self.write('models.py', 'from django.db import models\nfrom .constants import CHOICES\n'
                    'class Post(models.Model):\n    title = models.CharField(max_length=30, choices=CHOICES)\n')
                field = self.index().find_field('blog.Post', 'title')
                self.assertIsNone(field_from_source(field, models.CharField()))

    def test_mutable_alias_rebinding_and_independent_containers_preserve_values(self):
        from django.db import models
        from django_orm_intellisense.runtime.source_fields import field_from_source
        examples = (
            'CHOICES = [("a", "Alpha")]\nOTHER = CHOICES\nOTHER = []\nOTHER.append(("b", "Beta"))\n',
            'CHOICES = [("a", "Alpha")]\nOTHER = [("a", "Alpha")]\nOTHER.clear()\n',
            'CHOICES = [("a", "Alpha")]\nOTHER = CHOICES\ndel OTHER\n',
        )
        for constants in examples:
            with self.subTest(constants=constants):
                self.write('constants.py', constants)
                self.write('models.py', 'from django.db import models\nfrom .constants import CHOICES\n'
                    'class Post(models.Model):\n    title = models.CharField(max_length=30, choices=CHOICES)\n')
                updated = field_from_source(self.index().find_field('blog.Post', 'title'), models.CharField())
                self.assertIsNotNone(updated)
                self.assertEqual(updated.choices, [('a', 'Alpha')])

    def test_nested_container_alias_and_class_mutations_do_not_hide_updates(self):
        from django.db import models
        from django_orm_intellisense.runtime.source_fields import field_from_source
        for statements in (
            'CHOICES = [("a", "Alpha")]\nOTHER = (CHOICES,)\nOTHER[0].append(("b", "Beta"))\n',
            'CHOICES = [("a", "Alpha")]\nOTHER = CHOICES\nOTHER += [("b", "Beta")]\n',
            'CHOICES = [("a", "Alpha")]\nOTHER = CHOICES\nif enabled:\n    OTHER.clear()\n',
        ):
            with self.subTest(statements=statements):
                self.write('models.py', 'from django.db import models\nclass Post(models.Model):\n' +
                    ''.join('    ' + line + '\n' for line in statements.splitlines()) +
                    '    title = models.CharField(max_length=30, choices=CHOICES)\n')
                self.assertIsNone(field_from_source(self.index().find_field('blog.Post', 'title'), models.CharField()))

    def test_imported_values_in_dict_tuple_and_nested_fields_are_materialized(self):
        from django.db import models
        from django_orm_intellisense.runtime.source_fields import field_from_source
        self.write('constants.py', 'CODE = "a"\nLABEL = "Alpha"\n')
        self.write('models.py', 'from django.db import models\nfrom .constants import CODE, LABEL\n'
            'class Post(models.Model):\n    title = models.CharField(max_length=30, choices={CODE: LABEL})\n'
            '    tuple_title = models.CharField(max_length=30, choices=((CODE, LABEL),))\n')
        for name in ('title', 'tuple_title'):
            self.assertEqual(field_from_source(self.index().find_field('blog.Post', name), models.CharField()).choices,
                             [('a', 'Alpha')])

    def test_imported_container_alias_mutation_is_not_materialized_as_original(self):
        from django.db import models
        from django_orm_intellisense.runtime.source_fields import field_from_source
        self.write('constants.py', 'CHOICES = [("a", "Alpha")]\n')
        for statements in (
            'from .constants import CHOICES\nOTHER = CHOICES\nOTHER.append(("b", "Beta"))\n',
            'import blog.constants as options\nCHOICES = options.CHOICES\nCHOICES.clear()\n',
        ):
            with self.subTest(statements=statements):
                self.write('models.py', 'from django.db import models\n' + statements +
                    'class Post(models.Model):\n    title = models.CharField(max_length=30, choices=CHOICES)\n')
                self.assertIsNone(field_from_source(self.index().find_field('blog.Post', 'title'), models.CharField()))

    def test_repeated_imported_container_values_share_materialization_budget(self):
        from django.db import models
        from django_orm_intellisense.runtime.source_fields import field_from_source
        self.write('constants.py', 'VALUE = ' + repr(list(range(100))) + '\n')
        self.write('models.py', 'from django.db import models\nfrom .constants import VALUE\n'
            'class Post(models.Model):\n    title = models.CharField(max_length=30, choices=[' +
            ', '.join('VALUE' for _ in range(50)) + '])\n')
        self.assertIsNone(field_from_source(self.index().find_field('blog.Post', 'title'), models.CharField()))

    def test_cross_module_constant_expansion_has_one_shared_budget(self):
        from django.db import models
        from django_orm_intellisense.runtime.source_fields import field_from_source
        for number in range(14):
            source = ('VALUE = 1\n' if number == 0 else
                      f'from .chain_{number - 1} import VALUE as BEFORE\nVALUE = [BEFORE, BEFORE]\n')
            self.write(f'chain_{number}.py', source)
        self.write('models.py', 'from django.db import models\nfrom .chain_13 import VALUE\n'
            'class Post(models.Model):\n    title = models.CharField(max_length=VALUE)\n')
        field = self.index().find_field('blog.Post', 'title')
        self.assertIsNone(field_from_source(field, models.CharField()))

    def test_local_constant_snapshot_preserves_assignment_order_and_later_imports(self):
        from django.db import models
        from django_orm_intellisense.runtime.source_fields import field_from_source
        source = ('from django.db import models\nBASE = 30\nLIMIT: int = BASE\nBASE = 10\n'
                  'class Post(models.Model):\n    title = models.CharField(max_length=LIMIT)\n'
                  'LIMIT = 99\nimport pathlib as models\n')
        path = self.write('models.py', source)
        original = self.index()
        field = original.find_field('blog.Post', 'title')
        self.assertEqual(field_from_source(field, models.CharField()).max_length, 30)
        path.write_text(source.replace('LIMIT = 99', 'LIMIT = 11'))
        changed, _, _ = reindex_single_file(self.root, path, original)
        self.assertEqual(changed.find_field('blog.Post', 'title').constructor_fingerprint,
                         field.constructor_fingerprint)
        self.assertEqual(field_from_source(changed.find_field('blog.Post', 'title'), models.CharField()).max_length, 30)

    def test_nested_constant_field_preserves_its_constructor_import_binding(self):
        from django.db import models
        from django_orm_intellisense.runtime.source_fields import field_from_source
        self.write('models.py', 'from django.db import models\nfrom django.db.models import DateField as Output\n'
            'OUTPUT = Output()\nfrom django.db.models import CharField as Output\nimport pathlib as django\n'
            'class Post(models.Model):\n    value = models.GeneratedField(expression=models.F("title"), output_field=OUTPUT, db_persist=True)\n')
        field = self.index().find_field('blog.Post', 'value')
        updated = field_from_source(field, None)
        self.assertIsInstance(updated, models.GeneratedField)
        self.assertIsInstance(updated.output_field, models.DateField)

    def test_constant_choices_are_materialized_without_running_source(self):
        from django.db import models
        from django_orm_intellisense.runtime.source_fields import field_from_source
        self.write('models.py', 'from django.db import models\nFIRST = ("a", "Alpha")\n'
            'CHOICES = [FIRST, ("b", "Beta")]\nclass Post(models.Model):\n'
            '    title = models.CharField(max_length=30, choices=CHOICES)\n')
        updated = field_from_source(self.index().find_field('blog.Post', 'title'), models.CharField())
        self.assertEqual(updated.choices, [('a', 'Alpha'), ('b', 'Beta')])

    def test_class_local_constant_takes_precedence_over_module_constant(self):
        from django.db import models
        from django_orm_intellisense.runtime.source_fields import field_from_source
        source = ('from django.db import models\nLIMIT = 30\nclass Post(models.Model):\n'
                  '    LIMIT = 10\n    title = models.CharField(max_length=LIMIT)\n')
        path = self.write('models.py', source)
        original = self.index()
        field = original.find_field('blog.Post', 'title')
        self.assertEqual(field_from_source(field, models.CharField()).max_length, 10)
        path.write_text(source.replace('    LIMIT = 10', '    LIMIT = 20'))
        changed, _, _ = reindex_single_file(self.root, path, original)
        changed_field = changed.find_field('blog.Post', 'title')
        self.assertNotEqual(changed_field.constructor_fingerprint, field.constructor_fingerprint)
        self.assertEqual(field_from_source(changed_field, models.CharField()).max_length, 20)

    def test_unresolved_and_dynamic_constant_expressions_are_not_evaluated(self):
        from django.db import models
        from django_orm_intellisense.runtime.source_fields import field_from_source
        examples = ['LIMIT = LATER\nLATER = 10\n', 'LIMIT = do_side_effect()\n',
                    'LIMIT = 30\nLIMIT += 1\n', 'LIMIT = 30\ndel LIMIT\n',
                    'LIMIT = 30\nLIMIT, OTHER = (10, 20)\n',
                    'LIMIT = 30\nif enabled:\n    LIMIT = 10\n']
        for constants in examples:
            with self.subTest(constants=constants):
                self.write('models.py', 'from django.db import models\n' + constants +
                    'class Post(models.Model):\n    title = models.CharField(max_length=LIMIT)\n')
                self.assertIsNone(field_from_source(self.index().find_field('blog.Post', 'title'), models.CharField()))

    def test_constant_expansion_is_bounded(self):
        from django.db import models
        from django_orm_intellisense.runtime.source_fields import field_from_source
        self.write('models.py', 'from django.db import models\nVALUE = 1\n' +
            'VALUE = [VALUE, VALUE]\n' * 40 +
            'class Post(models.Model):\n    title = models.CharField(max_length=VALUE)\n')
        self.assertIsNone(field_from_source(self.index().find_field('blog.Post', 'title'), models.CharField()))

    def test_constant_fingerprint_survives_imported_base_promotion_and_cache(self):
        self.write('base.py', 'from django.db import models\nclass Base(models.Model):\n'
            '    class Meta:\n        abstract = True\n')
        path = self.write('models.py', 'from .base import Base\nfrom django.db import models\n'
            'MAX_LENGTH = 30\nclass Post(Base):\n    title = models.CharField(max_length=MAX_LENGTH)\n')
        original = StaticIndex.from_cache_dict(self.index().to_cache_dict())
        fingerprint = original.find_field('blog.Post', 'title').constructor_fingerprint
        path.write_text(path.read_text().replace('MAX_LENGTH = 30', 'MAX_LENGTH = 10'))
        changed, _, _ = reindex_single_file(self.root, path, original)
        self.assertNotEqual(changed.find_field('blog.Post', 'title').constructor_fingerprint, fingerprint)
        self.assertEqual(changed._fields_by_model_and_name, self.index()._fields_by_model_and_name)

    def test_constant_only_edit_sends_bounded_catalog_delta(self):
        from tests.lookup_catalog_fixture import build_fixture
        _, _, runtime, _, _ = build_fixture()
        path = self.write('models.py', 'from django.db import models\nMAX_LENGTH = 30\n'
            'class Item(models.Model):\n    title = models.CharField(max_length=MAX_LENGTH)\n'
            '    class Meta:\n        app_label = "lookup_test"\n')
        original = self.index()
        graph = build_model_graph(original, runtime)
        stdout = sys.stdout
        try:
            server = DaemonServer(self.root)
        finally:
            sys.stdout = stdout
        path.write_text(path.read_text().replace('MAX_LENGTH = 30', 'MAX_LENGTH = 10'))
        outcome = server._compute_reindex(file_path=path, static_index=original, runtime=runtime,
            previous_model_graph=graph, existing_surface=build_surface_index(
                static_index=original, runtime=runtime, model_graph=graph), previous_static_fallback=None)
        self.assertEqual(set(outcome.lookup_catalog_delta), {'lookup_test.Item'})
        chunk = outcome.lookup_catalog_delta['lookup_test.Item']
        title_type = chunk['types'][chunk['fields']['lookup_test.Item']['title']]
        self.assertEqual(chunk['types'][title_type['transforms']['size_aware']]['fieldKind'], 'IntegerField')

    def test_nested_array_and_generated_output_edits_refresh_lookup_types(self):
        from tests.lookup_catalog_fixture import build_fixture
        _, _, runtime, _, _ = build_fixture()
        examples = [
            ('Item', 'generated', 'from django.db import models\n',
             'models.GeneratedField(expression=models.F("published"), output_field=models.DateTimeField(), db_persist=True)',
             'models.GeneratedField(expression=models.F("published"), output_field=models.DateField(), db_persist=True)',
             'generated__year__gte'),
        ]
        if 'lookup_test.Collection' in runtime.lookup_catalog['fields']:
            examples.append(('Collection', 'tags', 'from django.db import models\nfrom django.contrib.postgres.fields import ArrayField\n',
                'ArrayField(models.CharField(max_length=20))', 'ArrayField(models.DateField())', 'tags__0__year__gte'))
        for model_name, name, imports, before, after, lookup in examples:
            with self.subTest(model=model_name):
                path = self.write('models.py', imports + f'class {model_name}(models.Model):\n    {name} = {before}\n    class Meta:\n        app_label = "lookup_test"\n')
                original = self.index()
                self.assertIsNotNone(original.find_field(f'lookup_test.{model_name}', name))
                graph = build_model_graph(original, runtime)
                path.write_text(path.read_text().replace(before, after))
                edited, _, _ = reindex_single_file(self.root, path, original)
                graph = rebuild_model_graph_for_labels(graph, old_static_index=original,
                    static_index=edited, runtime=runtime, affected_labels={f'lookup_test.{model_name}'})
                result = resolve_lookup_path(model_graph=graph, runtime=runtime,
                    base_model_label=f'lookup_test.{model_name}', path=lookup, method='filter')
                self.assertTrue(result['resolved'], result)
                self.assertEqual(result['terminalType']['outputFieldKind'], 'IntegerField')

    def test_constructor_edit_sends_bounded_catalog_delta_and_preserves_initial_snapshot(self):
        from tests.lookup_catalog_fixture import build_fixture
        _, registry, runtime, _, _ = build_fixture()
        path = self.write('models.py', 'from django.db import models\nclass Item(models.Model):\n    title = models.CharField(max_length=30)\n    class Meta:\n        app_label = "lookup_test"\n')
        original = self.index()
        graph = build_model_graph(original, runtime)
        stdout = sys.stdout
        try:
            server = DaemonServer(self.root)
        finally:
            sys.stdout = stdout
        server.runtime_inspection = runtime
        path.write_text(path.read_text().replace('max_length=30', 'max_length=10'))
        outcome = server._compute_reindex(file_path=path, static_index=original,
            runtime=runtime, previous_model_graph=graph, existing_surface={}, previous_static_fallback=None)
        reply = server._commit_reindex(outcome)
        self.assertEqual(set(reply['lookupCatalogDelta']), {'lookup_test.Item'})
        catalog = server.runtime_inspection.lookup_catalog
        root = catalog['types'][catalog['fields']['lookup_test.Item']['title']]
        output = catalog['types'][root['transforms']['size_aware']]
        self.assertEqual(output['fieldKind'], 'IntegerField')
        self.assertIn('only_here', root['lookups'])
        self.assertNotIn('only_here', catalog['types'][catalog['fields']['lookup_test.Item']['other']]['lookups'])
        self.assertEqual(registry[('lookup_test.Item', 'title')].max_length, 30)
        self.assertNotEqual(catalog['fields']['lookup_test.Item']['title'], runtime.lookup_catalog['fields']['lookup_test.Item']['title'])

    def test_constructor_fingerprint_survives_inheritance_and_cache_roundtrip(self):
        base = self.write('base.py', 'from django.db import models\nclass Base(models.Model):\n    title = models.CharField(max_length=30)\n    class Meta:\n        abstract = True\n')
        self.write('models.py', 'from .base import Base\nclass Item(Base):\n    class Meta:\n        app_label = "lookup_test"\n')
        original = self.index()
        fingerprint = original.find_field('lookup_test.Item', 'title').constructor_fingerprint
        self.assertIsNotNone(fingerprint)
        restored = StaticIndex.from_cache_dict(original.to_cache_dict())
        self.assertEqual(restored.find_field('lookup_test.Item', 'title').constructor_fingerprint, fingerprint)
        base.write_text(base.read_text().replace('max_length=30', 'max_length=10'))
        changed, _, _ = reindex_single_file(self.root, base, restored)
        self.assertNotEqual(changed.find_field('lookup_test.Item', 'title').constructor_fingerprint, fingerprint)
        self.assertEqual(changed.fields, self.index().fields)

    def test_unsupported_constructor_expression_is_not_executed(self):
        from django.db import models
        from django_orm_intellisense.runtime.source_fields import field_from_source
        path = self.write('models.py', 'from django.db import models\nclass Post(models.Model):\n    title = models.CharField(max_length=do_side_effect())\n')
        field = self.index().find_field('blog.Post', 'title')
        self.assertIsNone(field_from_source(field, models.CharField(max_length=30)))

    def test_replaced_index_is_released_without_waiting_for_cyclic_gc(self):
        import gc
        import weakref
        enabled = gc.isenabled()
        gc.disable()
        try:
            path = self.write('models.py', 'from django.db import models\n'
                'class Post(models.Model):\n    title = models.CharField()\n')
            original = self.index()
            reference = weakref.ref(original)
            path.write_text(path.read_text().replace('CharField', 'TextField'))
            changed, _, _ = reindex_single_file(self.root, path, original)
            del original
            self.assertIsNone(reference(), 'Completed resolver retained the replaced index')
            self.assertEqual(changed.find_field('blog.Post', 'title').field_kind, 'TextField')
        finally:
            if enabled:
                gc.enable()

    def test_declaration_walkers_release_dropped_inputs_without_cyclic_gc(self):
        import ast
        import gc
        import weakref
        from django_orm_intellisense.static_index.field_declarations import (
            DeclarationContext, class_declaration_contexts, normalize_declaration, resolve_imported_constant)
        enabled = gc.isenabled()
        gc.disable()
        try:
            with self.subTest(walker='normalize'):
                value = ast.Constant(30)
                reference = weakref.ref(value)
                context = DeclarationContext({'LIMIT': value}, {})
                normalized = normalize_declaration(ast.Name(id='LIMIT'), context)
                del value, context
                self.assertIsNone(reference(), 'Normalization retained its declaration context')
                self.assertEqual(ast.literal_eval(normalized), 30)
            with self.subTest(walker='module'):
                tree = ast.parse('CHOICES = [("a", "Alpha")]\nclass Post:\n    pass\n')
                contexts = class_declaration_contexts(tree)
                value = next(iter(contexts.values())).bindings['CHOICES']
                reference = weakref.ref(value)
                del value, contexts, tree
                self.assertIsNone(reference(), 'Class snapshot visitor retained discarded bindings')
            with self.subTest(walker='imported'):
                class ModuleFiles(dict):
                    pass
                constants = self.write('constants.py', 'LIMIT = 30\n')
                files = ModuleFiles({'blog.constants': (str(constants), False)})
                reference = weakref.ref(files)
                normalized = resolve_imported_constant('blog.constants.LIMIT', files)
                del files
                self.assertIsNone(reference(), 'Imported visitor retained module-file ownership')
                self.assertEqual(ast.literal_eval(normalized), 30)
            self.assertFalse(gc.isenabled())
        finally:
            if enabled:
                gc.enable()

    def test_reindex_without_runtime_snapshot_still_publishes_static_field_changes(self):
        path = self.write('models.py', 'from django.db import models\n'
            'class Post(models.Model):\n    title = models.CharField()\n')
        original = self.index()
        graph = build_model_graph(original, create_pending_runtime_inspection(None))
        stdout = sys.stdout
        try:
            server = DaemonServer(self.root)
        finally:
            sys.stdout = stdout
        path.write_text(path.read_text().replace('CharField', 'TextField'))
        outcome = server._compute_reindex(file_path=path, static_index=original, runtime=None,
            previous_model_graph=graph, existing_surface={}, previous_static_fallback=None)
        self.assertEqual(outcome.new_static_index.find_field('blog.Post', 'title').field_kind, 'TextField')
        self.assertEqual(outcome.surface_index['blog.Post']['instance']['title'][3], 'TextField')
        self.assertEqual(outcome.lookup_catalog_delta, {})

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='djls-incremental-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'blog').mkdir()
        self.write('__init__.py', '')

    def write(self, name, source):
        path = self.root / 'blog' / name
        path.write_text(source)
        return path

    def index(self):
        return build_static_index(self.root, sorted(self.root.rglob('*.py')))

    @staticmethod
    def fields(index, label):
        return {field.name: field for field in index.fields_for_model(label)}

    def test_pure_helper_add_edit_delete_reuses_fields_and_updates_exports(self):
        self.write('models.py', 'from django.db import models\nclass Post(models.Model):\n    title = models.CharField()\n')
        original = self.index()
        path = self.write('utils.py', 'def helper():\n    pass\n')
        with mock.patch.object(StaticIndex, '_resolve_fields', side_effect=AssertionError('full field rebuild')):
            added, old, new = reindex_single_file(self.root, path, original)
            self.assertFalse(old | new)
            path.write_text('\n\ndef helper():\n    return 1\n')
            edited, _, _ = reindex_single_file(self.root, path, added)
            path.unlink()
            deleted, _, _ = reindex_single_file(self.root, path, edited)
        self.assertEqual(added.python_file_count, original.python_file_count + 1)
        self.assertEqual(deleted.python_file_count, original.python_file_count)
        self.assertEqual(edited.resolve_export_origin('blog.utils', 'helper').origin_line, 3)
        self.assertFalse(deleted.resolve_export_origin('blog.utils', 'helper').resolved)
        self.assertNotIn('blog.utils', original.modules)
        self.assertEqual(original.fields, deleted.fields)
        self.assertIs(self.fields(original, 'blog.Post')['title'], self.fields(edited, 'blog.Post')['title'])

    def test_field_edit_reuses_unrelated_fields_and_refreshes_inheritance(self):
        base = self.write('base.py', 'from django.db import models\nclass Base(models.Model):\n    title = models.CharField()\n    class Meta:\n        abstract = True\n')
        self.write('models.py', 'from django.db import models\nfrom .base import Base\nclass Post(Base):\n    body = models.TextField()\nclass Other(models.Model):\n    value = models.IntegerField()\n')
        old = self.index()
        base.write_text(base.read_text().replace('CharField', 'IntegerField'))
        new, _, _ = reindex_single_file(self.root, base, old)
        self.assertEqual(self.fields(new, 'blog.Post')['title'].field_kind, 'IntegerField')
        self.assertEqual(self.fields(old, 'blog.Post')['title'].field_kind, 'CharField')
        self.assertIs(self.fields(new, 'blog.Other')['value'], self.fields(old, 'blog.Other')['value'])

    def test_helper_import_changes_do_not_reuse_stale_field_resolution(self):
        helper = self.write('fields.py', 'from django.db.models import CharField as CustomField\n')
        self.write('models.py', 'from django.db import models\nfrom .fields import CustomField\nclass Post(models.Model):\n    title = CustomField()\n')
        old = self.index()
        self.assertIn('title', self.fields(old, 'blog.Post'))
        helper.write_text('def CustomField():\n    return None\n')
        new, old_labels, new_labels = reindex_single_file(self.root, helper, old)
        self.assertFalse(old_labels | new_labels)
        self.assertNotIn('title', self.fields(new, 'blog.Post'))
        outcome = self.compute(helper, old)
        self.assertIn('blog.Post', outcome.affected_labels)
        self.assertIn('blog.Post', outcome.surface_index_delta)

    def compute(self, path, index):
        stdout = sys.stdout
        try:
            server = DaemonServer(self.root)
        finally:
            sys.stdout = stdout
        runtime = create_pending_runtime_inspection(None)
        graph = build_model_graph(index, runtime)
        surface = build_surface_index(static_index=index, runtime=runtime, model_graph=graph)
        return server._compute_reindex(file_path=path, static_index=index, runtime=runtime,
            previous_model_graph=graph, existing_surface=surface, previous_static_fallback=None)

    def test_retarget_and_delete_relation_refresh_old_and_new_reverse_targets(self):
        path = self.write('models.py', 'from django.db import models\nclass Author(models.Model):\n    name = models.CharField()\nclass Editor(models.Model):\n    name = models.CharField()\nclass Post(models.Model):\n    author = models.ForeignKey("blog.Author", on_delete=models.CASCADE, related_name="posts")\n')
        old = self.index()
        path.write_text(path.read_text().replace('"blog.Author"', '"blog.Editor"'))
        changed, _, _ = reindex_single_file(self.root, path, old)
        self.assertNotIn('posts', self.fields(changed, 'blog.Author'))
        self.assertIn('posts', self.fields(changed, 'blog.Editor'))
        self.assertIn('posts', self.fields(old, 'blog.Author'))
        outcome = self.compute(path, old)
        self.assertTrue({'blog.Author', 'blog.Editor', 'blog.Post'} <= outcome.affected_labels)
        path.write_text(path.read_text().replace('    author = models.ForeignKey("blog.Editor", on_delete=models.CASCADE, related_name="posts")', '    title = models.CharField()'))
        removed = self.compute(path, changed)
        self.assertIn('blog.Editor', removed.affected_labels)
        self.assertNotIn('posts', self.fields(removed.new_static_index, 'blog.Editor'))

    def test_queryset_helper_edit_refreshes_dependent_model_surface(self):
        helper = self.write('querysets.py', 'from django.db import models\nclass PostQuerySet(models.QuerySet):\n    def active(self):\n        return self\n')
        self.write('models.py', 'from django.db import models\nfrom .querysets import PostQuerySet\nclass Post(models.Model):\n    title = models.CharField()\n    objects = PostQuerySet.as_manager()\n')
        old = self.index()
        helper.write_text(helper.read_text() + '    def fresh(self):\n        return self\n')
        outcome = self.compute(helper, old)
        self.assertIn('blog.Post', outcome.affected_labels or ())
        self.assertIn('fresh', outcome.surface_index_delta['blog.Post']['queryset'])

    def test_cached_field_injection_is_per_instance(self):
        self.write('models.py', 'from django.db import models\nclass Post(models.Model):\n    title = models.CharField()\n')
        old = self.index()
        args = dict(python_file_count=old.python_file_count, package_init_count=0,
            reexport_module_count=0, star_import_count=0, explicit_all_count=0,
            modules=old.modules, model_candidates=old.model_candidates)
        cached = StaticIndex(**args, _cached_fields=[])
        fresh = StaticIndex(**args)
        self.assertEqual(cached.fields, [])
        self.assertIn('title', self.fields(fresh, 'blog.Post'))

    def test_helper_reindex_preserves_promoted_model_app_label(self):
        self.write('base.py', 'from django.db import models\nclass Base(models.Model):\n    title = models.CharField()\n    class Meta:\n        abstract = True\n')
        self.write('models.py', 'from .base import Base\nclass Post(Base):\n    class Meta:\n        app_label = "custom"\n')
        old = self.index()
        helper = self.write('utils.py', 'def helper():\n    pass\n')
        new, _, _ = reindex_single_file(self.root, helper, old)
        self.assertIn('custom.Post', {candidate.label for candidate in new.model_candidates})
        self.assertNotIn('blog.Post', {candidate.label for candidate in new.model_candidates})
        self.assertIn('title', self.fields(new, 'custom.Post'))

    def test_base_removal_drops_promotions_without_mutating_old_snapshot(self):
        base = self.write('base.py', 'from django.db import models\nclass Base(models.Model):\n    title = models.CharField()\n')
        self.write('models.py', 'from .base import Base\nclass Post(Base):\n    pass\n')
        old = self.index()
        old_modules = {name: module.to_dict() for name, module in old.modules.items()}
        base.write_text('class Base:\n    pass\n')
        new, _, _ = reindex_single_file(self.root, base, old)
        self.assertEqual(new.model_candidates, [])
        self.assertEqual(new.fields, [])
        self.assertEqual(old_modules, {name: module.to_dict() for name, module in old.modules.items()})
        self.assertIn('title', self.fields(old, 'blog.Post'))

    def test_adding_scalar_matches_full_rebuild_and_reuses_reverse_fields(self):
        path = self.write('models.py', 'from django.db import models\nclass Author(models.Model):\n    name = models.CharField()\nclass Post(models.Model):\n    author = models.ForeignKey("blog.Author", on_delete=models.CASCADE, related_name="posts")\n')
        old = self.index()
        path.write_text(path.read_text() + '    title = models.CharField()\n')
        new, _, _ = reindex_single_file(self.root, path, old)
        full = self.index()
        self.assertEqual(new.fields, full.fields)
        self.assertIs(self.fields(new, 'blog.Author')['posts'], self.fields(old, 'blog.Author')['posts'])
        self.assertNotIn('title', self.fields(old, 'blog.Post'))

    def test_scalar_type_edit_matches_full_rebuild_and_reuses_reverse_fields(self):
        path = self.write('models.py', 'from django.db import models\nclass Author(models.Model):\n    name = models.CharField()\nclass Post(models.Model):\n    title = models.CharField()\n    author = models.ForeignKey("blog.Author", on_delete=models.CASCADE, related_name="posts")\n')
        old = self.index()
        path.write_text(path.read_text().replace('title = models.CharField()', 'title = models.IntegerField()'))
        new, _, _ = reindex_single_file(self.root, path, old)
        self.assertEqual(new.fields, self.index().fields)
        self.assertEqual(self.fields(new, 'blog.Post')['title'].field_kind, 'IntegerField')
        self.assertIs(self.fields(new, 'blog.Author')['posts'], self.fields(old, 'blog.Author')['posts'])
        self.assertEqual(self.fields(old, 'blog.Post')['title'].field_kind, 'CharField')
        self.assertIs(new._fields_by_model_label['blog.Author'], old._fields_by_model_label['blog.Author'])
        self.assertIs(new._relation_sources_by_target, old._relation_sources_by_target)
        self.assertIsNone(new._scalar_fields_by_model_label)

    def test_removing_last_scalar_drops_its_field_group_and_preserves_old_snapshot(self):
        path = self.write('models.py', 'from django.db import models\nclass Empty(models.Model):\n    value = models.CharField()\n')
        old = self.index()
        path.write_text(path.read_text().replace('    value = models.CharField()', '    pass'))
        new, _, _ = reindex_single_file(self.root, path, old)
        full = self.index()
        self.assertEqual(new.fields, full.fields)
        self.assertEqual(new._fields_by_model_label, full._fields_by_model_label)
        self.assertEqual(new._fields_by_model_and_name, full._fields_by_model_and_name)
        self.assertIsNotNone(old.find_field('blog.Empty', 'value'))
        self.assertIsNone(new.find_field('blog.Empty', 'value'))
        self.assertEqual(new._changed_field_labels, frozenset({'blog.Empty'}))

    def test_scalar_delete_matches_full_rebuild_and_preserves_colliding_reverse(self):
        path = self.write('models.py', 'from django.db import models\nclass Author(models.Model):\n    posts = models.CharField()\nclass Post(models.Model):\n    author = models.ForeignKey("blog.Author", on_delete=models.CASCADE, related_name="posts")\n')
        old = self.index()
        path.write_text(path.read_text().replace('    posts = models.CharField()', '    name = models.CharField()'))
        new, _, _ = reindex_single_file(self.root, path, old)
        self.assertEqual(new.fields, self.index().fields)
        self.assertIs(self.fields(new, 'blog.Author')['posts'], self.fields(old, 'blog.Author')['posts'])

    def test_dependency_caches_reuse_field_edits_and_invalidate_import_changes(self):
        base = self.write('base.py', 'from django.db import models\nclass Base(models.Model):\n    value = models.CharField()\n    class Meta:\n        abstract = True\n')
        self.write('alternate.py', 'from django.db import models\nclass Base(models.Model):\n    other = models.IntegerField()\n    class Meta:\n        abstract = True\n')
        child = self.write('models.py', 'from .base import Base\nclass Child(Base):\n    pass\n')
        old = self.index()
        self.assertIn('blog.Child', old.source_dependents({'blog.base'}))
        self.assertIn('blog.Child', old.inheritance_dependents({'blog.Base'}))
        base.write_text(base.read_text().replace('CharField', 'TextField'))
        changed, _, _ = reindex_single_file(self.root, base, old)
        self.assertIs(changed._import_dependency_cache, old._import_dependency_cache)
        self.assertIs(changed._inheritance_cache, old._inheritance_cache)
        child.write_text(child.read_text().replace('from .base import Base', 'from .alternate import Base'))
        imported, _, _ = reindex_single_file(self.root, child, changed)
        self.assertIsNot(imported._import_dependency_cache, changed._import_dependency_cache)
        self.assertIsNot(imported._inheritance_cache, changed._inheritance_cache)
        self.assertNotIn('blog.Child', imported.source_dependents({'blog.base'}))
        self.assertIn('blog.Child', imported.source_dependents({'blog.alternate'}))
        self.assertIn('other', self.fields(imported, 'blog.Child'))

    def test_model_add_delete_reuses_builtin_scalars_and_reresolves_symbol_relations(self):
        self.write('models.py', 'from django.db import models\nclass Post(models.Model):\n    stable = models.IntegerField()\n    target = models.ForeignKey(Target, on_delete=models.CASCADE)\n')
        original = self.index()
        self.assertIsNone(self.fields(original, 'blog.Post')['target'].related_model_label)
        target = self.write('targets.py', 'from django.db import models\nclass Target(models.Model):\n    name = models.CharField()\n')
        added, _, _ = reindex_single_file(self.root, target, original)
        self.assertIs(self.fields(added, 'blog.Post')['stable'], self.fields(original, 'blog.Post')['stable'])
        self.assertEqual(self.fields(added, 'blog.Post')['target'].related_model_label, 'blog.Target')
        self.assertEqual(added.fields, self.index().fields)
        self.assertIsNone(added._scalar_field_source)
        target.unlink()
        removed, _, _ = reindex_single_file(self.root, target, added)
        self.assertIs(self.fields(removed, 'blog.Post')['stable'], self.fields(original, 'blog.Post')['stable'])
        self.assertIsNone(self.fields(removed, 'blog.Post')['target'].related_model_label)
        self.assertEqual(removed.fields, self.index().fields)
        self.assertIsNone(removed._scalar_field_source)

    def test_model_creation_promotes_importing_subclass_without_mutating_old_module(self):
        self.write('models.py', 'from django.db import models\nfrom .base import Base\nclass Child(Base):\n    title = models.CharField()\n')
        original = self.index()
        old_module = original.modules['blog.models'].to_dict()
        base = self.write('base.py', 'from django.db import models\nclass Base(models.Model):\n    value = models.IntegerField()\n    class Meta:\n        abstract = True\n')
        added, _, _ = reindex_single_file(self.root, base, original)
        self.assertEqual(added.fields, self.index().fields)
        self.assertIn('value', self.fields(added, 'blog.Child'))
        self.assertEqual(original.modules['blog.models'].to_dict(), old_module)
        self.assertNotIn('blog.Child', original._model_candidates_by_label)
        base.unlink()
        removed, _, _ = reindex_single_file(self.root, base, added)
        self.assertEqual(removed.fields, self.index().fields)
        self.assertNotIn('blog.Child', removed._model_candidates_by_label)
        self.assertIn('title', self.fields(added, 'blog.Child'))

    def test_model_coverage_change_reuses_literal_relations_but_refreshes_reverse_fields(self):
        target = self.write('targets.py', 'from django.db import models\nclass Target(models.Model):\n    value = models.IntegerField()\n')
        self.write('models.py', 'from django.db import models\nclass Post(models.Model):\n    title = models.CharField()\n    target = models.ForeignKey("blog.Target", on_delete=models.CASCADE, related_name="posts")\n')
        original = self.index()
        helper_model = self.write('other.py', 'from django.db import models\nclass Other(models.Model):\n    value = models.IntegerField()\n')
        added, _, _ = reindex_single_file(self.root, helper_model, original)
        self.assertIs(added.modules['blog.models'], original.modules['blog.models'])
        self.assertIs(added._direct_fields_by_module['blog.models'], original._direct_fields_by_module['blog.models'])
        self.assertEqual(added._fields_by_model_and_name, self.index()._fields_by_model_and_name)
        target.unlink()
        removed, _, _ = reindex_single_file(self.root, target, added)
        self.assertEqual(removed._fields_by_model_and_name, self.index()._fields_by_model_and_name)
        self.assertEqual(self.fields(removed, 'blog.Post')['target'].related_model_label, 'blog.Target')
        self.assertIs(self.fields(removed, 'blog.Post')['target'], self.fields(original, 'blog.Post')['target'])
        self.assertIn('blog.Target', original._model_candidates_by_label)

    def test_model_coverage_reuses_unchanged_reverse_fields_but_refreshes_locations_and_names(self):
        source = ('from django.db import models\nclass Target(models.Model):\n    value = models.IntegerField()\n'
                  'class Post(models.Model):\n    target = models.ForeignKey("blog.Target", on_delete=models.CASCADE, related_name="posts", related_query_name="post")\n')
        path = self.write('models.py', source)
        original = self.index()
        reverse = original.find_field('blog.Target', 'posts')
        extra = self.write('other.py', 'from django.db import models\nclass Other(models.Model):\n    value = models.CharField()\n')
        added, _, _ = reindex_single_file(self.root, extra, original)
        self.assertIs(added.find_field('blog.Target', 'posts'), reverse)
        self.assertEqual(added.fields, self.index().fields)
        for text, name in (('\n' + source, 'posts'),
                           (source.replace('related_query_name="post"', 'related_query_name="entry"'), 'posts'),
                           (source.replace('related_name="posts"', 'related_name="entries"'), 'entries'),
                           (source.replace('ForeignKey', 'OneToOneField'), 'posts')):
            with self.subTest(text=text):
                path.write_text(text)
                changed, _, _ = reindex_single_file(self.root, path, added)
                self.assertIsNot(changed.find_field('blog.Target', name), reverse)
                self.assertEqual(changed.fields, self.index().fields)
        self.assertEqual(reverse.related_query_name, 'post')
        self.assertEqual(original.find_field('blog.Target', 'posts'), reverse)

    def test_model_package_create_modify_delete_statistics_match_full_index(self):
        self.write('helpers.py', 'from django.db.models import CharField\n')
        self.write('models.py', 'from django.db import models\nclass Post(models.Model):\n    title = models.CharField()\n')
        original = self.index()
        package = self.root / 'blog' / 'entities'
        package.mkdir()
        path = package / '__init__.py'
        source = ('from django.db import models\nfrom ..helpers import *\n__all__ = ["Entity"]\n'
                  'class Entity(models.Model):\n    title = models.CharField()\n')
        previous = original
        for text in (source, source.replace('__all__ = ["Entity"]\n', ''), None):
            if text is None:
                path.unlink()
            else:
                path.write_text(text)
            updated, _, _ = reindex_single_file(self.root, path, previous)
            fresh = self.index()
            self.assertEqual(updated.to_dict(), fresh.to_dict())
            self.assertCountEqual(updated.fields, fresh.fields)
            self.assertEqual(updated._fields_by_model_and_name, fresh._fields_by_model_and_name)
            previous = updated
        self.assertEqual(previous.to_dict(), original.to_dict())

    def test_relation_source_index_tracks_abstract_changes_during_map_reuse(self):
        source = ('from django.db import models\nclass Target(models.Model):\n    value = models.IntegerField()\n'
                  'class Post(models.Model):\n    target = models.ForeignKey("blog.Target", on_delete=models.CASCADE)\n'
                  '    class Meta:\n        abstract = ABSTRACT\n')
        path = self.write('models.py', source.replace('ABSTRACT', 'False'))
        original = self.index()
        self.assertIn('blog.Post', original._relation_sources_by_target['blog.Target'])
        previous = original
        for abstract in ('True', 'False'):
            path.write_text(source.replace('ABSTRACT', abstract))
            updated, _, _ = reindex_single_file(self.root, path, previous)
            fresh = self.index()
            self.assertEqual(updated._relation_sources_by_target, fresh._relation_sources_by_target)
            self.assertEqual(updated._fields_by_model_and_name, fresh._fields_by_model_and_name)
            previous = updated
        self.assertIn('blog.Post', original._relation_sources_by_target['blog.Target'])

    def test_star_export_filter_change_invalidates_field_resolution(self):
        helper = self.write('fields.py', 'from django.db.models import CharField as CustomField\n__all__ = ["CustomField"]\n')
        self.write('models.py', 'from django.db import models\nfrom .fields import *\nclass Post(models.Model):\n    title = CustomField()\n')
        old = self.index()
        self.assertIn('title', self.fields(old, 'blog.Post'))
        helper.write_text('from django.db.models import CharField as CustomField\n__all__ = []\n')
        new, _, _ = reindex_single_file(self.root, helper, old)
        self.assertNotIn('title', self.fields(new, 'blog.Post'))

    def test_helper_noop_commit_invalidates_snapshot_and_background_workers(self):
        self.write('models.py', 'from django.db import models\nclass Post(models.Model):\n    title = models.CharField()\n')
        old = self.index()
        path = self.write('utils.py', 'def helper():\n    pass\n')
        outcome = self.compute(path, old)
        stdout = sys.stdout
        try:
            server = DaemonServer(self.root)
        finally:
            sys.stdout = stdout
        with mock.patch.object(server, '_discard_bg_pool') as discard:
            self.assertEqual(server._commit_reindex(outcome), {'unchanged': True})
            discard.assert_called_once()
        self.assertTrue(server._source_snapshot_dirty)
        self.assertIs(server.static_index, outcome.new_static_index)
        self.assertEqual(server._reindex_serial, 1)

    def test_shadowed_file_edit_and_delete_preserve_package_winner(self):
        sibling = self.write('entities.py', 'from django.db import models\nclass Shadow(models.Model):\n    value = models.CharField()\n')
        (self.root / 'blog' / 'entities').mkdir()
        winner = self.write('entities/__init__.py', 'from django.db import models\nclass Visible(models.Model):\n    value = models.IntegerField()\n')
        old = self.index()
        original = old.to_cache_dict()
        sibling.write_text(sibling.read_text().replace('CharField', 'TextField'))
        changed, _, _ = reindex_single_file(self.root, sibling, old)
        self.assertEqual(changed.modules['blog.entities'].file_path, str(winner))
        self.assertEqual(changed.fields, self.index().fields)
        self.assertEqual(changed.python_file_count, 3)
        self.assertEqual(changed.shadowed_files, self.index().shadowed_files)
        sibling.unlink()
        deleted, _, _ = reindex_single_file(self.root, sibling, changed)
        self.assertEqual(deleted.modules['blog.entities'].file_path, str(winner))
        self.assertEqual(deleted.fields, self.index().fields)
        self.assertEqual(deleted.python_file_count, 2)
        self.assertEqual(old.to_cache_dict(), original)

    def test_deleting_package_winner_promotes_surviving_sibling(self):
        sibling = self.write('entities.py', 'from django.db import models\nclass Shadow(models.Model):\n    value = models.CharField()\n')
        (self.root / 'blog' / 'entities').mkdir()
        winner = self.write('entities/__init__.py', 'from django.db import models\nclass Visible(models.Model):\n    value = models.IntegerField()\n')
        old = self.index()
        winner.unlink()
        changed, old_labels, new_labels = reindex_single_file(self.root, winner, old)
        self.assertEqual(changed.modules['blog.entities'].file_path, str(sibling))
        self.assertEqual(changed.fields, self.index().fields)
        self.assertEqual(old_labels, {'blog.Visible'})
        self.assertEqual(new_labels, {'blog.Shadow'})
        self.assertEqual(changed.python_file_count, 2)

    def test_reindex_transmits_only_changed_fallback_and_preserves_other_models(self):
        path = self.write('models.py', 'from django.db import models\nclass Post(models.Model):\n    title = models.CharField()\n')
        self.write('other.py', 'from django.db import models\nclass Other(models.Model):\n    value = models.IntegerField()\n')
        index = self.index()
        stdout = sys.stdout
        try:
            server = DaemonServer(self.root)
        finally:
            sys.stdout = stdout
        runtime = create_pending_runtime_inspection(None)
        graph = build_model_graph(index, runtime)
        fallback = server._build_static_fallback(model_graph=graph, surface_index={})
        server._last_static_fallback = fallback
        server._last_static_fallback_fingerprint = 'initial'
        path.write_text(path.read_text() + '    body = models.TextField()\n')
        outcome = server._compute_reindex(file_path=path, static_index=index, runtime=runtime,
            previous_model_graph=graph, existing_surface={}, previous_static_fallback=fallback)
        with mock.patch.object(server, '_discard_bg_pool'):
            result = server._commit_reindex(outcome)
        self.assertNotIn('staticFallback', result)
        self.assertEqual(result['staticFallbackDelta'], {})
        self.assertEqual(result['removedStaticFallbackLabels'], ['blog.Post'])
        self.assertIs(server._last_static_fallback['blog.Other'], fallback['blog.Other'])
        self.assertEqual(result['surfaceIndexDelta']['blog.Post']['instance']['body'][3], 'TextField')
        merged = dict(fallback)
        for label in result['removedStaticFallbackLabels']:
            merged.pop(label)
        merged.update(result['staticFallbackDelta'])
        self.assertEqual(merged, server._last_static_fallback)

    def test_parallel_cold_scan_preserves_collisions_and_parse_failures(self):
        self.write('entities.py', 'from django.db import models\nclass Shadow(models.Model):\n    value = models.CharField()\n')
        (self.root / 'blog' / 'entities').mkdir()
        self.write('entities/__init__.py', 'from django.db import models\nclass Visible(models.Model):\n    value = models.IntegerField()\n')
        self.write('broken.py', 'def broken(\n')
        small = self.index()
        for number in range(150):
            self.write(f'helper_{number}.py', f'value = {number}\n')
        large = self.index()
        self.assertEqual(large.model_candidates, small.model_candidates)
        self.assertEqual(large.fields, small.fields)
        self.assertEqual(large.shadowed_files, small.shadowed_files)
        self.assertEqual(large.unparseable_files, small.unparseable_files)
        self.assertEqual(large.modules['blog.entities'], small.modules['blog.entities'])
        self.assertEqual(large.python_file_count, len(large.modules) + len(large.shadowed_files) + len(large.unparseable_files))
        restored = StaticIndex.from_cache_dict(large.to_cache_dict())
        self.assertEqual(restored.fields, large.fields)

    def test_source_path_cache_is_reused_only_when_module_paths_stay_unchanged(self):
        path = self.write('models.py', 'from django.db import models\nclass Post(models.Model):\n    title = models.CharField()\n')
        old = self.index()
        original_paths = _workspace_files(old)
        path.write_text(path.read_text().replace('CharField', 'TextField'))
        changed, _, _ = reindex_single_file(self.root, path, old)
        with mock.patch.object(Path, 'resolve', side_effect=AssertionError('workspace-wide path resolution')):
            self.assertIs(_workspace_files(changed), original_paths)
        helper = self.write('helper.py', 'value = True\n')
        added, _, _ = reindex_single_file(self.root, helper, changed)
        expected_helper = str(helper.resolve())
        with mock.patch.object(Path, 'resolve', side_effect=AssertionError('workspace-wide path resolution')):
            self.assertIn(expected_helper, _workspace_files(added))
        self.assertNotIn(str(helper.resolve()), original_paths)
        helper.unlink()
        removed, _, _ = reindex_single_file(self.root, helper, added)
        with mock.patch.object(Path, 'resolve', side_effect=AssertionError('workspace-wide path resolution')):
            self.assertNotIn(expected_helper, _workspace_files(removed))

    def test_source_path_cache_preserves_aliases_and_tracks_deleted_or_retargeted_symlinks(self):
        target = self.write('target.py', 'value = 1\n')
        other = self.write('other.py', 'value = 2\n')
        alias = self.root / 'blog/alias.py'
        alias.symlink_to(target)
        original = self.index()
        old_paths = _workspace_files(original)
        old_target, other_target = str(target.resolve()), str(other.resolve())
        alias.unlink()
        alias.symlink_to(other)
        retargeted, _, _ = reindex_single_file(self.root, alias, original)
        self.assertEqual(_workspace_files(retargeted), _workspace_files(self.index()))
        self.assertEqual(retargeted._workspace_source_paths_by_module['blog.alias'], other_target)
        self.assertEqual(retargeted._workspace_source_path_counts[old_target], 1)
        self.assertEqual(retargeted._workspace_source_path_counts[other_target], 2)
        alias.unlink()
        removed, _, _ = reindex_single_file(self.root, alias, retargeted)
        with mock.patch.object(Path, 'resolve', side_effect=AssertionError('workspace-wide path resolution')):
            self.assertEqual(_workspace_files(removed), old_paths)
        self.assertEqual(removed._workspace_source_path_counts[other_target], 1)
        self.assertEqual(original._workspace_source_paths_by_module['blog.alias'], old_target)

    def test_pending_surface_never_uses_stale_global_django_registry(self):
        self.write('models.py', 'from django.db import models\nclass PostQuerySet(models.QuerySet):\n    def active(self):\n        return self\nclass Post(models.Model):\n    title = models.CharField()\n    objects = PostQuerySet.as_manager()\n')
        index = self.index()
        runtime = create_pending_runtime_inspection(None)
        graph = build_model_graph(index, runtime)
        with mock.patch('django_orm_intellisense.features.orm_members._runtime_model_class',
                        side_effect=AssertionError('pending surface consulted global Django apps')):
            surface = build_surface_index(static_index=index, runtime=runtime, model_graph=graph)
        self.assertIn('title', surface['blog.Post']['instance'])
        self.assertIn('active', surface['blog.Post']['queryset'])
        self.assertIn('filter', surface['blog.Post']['manager'])

    def test_ready_runtime_snapshot_cannot_restore_edited_or_deleted_static_fields(self):
        path = self.write('models.py', 'from django.db import models\nclass Post(models.Model):\n    title = models.CharField()\n')
        original = self.index()
        runtime = dataclasses.replace(create_pending_runtime_inspection(None), bootstrap_status='ready', model_catalog=[
            RuntimeModelSummary('blog.Post', 'blog.models', ['title'], [], [],
                [RuntimeFieldSummary('title', 'CharField', False, None, None)], [], ['objects'])
        ])
        graph = build_model_graph(original, runtime)
        path.write_text(path.read_text().replace('CharField', 'DateField'))
        changed, _, _ = reindex_single_file(self.root, path, original)
        graph = rebuild_model_graph_for_labels(graph, old_static_index=original,
            static_index=changed, runtime=runtime, affected_labels={'blog.Post'})
        self.assertEqual(graph.find_field('blog.Post', 'title').field_kind, 'DateField')
        from django.db import models
        with mock.patch('django_orm_intellisense.features.lookup_paths.get_runtime_field', return_value=models.CharField(max_length=255)):
            lookup = resolve_lookup_path(model_graph=graph, runtime=runtime,
                base_model_label='blog.Post', path='title__year__gte', method='filter')
        self.assertTrue(lookup['resolved'])
        self.assertEqual(lookup['terminalType']['outputFieldKind'], 'IntegerField')
        graph = rebuild_model_graph_for_labels(graph, old_static_index=changed,
            static_index=changed, runtime=runtime, affected_labels={'blog.Post'})
        self.assertEqual(graph.find_field('blog.Post', 'title').field_kind, 'DateField')
        path.write_text('from django.db import models\nclass Post(models.Model):\n    pass\n')
        deleted, _, _ = reindex_single_file(self.root, path, changed)
        graph = rebuild_model_graph_for_labels(graph, old_static_index=changed,
            static_index=deleted, runtime=runtime, affected_labels={'blog.Post'})
        self.assertIsNone(graph.find_field('blog.Post', 'title'))
        graph = rebuild_model_graph_for_labels(graph, old_static_index=deleted,
            static_index=deleted, runtime=runtime, affected_labels={'blog.Post'})
        self.assertIsNone(graph.find_field('blog.Post', 'title'))
        path.unlink()
        removed, _, _ = reindex_single_file(self.root, path, deleted)
        graph = rebuild_model_graph_for_labels(graph, old_static_index=deleted,
            static_index=removed, runtime=runtime, affected_labels={'blog.Post'})
        self.assertIsNone(graph.node_for_model('blog.Post'))
        graph = rebuild_model_graph_for_labels(graph, old_static_index=removed,
            static_index=removed, runtime=runtime, affected_labels={'blog.Post'})
        self.assertIsNone(graph.node_for_model('blog.Post'))
        path.write_text('from django.db import models\nclass Post(models.Model):\n    title = models.DateField()\n')
        recreated, _, _ = reindex_single_file(self.root, path, removed)
        graph = rebuild_model_graph_for_labels(graph, old_static_index=removed,
            static_index=recreated, runtime=runtime, affected_labels={'blog.Post'})
        self.assertEqual(graph.find_field('blog.Post', 'title').field_kind, 'DateField')
        self.assertFalse(graph.removed_static_model_labels)


if __name__ == '__main__':
    unittest.main()
