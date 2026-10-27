import contextlib
import importlib
import importlib.abc
import importlib.machinery
import importlib.util
import os
import py_compile
import sys
import threading
import unittest
import weakref
from collections import Counter
from pathlib import Path
from unittest import mock

import test_runtime_source_imports as fixtures
from django_orm_intellisense.runtime import source_imports


class _PartialCounter(Counter):
    armed = False

    def __setitem__(self, key, value):
        super().__setitem__(key, value)
        if type(self).armed:
            type(self).armed = False
            raise MemoryError('partial source registration')


class SourceImportScopeTests(unittest.TestCase):
    setUp = fixtures.RuntimeSourceImportsTests.setUp
    remove_modules = fixtures.RuntimeSourceImportsTests.remove_modules
    stale_source = fixtures.RuntimeSourceImportsTests.stale_source

    def identities(self):
        return tuple(id(finder) for finder in sys.meta_path)

    def test_partial_registration_failure_leaves_no_owner_and_can_recover(self):
        name = 'djls_scope_partial'
        self.stale_source(self.root, name)
        counter = _PartialCounter()
        _PartialCounter.armed = True
        self.addCleanup(setattr, _PartialCounter, 'armed', False)
        with mock.patch.object(sys, 'meta_path', list(sys.meta_path)), \
                mock.patch.object(source_imports._finder, 'roots', counter):
            before = self.identities()
            with self.assertRaisesRegex(MemoryError, 'partial source registration'):
                with source_imports.current_workspace_source_imports([self.root]):
                    self.fail('Failed registration yielded a scope')
            self.assertEqual(self.identities(), before)
            self.assertFalse(source_imports._finder.roots)
            self.assertEqual(importlib.import_module(name).value, 'old')
            sys.modules.pop(name)
            with source_imports.current_workspace_source_imports([self.root]):
                self.assertEqual(importlib.import_module(name).value, 'new')
            self.assertEqual(self.identities(), before)

    def test_failed_nested_registration_preserves_existing_owner(self):
        name = 'djls_scope_nested_partial'
        self.stale_source(self.external, name)
        with mock.patch.object(sys, 'meta_path', list(sys.meta_path)), \
                source_imports.current_workspace_source_imports([self.root]):
            before = self.identities()
            expected = Counter(source_imports._finder.roots)
            counter = _PartialCounter(expected)
            _PartialCounter.armed = True
            self.addCleanup(setattr, _PartialCounter, 'armed', False)
            with mock.patch.object(source_imports._finder, 'roots', counter):
                with self.assertRaisesRegex(MemoryError, 'partial source registration'):
                    with source_imports.current_workspace_source_imports([self.external]):
                        self.fail('Failed nested registration yielded')
                self.assertEqual(source_imports._finder.roots, expected)
                self.assertEqual(self.identities(), before)
                self.assertEqual(importlib.import_module(name).value, 'old')
                sys.modules.pop(name)
                with source_imports.current_workspace_source_imports([self.external]):
                    self.assertEqual(importlib.import_module(name).value, 'new')
                self.assertEqual(source_imports._finder.roots, expected)

    def test_removed_finder_cleanup_does_not_replace_body_exception(self):
        with mock.patch.object(sys, 'meta_path', list(sys.meta_path)):
            before = self.identities()
            with self.assertRaisesRegex(RuntimeError, 'original scope body'):
                with source_imports.current_workspace_source_imports([self.root]):
                    sys.meta_path[:] = [item for item in sys.meta_path if item is not source_imports._finder]
                    raise RuntimeError('original scope body')
            self.assertFalse(source_imports._finder.roots)
            self.assertEqual(self.identities(), before)

    def test_new_scope_repairs_a_finder_removed_during_an_outer_scope(self):
        name = 'djls_scope_reinstall'
        self.stale_source(self.root, name)
        with mock.patch.object(sys, 'meta_path', list(sys.meta_path)):
            before = self.identities()
            with source_imports.current_workspace_source_imports([self.root]):
                sys.meta_path[:] = [item for item in sys.meta_path if item is not source_imports._finder]
                with source_imports.current_workspace_source_imports([self.external]):
                    self.assertEqual(sum(item is source_imports._finder for item in sys.meta_path), 1)
                    self.assertEqual(importlib.import_module(name).value, 'new')
            self.assertEqual(self.identities(), before)

    def test_equal_foreign_finder_keeps_precedence_before_actual_pathfinder(self):
        name = 'djls_scope_equal_priority'
        self.stale_source(self.root, name)
        class Loader(importlib.abc.Loader):
            def create_module(self, spec):
                return None
            def exec_module(self, module):
                module.value = 'custom'
        class Finder:
            def __eq__(self, other):
                return other is importlib.machinery.PathFinder
            def find_spec(self, fullname, path=None, target=None):
                return importlib.util.spec_from_loader(fullname, Loader()) if fullname == name else None
        foreign = Finder()
        with mock.patch.object(sys, 'meta_path', [foreign, *sys.meta_path]), \
                source_imports.current_workspace_source_imports([self.root]):
            self.assertEqual(importlib.import_module(name).value, 'custom')

    def test_cleanup_does_not_remove_a_foreign_finder_equal_to_ours(self):
        class Finder:
            def __eq__(self, other):
                return other is source_imports._finder
            def find_spec(self, fullname, path=None, target=None):
                return None
        foreign = Finder()
        with mock.patch.object(sys, 'meta_path', [foreign, *sys.meta_path]):
            before = self.identities()
            with source_imports.current_workspace_source_imports([self.root]):
                pass
            self.assertEqual(self.identities(), before)

    def test_absent_pathfinder_is_not_enabled_by_source_scope(self):
        name = 'djls_scope_disabled_pathfinder'
        self.stale_source(self.root, name)
        without = [item for item in sys.meta_path if item is not importlib.machinery.PathFinder]
        with mock.patch.object(sys, 'meta_path', without), \
                source_imports.current_workspace_source_imports([self.root]):
            with self.assertRaises(ModuleNotFoundError):
                importlib.import_module(name)

    def test_pathfinder_removed_then_restored_during_scope_keeps_policy(self):
        name = 'djls_scope_revoked_pathfinder'
        self.stale_source(self.root, name)
        with mock.patch.object(sys, 'meta_path', list(sys.meta_path)), \
                source_imports.current_workspace_source_imports([self.root]):
            position = next(i for i, item in enumerate(sys.meta_path) if item is importlib.machinery.PathFinder)
            del sys.meta_path[position]
            with self.assertRaises(ModuleNotFoundError):
                importlib.import_module(name)
            sys.meta_path.insert(position, importlib.machinery.PathFinder)
            self.assertEqual(importlib.import_module(name).value, 'new')

    def require_posix_parent_semantics(self):
        if os.name != 'posix':
            self.skipTest('POSIX symlink/parent traversal case')

    def test_parent_traversal_after_link_cannot_expand_workspace_scope(self):
        self.require_posix_parent_semantics()
        name = 'djls_scope_dot_escape'
        source, bytecode, encoded = self.stale_source(self.dependency, name, 'depold', 'depnew')
        leaf = self.dependency / 'leaf'
        leaf.mkdir()
        link = self.root / 'jump'
        link.symlink_to(leaf, target_is_directory=True)
        imported = link / '..'
        with mock.patch.object(sys, 'path', [str(imported), *sys.path]), \
                source_imports.current_workspace_source_imports([self.root]):
            module = importlib.import_module(name)
        self.assertEqual(module.value, 'depold')
        self.assertIs(type(module.__loader__), importlib.machinery.SourceFileLoader)
        self.assertEqual(module.__file__, str(imported / source.name))
        self.assertEqual(bytecode.read_bytes(), encoded)

    def test_parent_traversal_into_workspace_reads_current_source(self):
        self.require_posix_parent_semantics()
        name = 'djls_scope_dot_enter'
        source, bytecode, encoded = self.stale_source(self.root, name)
        leaf = self.root / 'leaf'
        leaf.mkdir()
        other = self.base / 'outside'
        other.mkdir()
        link = other / 'jump'
        link.symlink_to(leaf, target_is_directory=True)
        imported = link / '..'
        with mock.patch.object(sys, 'path', [str(imported), *sys.path]), \
                source_imports.current_workspace_source_imports([self.root]):
            module = importlib.import_module(name)
        self.assertEqual(module.value, 'new')
        self.assertEqual(module.__file__, str(imported / source.name))
        self.assertEqual(bytecode.read_bytes(), encoded)

    def test_parent_traversal_in_declared_root_uses_actual_directory(self):
        self.require_posix_parent_semantics()
        leaf = self.dependency / 'leaf'
        leaf.mkdir()
        link = self.root / 'jump'
        link.symlink_to(leaf, target_is_directory=True)
        configured = link / '..'
        for directory, name, expected in ((self.dependency, 'djls_scope_root_actual', 'new'),
                                           (self.root, 'djls_scope_root_lexical', 'old')):
            with self.subTest(directory=directory.name):
                source, bytecode, encoded = self.stale_source(directory, name)
                with source_imports.current_workspace_source_imports([configured]):
                    module = importlib.import_module(name)
                self.assertEqual(module.value, expected)
                self.assertEqual(module.__file__, str(source))
                self.assertEqual(bytecode.read_bytes(), encoded)

    def test_relative_declared_root_keeps_parent_traversal_order(self):
        self.require_posix_parent_semantics()
        name = 'djls_scope_relative_root'
        source, bytecode, encoded = self.stale_source(self.dependency, name)
        leaf = self.dependency / 'leaf'
        leaf.mkdir()
        (self.root / 'jump').symlink_to(leaf, target_is_directory=True)
        with contextlib.chdir(self.base), \
                source_imports.current_workspace_source_imports([Path('workspace/jump/..')]):
            module = importlib.import_module(name)
        self.assertEqual(module.value, 'new')
        self.assertEqual(bytecode.read_bytes(), encoded)

    def test_logical_workspace_file_links_survive_parent_and_root_aliases(self):
        self.require_posix_parent_semantics()
        regular = self.root / 'regular'
        regular.mkdir()
        alias = self.base / 'workspace-root-alias'
        alias.symlink_to(self.root, target_is_directory=True)
        for number, (configured, imported) in enumerate(((self.root, regular / '..'),
                (regular / '..', self.root), (alias, self.root))):
            with self.subTest(number=number):
                name = 'djls_scope_link_' + str(number)
                self.names.append(name)
                target = self.dependency / (name + '.py')
                target.write_text("value='old'\n")
                link = self.root / target.name
                link.symlink_to(target)
                bytecode = Path(py_compile.compile(str(link), doraise=True,
                    invalidation_mode=py_compile.PycInvalidationMode.TIMESTAMP))
                stamp, encoded = target.stat(), bytecode.read_bytes()
                target.write_text("value='new'\n")
                os.utime(target, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
                with mock.patch.object(sys, 'path', [str(imported), *sys.path]), \
                        source_imports.current_workspace_source_imports([configured]):
                    module = importlib.import_module(name)
                self.assertEqual(module.value, 'new')
                self.assertEqual(module.__file__, str(imported / target.name))
                self.assertEqual(bytecode.read_bytes(), encoded)

    def test_finder_insertion_failure_rolls_back_only_its_marker(self):
        class FailedInsertion(list):
            armed = True
            def insert(self, index, item):
                super().insert(index, item)
                if item is source_imports._finder and self.armed:
                    self.armed = False
                    raise MemoryError('partial finder insertion')
        meta = FailedInsertion(sys.meta_path)
        name = 'djls_scope_insert_retry'
        self.stale_source(self.root, name)
        with mock.patch.object(sys, 'meta_path', meta):
            before = self.identities()
            with self.assertRaisesRegex(MemoryError, 'partial finder insertion'):
                with source_imports.current_workspace_source_imports([self.root]):
                    self.fail('Partial insertion yielded')
            self.assertEqual(self.identities(), before)
            self.assertFalse(source_imports._finder.roots)
            with source_imports.current_workspace_source_imports([self.root]):
                self.assertEqual(importlib.import_module(name).value, 'new')
            self.assertEqual(self.identities(), before)

    def test_failed_finder_repair_preserves_outer_owner_counts(self):
        class FailedInsertion(list):
            armed = False
            def insert(self, index, item):
                super().insert(index, item)
                if item is source_imports._finder and self.armed:
                    self.armed = False
                    raise MemoryError('failed finder repair')
        meta = FailedInsertion(sys.meta_path)
        with mock.patch.object(sys, 'meta_path', meta), \
                source_imports.current_workspace_source_imports([self.root]):
            meta[:] = [item for item in meta if item is not source_imports._finder]
            before, expected = self.identities(), Counter(source_imports._finder.roots)
            meta.armed = True
            with self.assertRaisesRegex(MemoryError, 'failed finder repair'):
                with source_imports.current_workspace_source_imports([self.external]):
                    self.fail('Failed repair yielded')
            self.assertEqual(self.identities(), before)
            self.assertEqual(source_imports._finder.roots, expected)
            with source_imports.current_workspace_source_imports([self.external]):
                self.assertEqual(sum(item is source_imports._finder for item in meta), 1)
            self.assertEqual(source_imports._finder.roots, expected)

    def test_partial_failure_does_not_revoke_another_threads_owner(self):
        entered, release = threading.Event(), threading.Event()
        failures = []
        name = 'djls_scope_other_thread'
        self.stale_source(self.root, name)
        def own_scope():
            try:
                with source_imports.current_workspace_source_imports([self.root]):
                    entered.set()
                    if not release.wait(3):
                        raise AssertionError('Other source owner was not released')
            except BaseException as error:
                failures.append(error)
        with mock.patch.object(sys, 'meta_path', list(sys.meta_path)):
            before = self.identities()
            owner = threading.Thread(target=own_scope, daemon=True)
            owner.start()
            try:
                self.assertTrue(entered.wait(3))
                expected = Counter(source_imports._finder.roots)
                with mock.patch.object(source_imports._finder, 'roots', _PartialCounter(expected)):
                    _PartialCounter.armed = True
                    self.addCleanup(setattr, _PartialCounter, 'armed', False)
                    with self.assertRaisesRegex(MemoryError, 'partial source registration'):
                        with source_imports.current_workspace_source_imports([self.external]):
                            self.fail('Failed concurrent registration yielded')
                    self.assertEqual(source_imports._finder.roots, expected)
                    self.assertEqual(importlib.import_module(name).value, 'new')
            finally:
                release.set()
                owner.join(3)
            self.assertFalse(owner.is_alive())
            self.assertEqual(failures, [])
            self.assertFalse(source_imports._finder.roots)
            self.assertEqual(self.identities(), before)

    def test_active_outer_scope_does_not_retain_obsolete_root_generation(self):
        with source_imports.current_workspace_source_imports([self.root]):
            previous = weakref.ref(source_imports._finder.roots)
            with source_imports.current_workspace_source_imports([self.external]):
                self.assertIsNone(previous(), 'Active scope retained its obsolete roots dictionary')


if __name__ == '__main__':
    unittest.main()
