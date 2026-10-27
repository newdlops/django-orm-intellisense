"""Snapshot allocation reuse requires fresh inventory and all stat identities."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from django_orm_intellisense.discovery import workspace


class SourceSnapshotRevalidationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='djls-snapshot-revalidate-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.root = self.base / 'workspace'
        self.root.mkdir()
        self.source = self.root / 'models.py'
        self.source.write_text('kind="CharField"\n')
        self.helper = self.root / 'helper.py'
        self.helper.write_text('value=1\n')

    def scan(self, previous=None, extra=None):
        return workspace.snapshot_python_sources(self.root, extra, max_workers=1,
                                                  previous_snapshot=previous)

    def test_unchanged_snapshot_reuses_allocations_only_after_stat_of_every_current_file(self):
        previous = self.scan()
        stat = Path.stat
        calls = []

        def current_stat(path, *args, **kwargs):
            calls.append(path)
            return stat(path, *args, **kwargs)

        with mock.patch.object(Path, 'stat', current_stat), \
                mock.patch.object(workspace.os, 'walk', wraps=workspace.os.walk) as inventory, \
                mock.patch.object(workspace, '_file_fingerprint', side_effect=AssertionError('Unchanged identity was rehashed')), \
                mock.patch.object(workspace, '_build_directory_fingerprints', side_effect=AssertionError('Unchanged directory tree was rehashed')):
            result = self.scan(previous)
        self.assertIs(result, previous)
        inventory.assert_called_once_with(self.root)
        self.assertEqual(calls, list(previous.files))
        self.assertEqual(result.to_cache_dict(), previous.to_cache_dict())

    def test_same_size_restored_mtime_change_rehashes_changed_entry_and_reuses_others(self):
        previous = self.scan()
        stamp = self.source.stat()
        self.source.write_text('kind="DateField"\n')
        os.utime(self.source, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        with mock.patch.object(workspace, '_file_fingerprint', wraps=workspace._file_fingerprint) as fingerprint:
            actual = self.scan(previous)
        self.assertEqual(fingerprint.call_count, 1)
        self.assertNotEqual(actual.fingerprint, previous.fingerprint)
        self.assertEqual(actual.to_cache_dict(), self.scan().to_cache_dict())
        self.assertIs(actual.entries_by_path['helper.py'], previous.entries_by_path['helper.py'])
        self.assertEqual(previous.entries_by_path['models.py'].fingerprint,
                         previous.to_cache_dict()['entries'][1]['fingerprint'])

    def test_replacement_with_same_size_and_mtime_changes_file_identity(self):
        previous = self.scan()
        stamp = self.source.stat()
        replacement = self.root / 'replacement.tmp'
        replacement.write_text('kind="DateField"\n')
        os.utime(replacement, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        replacement.replace(self.source)
        actual = self.scan(previous)
        self.assertNotEqual(actual.fingerprint, previous.fingerprint)
        self.assertEqual(actual.to_cache_dict(), self.scan().to_cache_dict())

    def test_new_deleted_and_renamed_files_force_current_inventory(self):
        previous = self.scan()
        for operation in [lambda: (self.root / 'new.py').write_text('value=2\n'),
                          lambda: self.helper.unlink(),
                          lambda: self.source.rename(self.root / 'renamed.py')]:
            operation()
            actual = self.scan(previous)
            self.assertIsNot(actual, previous)
            self.assertNotEqual(actual.fingerprint, previous.fingerprint)
            self.assertEqual(actual.to_cache_dict(), self.scan().to_cache_dict())
            previous = actual

    def test_removed_or_new_editable_root_changes_snapshot_even_when_workspace_is_unchanged(self):
        external = self.base / 'library'
        external.mkdir()
        source = external / 'models.py'
        source.write_text('value=1\n')
        previous = self.scan(extra=[external])
        self.assertIs(self.scan(previous, [external, external]), previous)
        self.assertEqual(self.scan(previous).to_cache_dict(), self.scan().to_cache_dict())
        source.write_text('value=2\n')
        actual = self.scan(previous, [external])
        self.assertNotEqual(actual.fingerprint, previous.fingerprint)
        self.assertEqual(actual.to_cache_dict(), self.scan(extra=[external]).to_cache_dict())

    def test_deserialized_snapshot_has_no_inprocess_identity_and_cannot_skip_hashing(self):
        previous = self.scan()
        restored = workspace.PythonSourceSnapshot.from_cache_dict(previous.to_cache_dict())
        self.assertIsNone(restored._file_identities)
        with mock.patch.object(workspace, '_file_fingerprint', wraps=workspace._file_fingerprint) as fingerprint:
            actual = self.scan(restored)
        self.assertEqual(fingerprint.call_count, len(previous.files))
        self.assertIsNot(actual, restored)
        self.assertEqual(actual.to_cache_dict(), previous.to_cache_dict())

    def test_stat_failure_cannot_reuse_full_previous_inventory(self):
        previous = self.scan()
        stat = Path.stat

        def fail(path, *args, **kwargs):
            if path == self.source:
                raise PermissionError('injected stat failure')
            return stat(path, *args, **kwargs)

        with mock.patch.object(Path, 'stat', fail):
            actual = self.scan(previous)
        self.assertIsNot(actual, previous)
        self.assertEqual(actual.file_count, 1)
        self.assertNotEqual(actual.fingerprint, previous.fingerprint)
        self.assertEqual(actual.files, (self.helper,))

    def test_mismatched_root_and_symlink_retarget_use_current_source(self):
        external = self.base / 'library'
        external.mkdir()
        a, b = external / 'a.txt', external / 'b.txt'
        a.write_text('value=1\n')
        b.write_text('value=2\n')
        stamp = a.stat()
        os.utime(b, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        self.source.unlink()
        self.source.symlink_to(a)
        previous = self.scan()
        self.source.unlink()
        self.source.symlink_to(b)
        actual = self.scan(previous)
        self.assertNotEqual(actual.fingerprint, previous.fingerprint)
        self.assertEqual(actual.to_cache_dict(), self.scan().to_cache_dict())
        alias = self.base / 'alias'
        alias.symlink_to(self.root, target_is_directory=True)
        self.assertEqual(workspace.snapshot_python_sources(alias, previous_snapshot=actual).to_cache_dict(),
                         workspace.snapshot_python_sources(alias).to_cache_dict())

    def test_relative_parent_unicode_and_ordering_paths_match_full_inventory(self):
        (self.root / 'a').mkdir()
        (self.root / 'a' / '한글.py').write_text('value=1\n')
        (self.root / 'a.py').write_text('value=2\n')
        for root in [self.root, Path(os.path.relpath(self.root)), self.root / '..' / 'workspace']:
            previous = workspace.snapshot_python_sources(root)
            current = workspace.snapshot_python_sources(root, previous_snapshot=previous)
            self.assertEqual(current.to_cache_dict(), previous.to_cache_dict())
            self.assertEqual(current.files, previous.files)

    def test_overlapping_extra_root_and_non_directory_extra_preserve_full_inventory(self):
        nested = self.root / 'nested'
        nested.mkdir()
        (nested / 'model.py').write_text('value=1\n')
        extra = [self.source, nested, self.root, nested]
        previous = self.scan(extra=extra)
        current = self.scan(previous, extra)
        self.assertEqual(current.to_cache_dict(), self.scan(extra=extra).to_cache_dict())
        self.assertEqual(current.files, previous.files)

    def test_removed_root_or_walk_error_cannot_reuse_previous_files(self):
        previous = self.scan()
        self.source.unlink()
        self.helper.unlink()
        self.root.rmdir()
        current = self.scan(previous)
        self.assertEqual(current.file_count, 0)
        self.assertIsNot(current, previous)
        self.assertEqual(current.to_cache_dict(), self.scan().to_cache_dict())

    def test_identity_packing_preserves_out_of_range_values_without_losing_change_detection(self):
        values = dict(st_size=2**80, st_mtime_ns=-(2**80), st_ctime_ns=2**81,
                      st_dev=2**90, st_ino=-(2**70))
        identity = workspace._source_stat_identity(mock.Mock(**values))
        self.assertEqual(identity, tuple(values.values()))
        changed = dict(values, st_ctime_ns=values['st_ctime_ns'] + 1)
        self.assertNotEqual(workspace._source_stat_identity(mock.Mock(**changed)), identity)
        small = mock.Mock(st_size=10, st_mtime_ns=20, st_ctime_ns=30, st_dev=40, st_ino=50)
        packed = workspace._source_stat_identity(small)
        self.assertEqual(len(packed), 40)
        self.assertEqual(workspace._SOURCE_IDENTITY.unpack(packed), (10, 20, 30, 40, 50))


if __name__ == '__main__':
    unittest.main()
