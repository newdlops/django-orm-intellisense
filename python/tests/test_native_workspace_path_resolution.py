import ctypes
import os
import sys
import tempfile
import unittest
import weakref
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from django_orm_intellisense.features import orm_members as members


class NativeWorkspacePathTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='djls-native-path-tests-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.file = self.root / 'Source.py'
        self.file.write_text('class Sample: pass\n')
        members._native_workspace_path_functions.cache_clear()
        self.addCleanup(members._native_workspace_path_functions.cache_clear)

    def test_canonical_existing_path_matches_pathlib_and_avoids_python_realpath(self):
        path = str(self.file)
        expected = str(self.file.resolve())
        if members._native_workspace_path_functions() is None:
            self.skipTest('Native path API unavailable on this platform')
        with mock.patch('os.path.realpath', side_effect=AssertionError('Canonical path used Python realpath')):
            self.assertEqual(members._canonical_workspace_source_path(path), expected)
        self.assertEqual(members._native_workspace_path_functions.cache_info().currsize, 1)

    def test_case_spelling_keeps_existing_pathlib_output(self):
        folder = self.root / 'CaseDir'; folder.mkdir()
        (folder / 'Mixed.py').write_text('value = 1\n')
        for path in [str(self.root / 'casedir' / 'mixed.py'), str(folder / 'mixed.py')]:
            expected = str(Path(path).resolve())
            original = os.path.realpath
            with mock.patch('os.path.realpath', wraps=original) as fallback:
                self.assertEqual(members._canonical_workspace_source_path(path), expected)
            self.assertTrue(fallback.called)

    def test_null_native_result_falls_back_without_freeing_unowned_memory(self):
        realpath = mock.Mock(return_value=None)
        string_at, free = mock.Mock(), mock.Mock()
        with mock.patch.object(members, '_native_workspace_path_functions', return_value=(realpath, string_at, free)):
            self.assertEqual(members._canonical_workspace_source_path(str(self.file)), str(self.file.resolve()))
        string_at.assert_not_called(); free.assert_not_called()

    def test_allocated_native_result_is_freed_once_for_match_and_mismatch(self):
        for output, expected in [(os.fsencode(self.file), True), (b'/different/path.py', False)]:
            pointer = 123
            realpath, string_at, free = mock.Mock(return_value=pointer), mock.Mock(return_value=output), mock.Mock()
            with mock.patch.object(members, '_native_workspace_path_functions', return_value=(realpath, string_at, free)):
                self.assertIs(members._native_workspace_path_is_canonical(str(self.file)), expected)
            realpath.assert_called_once_with(os.fsencode(self.file), None)
            string_at.assert_called_once_with(pointer); free.assert_called_once_with(pointer)

    def test_native_result_is_freed_before_string_extraction_error_propagates(self):
        free = mock.Mock()
        with mock.patch.object(members, '_native_workspace_path_functions',
                return_value=(mock.Mock(return_value=123), mock.Mock(side_effect=MemoryError('copy failed')), free)):
            with self.assertRaisesRegex(MemoryError, 'copy failed'):
                members._native_workspace_path_is_canonical(str(self.file))
        free.assert_called_once_with(123)

    def test_unavailable_native_library_retains_ordinary_resolution(self):
        with mock.patch('ctypes.CDLL', side_effect=OSError('Library unavailable')):
            self.assertIsNone(members._native_workspace_path_functions())
            self.assertEqual(members._canonical_workspace_source_path(str(self.file)), str(self.file.resolve()))

    def test_unsupported_platform_keeps_ordinary_resolver_without_loading_library(self):
        with mock.patch.object(sys, 'platform', 'unsupported-platform'):
            with mock.patch('ctypes.CDLL', side_effect=AssertionError('Unsupported platform loaded native API')):
                self.assertIsNone(members._native_workspace_path_functions())
                self.assertEqual(members._canonical_workspace_source_path(str(self.file)), str(self.file.resolve()))

    def test_null_and_owner_bearing_string_inputs_keep_normal_errors_and_release(self):
        class Owner: pass
        class Text(str): pass
        owner = Owner(); reference = weakref.ref(owner)
        path = Text(str(self.file)); path.owner = owner
        with mock.patch.object(members, '_native_workspace_path_functions', side_effect=AssertionError('Non-exact path reached native API')):
            actual = members._canonical_workspace_source_path(path)
            with self.assertRaises(ValueError): members._canonical_workspace_source_path(str(self.file) + '\x00suffix')
        self.assertEqual(actual, str(self.file))
        self.assertIs(type(actual), str)
        del path, owner
        self.assertIsNone(reference())

    def test_unicode_missing_alias_relative_and_loop_cases_match_pathlib(self):
        unicode_file = self.root / '한글-源.py'; unicode_file.write_text('value = 1\n')
        alias = self.root / 'alias.py'; alias.symlink_to(unicode_file)
        dangling = self.root / 'dangling.py'; dangling.symlink_to(self.root / 'missing' / 'target.py')
        first, second = self.root / 'loop-a', self.root / 'loop-b'
        first.symlink_to(second); second.symlink_to(first)
        paths = [str(unicode_file), str(alias), str(dangling), str(first), os.path.relpath(alias),
            str(self.root / 'missing' / '..' / self.file.name), str(self.file) + '/', '']
        for path in paths:
            with self.subTest(path=path):
                try: expected = str(Path(path).resolve())
                except Exception as error:
                    with self.assertRaises(type(error)) as actual: members._canonical_workspace_source_path(path)
                    self.assertEqual(str(actual.exception), str(error))
                else: self.assertEqual(members._canonical_workspace_source_path(path), expected)
        alias.unlink(); alias.symlink_to(self.file)
        self.assertEqual(members._canonical_workspace_source_path(str(alias)), str(self.file))

    def test_concurrent_readers_keep_exact_membership_without_retaining_index_owners(self):
        class Owner: pass
        paths = []
        for number in range(50):
            path = self.root / ('file' + str(number) + '.py'); path.write_text('value = 1\n'); paths.append(str(path))
        with ThreadPoolExecutor(max_workers=4) as pool:
            actual = list(pool.map(members._canonical_workspace_source_path, paths * 4))
        self.assertEqual(actual, [str(Path(path).resolve()) for path in paths * 4])
        index = Owner(); index.modules = {str(number): SimpleNamespace(file_path=path) for number, path in enumerate(paths)}
        index._workspace_source_paths = index._workspace_source_paths_by_module = index._workspace_source_path_counts = None
        reference = weakref.ref(index)
        membership = members._workspace_files(index)
        self.assertEqual(membership, frozenset(paths))
        del index
        self.assertIsNone(reference())


if __name__ == '__main__': unittest.main()
