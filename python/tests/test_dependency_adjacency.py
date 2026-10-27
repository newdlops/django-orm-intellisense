import tempfile
import dataclasses
import unittest
from pathlib import Path
from unittest import mock

from django_orm_intellisense.static_index.indexer import (
    ModuleIndex, StaticIndex, build_static_index, reindex_single_file,
)


class DependencyAdjacencyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='djls-dependency-adjacency-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        (self.root / 'blog').mkdir()
        (self.root / 'blog' / '__init__.py').write_text('')

    def write(self, name, content):
        path = self.root / 'blog' / name
        path.write_text(content)
        return path

    def fixture(self):
        self.write('constants.py', 'LIMIT = 30\n')
        self.write('bridge.py', 'from .constants import LIMIT\n')
        self.write('models.py', 'from django.db import models\nfrom .bridge import LIMIT\n'
            'class Post(models.Model):\n    title = models.CharField(max_length=LIMIT)\n')
        self.write('consumer.py', 'from .models import Post\n')
        self.write('cycle_a.py', 'from .cycle_b import value\nvalue = 1\n')
        self.write('cycle_b.py', 'from .cycle_a import value\n')
        return build_static_index(self.root)

    def test_source_and_constructor_queries_scan_imports_once_in_either_order(self):
        for constructor_first in [False, True]:
            with self.subTest(constructor_first=constructor_first):
                index = self.fixture()
                reads = {}
                original = ModuleIndex.__getattribute__
                def read(module, name):
                    if name == 'import_bindings':
                        key = original(module, 'module_name')
                        reads[key] = reads.get(key, 0) + 1
                    return original(module, name)
                with mock.patch.object(ModuleIndex, '__getattribute__', read):
                    if constructor_first:
                        self.assertEqual(index.constructor_dependents('blog.constants'), {'blog.models'})
                        self.assertEqual(index.source_dependents({'blog.constants'}), {'blog.Post'})
                    else:
                        self.assertEqual(index.source_dependents({'blog.constants'}), {'blog.Post'})
                        self.assertEqual(index.constructor_dependents('blog.constants'), {'blog.models'})
                    self.assertEqual(index.source_dependents({'blog.cycle_a'}), set())
                self.assertEqual(reads, {name: 1 for name in index.modules})

    def test_shared_import_adjacency_is_immutable_when_constructor_edges_are_added(self):
        index = self.fixture()
        source_result = index.source_dependents({'blog.constants'})
        adjacency = index._import_dependency_cache.dependents
        before = dict(adjacency)
        self.assertEqual(index.constructor_dependents('blog.constants'), {'blog.models'})
        self.assertEqual(adjacency, before)
        self.assertTrue(all(isinstance(values, frozenset) for values in adjacency.values()))
        self.assertEqual(index.source_dependents({'blog.constants'}), source_result)
        self.assertEqual(index.source_dependents({'blog.models'}), {'blog.Post'})

    def test_import_retarget_and_constructor_change_preserve_old_snapshot_and_match_fresh(self):
        original = self.fixture()
        original.source_dependents({'blog.constants'})
        original.constructor_dependents('blog.constants')
        adjacency = dict(original._import_dependency_cache.dependents)
        constructor = dict(original._constructor_dependency_cache)
        other = self.write('other.py', 'LIMIT = 10\n')
        added, _, _ = reindex_single_file(self.root, other, original)
        bridge = self.root / 'blog' / 'bridge.py'
        bridge.write_text('from .other import LIMIT\n')
        changed, _, _ = reindex_single_file(self.root, bridge, added)
        fresh = build_static_index(self.root)
        for source in ['blog.constants', 'blog.other', 'blog.bridge', 'blog.models']:
            self.assertEqual(changed.source_dependents({source}), fresh.source_dependents({source}))
            self.assertEqual(changed.constructor_dependents(source), fresh.constructor_dependents(source))
        self.assertNotIn('blog.Post', changed.source_dependents({'blog.constants'}))
        self.assertIn('blog.Post', changed.source_dependents({'blog.other'}))
        self.assertEqual(original._import_dependency_cache.dependents, adjacency)
        self.assertEqual(original._constructor_dependency_cache, constructor)
        self.assertEqual(original.constructor_dependents('blog.constants'), {'blog.models'})
        restored = StaticIndex.from_cache_dict(changed.to_cache_dict())
        self.assertEqual(restored.source_dependents({'blog.other'}), changed.source_dependents({'blog.other'}))
        self.assertEqual(restored.constructor_dependents('blog.other'), changed.constructor_dependents('blog.other'))

    def test_constructor_only_dependency_survives_missing_helper_creation_and_deletion(self):
        self.write('models.py', 'from django.db import models\nclass Post(models.Model):\n    title = models.CharField()\n')
        original = build_static_index(self.root)
        # Constructor metadata can refer through frozen qualified references;
        # keep this edge even without an explicit import binding to the module.
        original.modules['blog.models'] = dataclasses.replace(original.modules['blog.models'],
            constructor_imports=('blog.missing.LIMIT',))
        original.source_dependents({'blog.missing'})
        original.constructor_dependents('blog.missing')
        helper = self.write('missing.py', 'LIMIT = 10\n')
        added, _, _ = reindex_single_file(self.root, helper, original)
        self.assertEqual(added.constructor_dependents('blog.missing'), {'blog.models'})
        self.assertEqual(original.constructor_dependents('blog.missing'), {'blog.models'})
        helper.unlink()
        removed, _, _ = reindex_single_file(self.root, helper, added)
        self.assertEqual(removed.constructor_dependents('blog.missing'), {'blog.models'})
        self.assertNotIn('blog.missing', removed.modules)

    def test_real_missing_constant_import_create_edit_delete_matches_fresh_fields(self):
        from django.db import models
        from django_orm_intellisense.runtime.source_fields import field_from_source
        self.write('models.py', 'from django.db import models\nfrom .missing import LIMIT\n'
            'class Post(models.Model):\n    title = models.CharField(max_length=LIMIT)\n')
        original = build_static_index(self.root)
        before = original.to_cache_dict()
        original.source_dependents({'blog.missing'})
        self.assertEqual(original.constructor_dependents('blog.missing'), {'blog.models'})
        helper = self.write('missing.py', 'LIMIT = 10\n')
        created, _, _ = reindex_single_file(self.root, helper, original)
        self.assertEqual(field_from_source(created.find_field('blog.Post', 'title'), models.CharField()).max_length, 10)

        helper.write_text('LIMIT = 20\n')
        edited, _, _ = reindex_single_file(self.root, helper, created)
        self.assertEqual(field_from_source(edited.find_field('blog.Post', 'title'), models.CharField()).max_length, 20)
        helper.unlink()
        removed, _, _ = reindex_single_file(self.root, helper, edited)
        self.assertIsNone(field_from_source(removed.find_field('blog.Post', 'title'), models.CharField()))
        self.assertEqual(removed.fields, build_static_index(self.root).fields)
        self.assertEqual(original.to_cache_dict(), before)
        self.assertEqual(field_from_source(created.find_field('blog.Post', 'title'), models.CharField()).max_length, 10)

    def test_removed_constructor_module_is_not_returned_from_reused_adjacency(self):
        original = self.fixture()
        original.constructor_dependents('blog.constants')
        self.assertEqual(original.constructor_dependents('blog.constants'), {'blog.models'})
        model_source = self.root / 'blog' / 'models.py'
        model_source.unlink()
        removed, _, _ = reindex_single_file(self.root, model_source, original)
        self.assertEqual(removed.constructor_dependents('blog.constants'), set())
        self.assertEqual(original.constructor_dependents('blog.constants'), {'blog.models'})


if __name__ == '__main__':
    unittest.main()
