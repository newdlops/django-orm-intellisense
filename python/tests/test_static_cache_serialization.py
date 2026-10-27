"""Both static-cache formats reuse one immutable module serialization."""
from collections import Counter
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from django_orm_intellisense.cache import store
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.static_index.indexer import build_static_index


class StaticCacheSerializationTests(unittest.TestCase):
    def test_module_payload_is_built_once_and_both_cache_paths_restore_complete_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve() / 'project'
            package = root / 'blog'
            package.mkdir(parents=True)
            (package / '__init__.py').write_text('')
            path = package / 'models.py'
            original = 'from django.db import models\nclass Post(models.Model):\n    value = models.CharField()\n'
            path.write_text(original)
            (package / 'helper.py').write_text('VALUE = [1, "한글"]\n')
            (package / 'broken.py').write_text('class Broken(\n')
            snapshot = snapshot_python_sources(root)
            index = build_static_index(root, snapshot.files)
            expected = index.to_cache_dict()
            calls = Counter()
            original_to_dict = store.module_to_row
            def recorded(module):
                calls[module.module_name] += 1
                return original_to_dict(module)
            cache = root.parent / 'cache'
            with mock.patch.object(store, '_workspace_cache_dir', return_value=cache):
                with mock.patch.object(store, 'module_to_row', recorded):
                    store.save_static_index(root, snapshot, index)
                self.assertEqual(calls, {name: 1 for name in index.modules},
                                 'Partial and full cache serializers rebuilt the same module payload')
                partial = store._read_cache_payload(cache / store.STATIC_INDEX_CACHE_NAME)
                full = store._read_cache_payload(cache / store.STATIC_INDEX_FULL_CACHE_NAME)
                self.assertEqual(full['payload'], expected)
                for name, module in index.modules.items():
                    relative = Path(module.file_path).relative_to(root).as_posix()
                    self.assertEqual(partial['payload']['moduleEntries'][relative]['moduleIndex'], expected['modules'][name])
                self.assertEqual(partial['payload']['unparseableEntries']['blog/broken.py']['errorKind'], 'SyntaxError')
                loaded, hit = store.load_cached_static_index(root, snapshot)
                self.assertEqual(hit, 'full')
                self.assertEqual(loaded.to_cache_dict(), expected)
                path.write_text(original.replace('CharField', 'DateField'))
                current = snapshot_python_sources(root)
                loaded, hit = store.load_cached_static_index(root, current)
                self.assertEqual(hit, 'partial')
                self.assertEqual(loaded.find_field('blog.Post', 'value').field_kind, 'DateField')
                self.assertEqual(loaded.to_cache_dict(), build_static_index(root, current.files).to_cache_dict())
            self.assertEqual(index.to_cache_dict(), expected)
