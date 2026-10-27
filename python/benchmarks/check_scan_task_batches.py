"""Grouped parser tasks preserve inventory, source order and bounded work."""
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from django_orm_intellisense.static_index import indexer
from benchmarks.bench_scan_task_batches import candidate_module


class ScanTaskBatchTests(unittest.TestCase):
    def test_grouped_tasks_preserve_complete_scan_and_use_at_most_eight_tasks_per_window(self):
        with tempfile.TemporaryDirectory(prefix='djls-scan-task-regression-') as temporary:
            root = Path(temporary).resolve()
            package = root / 'app'
            package.mkdir()
            (package / '__init__.py').write_text('')
            (package / 'entity.py').write_text('from django.db import models\nclass Shadow(models.Model):\n    value=models.IntegerField()\n')
            (package / 'entity').mkdir()
            (package / 'entity' / '__init__.py').write_text('from django.db import models\nclass Winner(models.Model):\n    title=models.CharField()\n')
            (package / 'broken.py').write_text('class Broken(\n')
            (package / 'encoding.py').write_bytes(b'\xff\xfe\x00')
            for number in range(140):
                (package / f'helper_{number}.py').write_text(f'value={number}\n')
            files = tuple(sorted(root.rglob('*.py'), reverse=True))
            expected = indexer.build_static_index(root, files).to_cache_dict()
            candidate = candidate_module(8)
            submitted = []
            original = ThreadPoolExecutor.map
            def measured(executor, function, iterable, *args, **kwargs):
                tasks = list(iterable)
                submitted.append(len(tasks))
                return original(executor, function, tasks, *args, **kwargs)
            with mock.patch.object(ThreadPoolExecutor, 'map', measured):
                actual = candidate.build_static_index(root, files)
            self.assertEqual(actual.to_cache_dict(), expected)
            self.assertEqual(actual.python_file_count,
                len(actual.modules) + len(actual.unparseable_files) + len(actual.shadowed_files))
            self.assertEqual(actual.modules['app.entity'].file_path, str(package / 'entity' / '__init__.py'))
            self.assertEqual(actual.unparseable_files['app/broken.py'], 'SyntaxError')
            self.assertEqual(actual.unparseable_files['app/encoding.py'], 'UnicodeDecodeError')
            self.assertTrue(submitted)
            self.assertLessEqual(max(submitted), 8, 'Cold64file window still creates one future per file')
            restored = candidate.StaticIndex.from_cache_dict(actual.to_cache_dict())
            self.assertEqual(restored.to_cache_dict(), actual.to_cache_dict())


if __name__ == '__main__':
    unittest.main()
