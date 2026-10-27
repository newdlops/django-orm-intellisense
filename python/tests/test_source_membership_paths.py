"""Canonical membership keeps lexical aliases and checks every current file."""
import hashlib
import os
import stat
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from django_orm_intellisense.discovery import workspace


def expected_membership(snapshot):
    digest = hashlib.sha256(b'django-orm-source-membership-v1\0')
    digest.update(f'R\0{Path(snapshot.root).resolve(strict=True)}\0'.encode())
    for entry, path in sorted(zip(snapshot.entries, snapshot.files), key=lambda item: item[0].relative_path):
        digest.update(f'F\0{entry.relative_path}\0{path.resolve(strict=True)}\0'.encode())
    return digest.hexdigest()


class SourceMembershipPathTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='djls-membership-paths-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.root = self.base / 'project'
        self.root.mkdir()
        (self.root / 'plain.py').write_text('value=1\n')
        nested = self.root / 'nested'
        nested.mkdir()
        for number in range(80):
            (nested / f'member_{number}.py').write_text(f'value={number}\n')

    def test_relative_dotdot_and_double_anchor_match_independent_resolve(self):
        old_cwd = os.getcwd()
        try:
            os.chdir(self.base)
            for root in (Path('project'), Path('project/nested/..'),
                         Path('//' + str(self.root).lstrip('/'))):
                with self.subTest(root=str(root)):
                    snapshot = workspace.snapshot_python_sources(root, max_workers=1)
                    self.assertEqual(workspace.source_membership_fingerprint(snapshot),
                                     expected_membership(snapshot))
        finally:
            os.chdir(old_cwd)

    def test_root_alias_external_and_file_links_keep_all_current_checks(self):
        external = self.base / 'external'
        external.mkdir()
        target = external / 'target.py'
        target.write_text('value="external"\n')
        (self.root / 'file_link.py').symlink_to(target)
        alias = self.base / 'root_alias'
        alias.symlink_to(self.root, target_is_directory=True)
        snapshot = workspace.snapshot_python_sources(alias, [external, alias / 'nested'], max_workers=1)
        expected = expected_membership(snapshot)
        observed = []
        original = os.lstat

        def current_lstat(path, *args, **kwargs):
            observed.append(os.fspath(path))
            return original(path, *args, **kwargs)

        with mock.patch.object(workspace.os, 'lstat', side_effect=current_lstat):
            self.assertEqual(workspace.source_membership_fingerprint(snapshot), expected)
        self.assertTrue(set(map(str, snapshot.files)).issubset(observed))
        replacement = self.base / 'external/replacement.py'
        os.link(target, replacement)
        new_link = self.root / 'new-link'
        new_link.symlink_to(replacement)
        new_link.replace(self.root / 'file_link.py')
        self.assertNotEqual(workspace.source_membership_fingerprint(snapshot), expected)

    def test_regular_file_at_filesystem_root_uses_root_parent(self):
        entry = workspace.PythonSourceEntry('root-member.py', 0, 0, 'unused')
        expected = hashlib.sha256(b'django-orm-source-membership-v1\0R\0/\0F\0root-member.py\0/root-member.py\0').hexdigest()
        for root in ('/', '//'):
            snapshot = workspace.PythonSourceSnapshot(root, 'unused', (entry,), (Path(root + 'root-member.py'),), {})

            def strict_realpath(path, *, strict):
                self.assertTrue(strict)
                self.assertEqual(path, root)
                return '/'

            with self.subTest(root=root), \
                    mock.patch.object(workspace.os.path, 'realpath', side_effect=strict_realpath), \
                    mock.patch.object(workspace.os, 'lstat', return_value=SimpleNamespace(st_mode=stat.S_IFREG)), \
                    mock.patch.object(workspace.os, 'stat', return_value=SimpleNamespace(st_mode=stat.S_IFDIR)):
                self.assertEqual(workspace.source_membership_fingerprint(snapshot), expected)

    def test_portable_parent_branch_matches_posix_witness(self):
        snapshot = workspace.snapshot_python_sources(self.root, max_workers=1)
        expected = expected_membership(snapshot)
        with mock.patch.object(workspace.os, 'name', 'nt'):
            self.assertEqual(workspace.source_membership_fingerprint(snapshot), expected)

    def test_regular_parent_resolution_error_rejects_complete_witness(self):
        snapshot = workspace.snapshot_python_sources(self.root, max_workers=1)
        original = os.path.realpath

        def strict_realpath(path, *, strict):
            if path == str(self.root / 'nested'):
                raise PermissionError('parent became unreadable')
            return original(path, strict=strict)

        with mock.patch.object(workspace.os.path, 'realpath', side_effect=strict_realpath):
            with self.assertRaises(PermissionError):
                workspace.source_membership_fingerprint(snapshot)


if __name__ == '__main__':
    unittest.main()
