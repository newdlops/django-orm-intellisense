import tempfile
import unittest
from pathlib import Path
from unittest import mock

from django_orm_intellisense.cache import store
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.static_index.indexer import build_static_index


class CacheReuseFingerprintTests(unittest.TestCase):
    def test_matching_file_fingerprints_skip_redundant_directory_checks_for_modules_and_tombstones(self):
        with tempfile.TemporaryDirectory(prefix='djls-cache-reuse-fingerprint-') as temporary:
            root = Path(temporary).resolve()
            (root / 'model.py').write_text('from django.db import models\nclass Post(models.Model):\n    value=models.CharField()\n')
            (root / 'broken.py').write_text('class Broken(\n')
            snapshot = snapshot_python_sources(root)
            index = build_static_index(root, snapshot.files)
            modules = {Path(module.file_path).relative_to(root).as_posix(): {
                'fileFingerprint': snapshot.entries_by_path[Path(module.file_path).relative_to(root).as_posix()].fingerprint,
                'moduleIndex': module.to_dict()} for module in index.modules.values()}
            failed = {'broken.py': {'fileFingerprint': snapshot.entries_by_path['broken.py'].fingerprint,
                                    'errorKind': 'SyntaxError'}}
            with mock.patch.object(store, '_is_under_unchanged_tree',
                                   side_effect=AssertionError('Exact file identity redundantly checked directory tree')):
                reused = store._load_reusable_module_indices(cached_module_entries=modules,
                    cached_directory_fingerprints={}, source_snapshot=snapshot)
                tombstones = store._load_reusable_unparseable_entries(cached_unparseable_entries=failed,
                    cached_directory_fingerprints={}, source_snapshot=snapshot)
            self.assertEqual({name: module.to_dict() for name, module in reused.items()},
                             {name: payload['moduleIndex'] for name, payload in modules.items()})
            self.assertEqual(tombstones, {'broken.py': 'SyntaxError'})

    def test_mismatched_file_fingerprint_keeps_tree_fallback_and_actual_source_edits_reparse(self):
        with tempfile.TemporaryDirectory(prefix='djls-cache-reuse-tree-') as temporary:
            root = Path(temporary).resolve()
            (root / 'pkg').mkdir()
            source = root / 'pkg' / 'models.py'
            original = 'from django.db import models\nclass Post(models.Model):\n    value=models.CharField()\n'
            source.write_text(original)
            (root / 'pkg' / 'helper.py').write_text('VALUE=1\n')
            snapshot = snapshot_python_sources(root)
            index = build_static_index(root, snapshot.files)
            entries = {'pkg/models.py': {'fileFingerprint': 'different',
                'moduleIndex': index.modules['pkg.models'].to_dict()}}
            with mock.patch.object(store, '_is_under_unchanged_tree', wraps=store._is_under_unchanged_tree) as checked:
                reused = store._load_reusable_module_indices(cached_module_entries=entries,
                    cached_directory_fingerprints=snapshot.directory_fingerprints, source_snapshot=snapshot)
            self.assertIn('pkg/models.py', reused)
            checked.assert_called_once()
            cache = root.parent / (root.name + '-cache')
            with mock.patch.object(store, '_workspace_cache_dir', return_value=cache):
                store.save_static_index(root, snapshot, index)
                source.write_text(original.replace('CharField', 'DateField'))
                current = snapshot_python_sources(root)
                loaded, kind = store.load_cached_static_index(root, current)
                self.assertEqual(kind, 'partial')
                self.assertEqual(loaded.find_field('pkg.Post', 'value').field_kind, 'DateField')
                self.assertEqual(loaded.to_cache_dict(), build_static_index(root, current.files).to_cache_dict())
            self.assertEqual(index.find_field('pkg.Post', 'value').field_kind, 'CharField')


if __name__ == '__main__':
    unittest.main()
