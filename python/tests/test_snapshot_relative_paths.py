import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from django_orm_intellisense.discovery import workspace


class SnapshotRelativePathTests(unittest.TestCase):
    def test_posix_snapshot_avoids_per_file_parent_path_construction(self):
        if os.name != 'posix': self.skipTest('POSIX component comparison optimization')
        with tempfile.TemporaryDirectory(prefix='djls-snapshot-relative-') as temporary:
            root = Path(temporary).resolve()
            nested = root / 'deep' / '한글'
            nested.mkdir(parents=True)
            for number in range(100):
                (nested / f'value_{number}.py').write_text(f'value={number}\n')
            expected = workspace.snapshot_python_sources(root, max_workers=1)
            with mock.patch.object(Path, 'relative_to', side_effect=AssertionError('Snapshot rebuilt parent Paths per file')):
                actual = workspace.snapshot_python_sources(root)
            self.assertEqual(actual, expected)

    def test_lexical_relative_root_parent_segments_and_external_prefix_collision_match_pathlib(self):
        with tempfile.TemporaryDirectory(prefix='djls-snapshot-lexical-') as temporary:
            parent = Path(temporary).resolve()
            root = parent / 'root'
            other = parent / 'root_extra'
            root.mkdir(); other.mkdir()
            (root / 'a.py').write_text('value=1\n')
            (other / 'b.py').write_text('value=2\n')
            (root / 'link.py').symlink_to(other / 'b.py')
            for selected in [root, Path(os.path.relpath(root)), root / '..' / 'root']:
                snapshot = workspace.snapshot_python_sources(selected, [other], max_workers=1)
                expected = []
                for path in snapshot.files:
                    try: expected.append(path.relative_to(selected).as_posix())
                    except ValueError: expected.append(str(path))
                self.assertEqual([entry.relative_path for entry in snapshot.entries], expected)
                self.assertIn(str(other / 'b.py'), expected)
                self.assertEqual(len(snapshot.entries), 3)


if __name__ == '__main__':
    unittest.main()
