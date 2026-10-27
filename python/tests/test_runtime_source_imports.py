"""Current-source runtime imports preserve import ordering and scope."""
import contextlib
import importlib
import importlib.abc
import importlib.machinery
import importlib.util
import os
import py_compile
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from django_orm_intellisense.runtime import source_imports


class RuntimeSourceImportsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='djls-runtime-source-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.root = self.base / 'workspace'
        self.external = self.base / 'editable'
        self.dependency = self.base / 'workspace_extra'
        for root in [self.root, self.external, self.dependency]:
            root.mkdir()
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.object(sys, 'path',
            [str(self.root), str(self.external), str(self.dependency), *sys.path]))
        self.names = []
        self.addCleanup(self.remove_modules)

    def remove_modules(self):
        for name in self.names:
            sys.modules.pop(name, None)
        importlib.invalidate_caches()

    def stale_source(self, directory, name, old='old', new='new'):
        self.names.append(name)
        source = directory / f'{name}.py'
        source.write_text(f'value={old!r}\n')
        bytecode = Path(py_compile.compile(str(source), doraise=True,
            invalidation_mode=py_compile.PycInvalidationMode.TIMESTAMP))
        encoded = bytecode.read_bytes()
        stamp = source.stat()
        source.write_text(f'value={new!r}\n')
        os.utime(source, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        importlib.invalidate_caches()
        return source, bytecode, encoded

    def test_timestamp_bytecode_is_bypassed_for_workspace_and_editable_without_rewriting_it(self):
        source, bytecode, encoded = self.stale_source(self.root, 'djls_stale_workspace')
        external, external_bytecode, external_encoded = self.stale_source(self.external, 'djls_stale_editable')
        self.assertEqual(importlib.import_module('djls_stale_workspace').value, 'old')
        sys.modules.pop('djls_stale_workspace')
        before = list(sys.meta_path)
        with source_imports.current_workspace_source_imports([self.root, self.external]):
            self.assertEqual(importlib.import_module('djls_stale_workspace').value, 'new')
            self.assertEqual(importlib.import_module('djls_stale_editable').value, 'new')
        self.assertEqual(sys.meta_path, before)
        self.assertEqual(bytecode.read_bytes(), encoded)
        self.assertEqual(external_bytecode.read_bytes(), external_encoded)

    def test_prefix_collision_dependency_retains_standard_loader_and_one_pathfinder_lookup(self):
        source, _, _ = self.stale_source(self.dependency, 'djls_dependency_cache')
        original = importlib.machinery.PathFinder.find_spec
        with source_imports.current_workspace_source_imports([self.root]), \
                mock.patch.object(importlib.machinery.PathFinder, 'find_spec', wraps=original) as find:
            module = importlib.import_module('djls_dependency_cache')
        self.assertEqual(module.value, 'old')
        self.assertIs(type(module.__loader__), importlib.machinery.SourceFileLoader)
        self.assertEqual([call.args[0] for call in find.call_args_list].count('djls_dependency_cache'), 1)

    def test_nested_contexts_restore_only_after_last_owner_and_exceptions_release_finder(self):
        self.stale_source(self.root, 'djls_nested_source')
        before = list(sys.meta_path)
        with self.assertRaisesRegex(RuntimeError, 'injected'):
            with source_imports.current_workspace_source_imports([self.root]):
                with source_imports.current_workspace_source_imports([self.root, self.external]):
                    self.assertEqual(sys.meta_path.count(source_imports._finder), 1)
                self.assertIn(source_imports._finder, sys.meta_path)
                self.assertEqual(importlib.import_module('djls_nested_source').value, 'new')
                raise RuntimeError('injected')
        self.assertEqual(sys.meta_path, before)
        self.assertFalse(source_imports._finder.roots)

    def test_custom_finder_before_pathfinder_keeps_precedence(self):
        self.stale_source(self.root, 'djls_custom_finder')

        class Loader(importlib.abc.Loader):
            def create_module(self, spec):
                return None

            def exec_module(self, module):
                module.value = 'custom'

        class Finder(importlib.abc.MetaPathFinder):
            def find_spec(self, fullname, path=None, target=None):
                if fullname == 'djls_custom_finder':
                    return importlib.util.spec_from_loader(fullname, Loader())
                return None

        finder = Finder()
        with mock.patch.object(sys, 'meta_path', [finder, *sys.meta_path]), \
                source_imports.current_workspace_source_imports([self.root]):
            self.assertEqual(importlib.import_module('djls_custom_finder').value, 'custom')

    def test_deleted_source_is_not_revived_from_timestamp_bytecode(self):
        source, bytecode, encoded = self.stale_source(self.root, 'djls_deleted_source')
        source.unlink()
        importlib.invalidate_caches()
        with source_imports.current_workspace_source_imports([self.root]):
            with self.assertRaises(ModuleNotFoundError):
                importlib.import_module('djls_deleted_source')
        self.assertEqual(bytecode.read_bytes(), encoded)

    def test_canonical_root_reads_current_source_through_symlink_import_path(self):
        source, bytecode, encoded = self.stale_source(self.root, 'djls_source_alias_import')
        alias = self.base / 'workspace-alias'
        alias.symlink_to(self.root, target_is_directory=True)
        with mock.patch.object(sys, 'path', [str(alias), *sys.path]), \
                source_imports.current_workspace_source_imports([self.root]):
            module = importlib.import_module('djls_source_alias_import')
        self.assertEqual(module.value, 'new')
        self.assertEqual(module.__file__, str(alias / source.name))
        self.assertEqual(bytecode.read_bytes(), encoded)

    def test_symlink_root_reads_current_source_through_canonical_import_path(self):
        source, bytecode, encoded = self.stale_source(self.root, 'djls_source_alias_root')
        alias = self.base / 'workspace-alias'
        alias.symlink_to(self.root, target_is_directory=True)
        with source_imports.current_workspace_source_imports([alias]):
            module = importlib.import_module('djls_source_alias_root')
        self.assertEqual(module.value, 'new')
        self.assertEqual(module.__file__, str(source))
        self.assertEqual(bytecode.read_bytes(), encoded)

    def test_alias_added_after_scope_entry_is_not_a_frozen_search_path_snapshot(self):
        source, bytecode, encoded = self.stale_source(self.root, 'djls_source_alias_late')
        with source_imports.current_workspace_source_imports([self.root]):
            alias = self.base / 'late-alias'
            alias.symlink_to(self.root, target_is_directory=True)
            with mock.patch.object(sys, 'path', [str(alias), *sys.path]):
                module = importlib.import_module('djls_source_alias_late')
        self.assertEqual(module.value, 'new')
        self.assertEqual(module.__file__, str(alias / source.name))
        self.assertEqual(bytecode.read_bytes(), encoded)

    def test_retargeted_import_alias_uses_current_membership_for_each_import(self):
        for order in ((self.root, self.dependency), (self.dependency, self.root)):
            with self.subTest(order=[path.name for path in order]):
                name = 'djls_source_retarget_' + order[0].name
                source, bytecode, encoded = self.stale_source(self.root, name)
                other, other_bytecode, other_encoded = self.stale_source(self.dependency, name, 'depold', 'depnew')
                alias = self.base / ('alias-' + order[0].name)
                alias.symlink_to(order[0], target_is_directory=True)
                with mock.patch.object(sys, 'path', [str(alias), *sys.path]), \
                        source_imports.current_workspace_source_imports([self.root]):
                    for number, target in enumerate(order):
                        if number:
                            sys.modules.pop(name)
                            alias.unlink()
                            alias.symlink_to(target, target_is_directory=True)
                            importlib.invalidate_caches()
                        module = importlib.import_module(name)
                        self.assertEqual(module.value, 'new' if target == self.root else 'depold')
                        self.assertEqual(module.__file__, str(alias / source.name))
                        if target == self.dependency:
                            self.assertIs(type(module.__loader__), importlib.machinery.SourceFileLoader)
                self.assertEqual(bytecode.read_bytes(), encoded)
                self.assertEqual(other_bytecode.read_bytes(), other_encoded)

    def test_case_alias_on_case_insensitive_filesystem_reads_current_source(self):
        alias = self.root.with_name(self.root.name.upper())
        if not alias.exists() or not os.path.samefile(alias, self.root):
            self.skipTest('Filesystem does not expose this case alias')
        for number, (configured, imported) in enumerate(((self.root, alias), (alias, self.root))):
            with self.subTest(configured=configured.name):
                name = 'djls_source_case_' + str(number)
                source, bytecode, encoded = self.stale_source(self.root, name)
                with mock.patch.object(sys, 'path', [str(imported), *sys.path]), \
                        source_imports.current_workspace_source_imports([configured]):
                    module = importlib.import_module(name)
                self.assertEqual(module.value, 'new')
                self.assertEqual(module.__file__, str(imported / source.name))
                self.assertEqual(bytecode.read_bytes(), encoded)

    def test_retargeted_configured_root_revokes_old_canonical_directory(self):
        name = 'djls_source_root_retarget'
        source, bytecode, encoded = self.stale_source(self.root, name)
        other, other_bytecode, other_encoded = self.stale_source(self.dependency, name, 'depold', 'depnew')
        alias = self.base / 'configured-root'
        alias.symlink_to(self.root, target_is_directory=True)
        with source_imports.current_workspace_source_imports([alias]):
            self.assertEqual(importlib.import_module(name).value, 'new')
            sys.modules.pop(name)
            alias.unlink()
            alias.symlink_to(self.dependency, target_is_directory=True)
            importlib.invalidate_caches()
            old_root = importlib.import_module(name)
            self.assertEqual(old_root.value, 'old')
            self.assertIs(type(old_root.__loader__), importlib.machinery.SourceFileLoader)
            sys.modules.pop(name)
            with mock.patch.object(sys, 'path', [str(self.dependency), *sys.path]):
                self.assertEqual(importlib.import_module(name).value, 'depnew')
        self.assertEqual(bytecode.read_bytes(), encoded)
        self.assertEqual(other_bytecode.read_bytes(), other_encoded)

    def test_unicode_normalization_alias_keeps_actual_import_filename(self):
        canonical = self.base / 'caf\u00e9'
        alias = self.base / 'cafe\u0301'
        canonical.mkdir()
        if not alias.exists() or not os.path.samefile(alias, canonical):
            self.skipTest('Filesystem does not expose this normalization alias')
        for number, (configured, imported) in enumerate(((canonical, alias), (alias, canonical))):
            with self.subTest(configured=str(configured)):
                name = 'djls_source_unicode_' + str(number)
                source, bytecode, encoded = self.stale_source(canonical, name)
                with mock.patch.object(sys, 'path', [str(imported), *sys.path]), \
                        source_imports.current_workspace_source_imports([configured]):
                    module = importlib.import_module(name)
                self.assertEqual(module.value, 'new')
                self.assertEqual(module.__file__, str(imported / source.name))
                self.assertEqual(bytecode.read_bytes(), encoded)

    def test_alias_at_a_different_directory_depth_reads_current_source(self):
        source, bytecode, encoded = self.stale_source(self.root, 'djls_source_deep_alias')
        alias = self.base / 'nested/deeper/project'
        alias.parent.mkdir(parents=True)
        alias.symlink_to(self.root, target_is_directory=True)
        with mock.patch.object(sys, 'path', [str(alias), *sys.path]), \
                source_imports.current_workspace_source_imports([self.root]):
            module = importlib.import_module('djls_source_deep_alias')
        self.assertEqual(module.value, 'new')
        self.assertEqual(module.__file__, str(alias / source.name))
        self.assertEqual(bytecode.read_bytes(), encoded)

    def test_workspace_file_symlink_to_external_source_keeps_logical_scope(self):
        name = 'djls_source_file_symlink'
        self.names.append(name)
        source = self.dependency / (name + '.py')
        source.write_text("value='old'\n")
        link = self.root / source.name
        link.symlink_to(source)
        bytecode = Path(py_compile.compile(str(link), doraise=True,
            invalidation_mode=py_compile.PycInvalidationMode.TIMESTAMP))
        encoded, stamp = bytecode.read_bytes(), source.stat()
        source.write_text("value='new'\n")
        os.utime(source, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        with source_imports.current_workspace_source_imports([self.root]):
            module = importlib.import_module(name)
        self.assertEqual(module.value, 'new')
        self.assertEqual(module.__file__, str(link))
        self.assertEqual(bytecode.read_bytes(), encoded)

    def test_unconfirmed_case_spelling_cannot_expand_workspace_scope(self):
        alias = self.root.with_name(self.root.name.upper())
        if not alias.exists() or not os.path.samefile(alias, self.root):
            self.skipTest('Filesystem does not expose this case alias')
        for number, failure in enumerate((False, OSError('identity unavailable'))):
            name = 'djls_source_unconfirmed_' + str(number)
            source, bytecode, encoded = self.stale_source(self.root, name)
            identity = (mock.patch.object(os.path, 'samefile', return_value=False) if failure is False
                else mock.patch.object(os.path, 'samefile', side_effect=failure))
            with mock.patch.object(sys, 'path', [str(alias), *sys.path]), identity, \
                    source_imports.current_workspace_source_imports([self.root]):
                module = importlib.import_module(name)
            self.assertEqual(module.value, 'old')
            self.assertIs(type(module.__loader__), importlib.machinery.SourceFileLoader)
            self.assertEqual(bytecode.read_bytes(), encoded)


if __name__ == '__main__':
    unittest.main()
