import os
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from django_orm_intellisense.cache import store
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.static_index import indexer


class StaticSourcePathTests(unittest.TestCase):
    def legacy_index(self, root, files, **kwargs):
        # Exercise the unchanged pathlib fallback, independent of the POSIX fast path.
        with mock.patch.object(indexer, 'os', types.SimpleNamespace(name='nt'), create=True):
            return indexer.build_static_index(root, files, **kwargs)

    def test_posix_cold_and_partial_builds_do_not_repeat_relative_path_parent_walks(self):
        if os.name != 'posix':
            self.skipTest('POSIX lexical source identity')
        with tempfile.TemporaryDirectory(prefix='djls-static-source-paths-') as temporary:
            root = Path(temporary).resolve()
            package = root / 'blog'
            package.mkdir()
            (package / '__init__.py').write_text('')
            model = package / 'models.py'
            model.write_text('from django.db import models\nclass Post(models.Model):\n    value=models.CharField()\n')
            for number in range(130):
                (package / f'helper_{number}.py').write_text(f'value={number}\n')
            files = tuple(sorted(root.rglob('*.py')))
            expected = self.legacy_index(root, files)
            cached = {Path(module.file_path).relative_to(root).as_posix(): module
                      for module in expected.modules.values() if module.file_path != str(model)}
            with mock.patch.object(Path, 'relative_to', side_effect=AssertionError('Repeated per-source pathlib parent walks')):
                cold = indexer.build_static_index(root, files)
                partial = indexer.build_static_index(root, files, cached_module_indices=cached)
            self.assertEqual(cold.to_cache_dict(), expected.to_cache_dict())
            self.assertEqual(partial.to_cache_dict(), expected.to_cache_dict())
            self.assertEqual(cold.fields, expected.fields)
            self.assertIs(partial.modules['blog.helper_0'], expected.modules['blog.helper_0'])

    def test_lexical_paths_import_names_collisions_and_failures_match_pathlib(self):
        with tempfile.TemporaryDirectory(prefix='djls-static-lexical-') as temporary:
            parent = Path(temporary).resolve()
            root = parent / 'root'
            package = root / '한글'
            package.mkdir(parents=True)
            (package / '__init__.py').write_text('from .module import Visible\n')
            (package / 'module.py').write_text('from django.db import models\nclass Shadow(models.Model):\n    value=models.CharField()\n')
            (package / 'module').mkdir()
            (package / 'module' / '__init__.py').write_text('from django.db import models\nclass Visible(models.Model):\n    value=models.DateField()\n')
            (package / '.hidden.py').write_text('value=1\n')
            (package / 'many.dots.py').write_text('value=2\n')
            (package / 'broken.py').write_text('class Broken(\n')
            external = parent / 'root_extra' / 'src' / 'outside'
            external.mkdir(parents=True)
            (external / '__init__.py').write_text('from .models import External\n')
            (external / 'models.py').write_text('from django.db import models\nclass External(models.Model):\n    value=models.IntegerField()\n')
            standalone = parent / 'root_extra' / 'standalone.py'
            standalone.write_text('value=3\n')
            (parent / 'root_extra' / '__init__.py').write_text('')
            (package / 'link.py').symlink_to(external / 'models.py')
            external_files = tuple(sorted(external.rglob('*.py'))) + (standalone,)
            for selected in [root, Path(os.path.relpath(root)), root / '..' / 'root', Path('.')]:
                files = tuple(sorted(root.rglob('*.py'))) + external_files
                if selected == root / '..' / 'root' or not selected.is_absolute() and selected != Path('.'):
                    files = tuple(sorted(selected.rglob('*.py'))) + external_files
                with self.subTest(root=str(selected)):
                    expected = self.legacy_index(selected, files)
                    actual = indexer.build_static_index(selected, files)
                    self.assertEqual(actual.to_cache_dict(), expected.to_cache_dict())
                    self.assertEqual(actual.fields, expected.fields)
            current = indexer.build_static_index(root, tuple(sorted(root.rglob('*.py'))) + external_files)
            self.assertEqual(current.modules['한글.module'].file_path, str(package / 'module' / '__init__.py'))
            self.assertEqual(current.shadowed_files['한글/module.py'], '한글/module/__init__.py')
            self.assertEqual(current.unparseable_files, {'한글/broken.py': 'SyntaxError'})
            self.assertIn('outside.models', current.modules)
            self.assertIn('root_extra.standalone', current.modules)
            self.assertIn('한글.link', current.modules)
            relative_files = tuple(Path(os.path.relpath(path)) for path in tuple(sorted(root.rglob('*.py'))) + external_files)
            self.assertEqual(indexer.build_static_index(Path('.'), relative_files).to_cache_dict(),
                             self.legacy_index(Path('.'), relative_files).to_cache_dict())
            for build in [indexer.build_static_index, self.legacy_index]:
                with self.assertRaises(ValueError):
                    build(package / 'many.dots.py', [package / 'many.dots.py'])

    def test_partial_cache_source_edit_preserves_external_and_old_snapshot_ownership(self):
        with tempfile.TemporaryDirectory(prefix='djls-static-path-cache-') as temporary:
            parent = Path(temporary).resolve()
            root = parent / 'workspace'
            root.mkdir()
            source = root / 'models.py'
            source.write_text('from django.db import models\nclass Post(models.Model):\n    value=models.CharField()\n')
            external = parent / 'editable' / 'src' / 'outside'
            external.mkdir(parents=True)
            (external / '__init__.py').write_text('')
            (external / 'models.py').write_text('from django.db import models\nclass External(models.Model):\n    value=models.IntegerField()\n')
            snapshot = snapshot_python_sources(root, [external])
            initial = indexer.build_static_index(root, snapshot.files)
            initial_wire = initial.to_cache_dict()
            with mock.patch.object(store, '_workspace_cache_dir', return_value=parent / 'cache'):
                store.save_static_index(root, snapshot, initial)
                full, hit = store.load_cached_static_index(root, snapshot)
                self.assertEqual(hit, 'full')
                self.assertEqual(full.to_cache_dict(), initial_wire)
                source.write_text(source.read_text().replace('CharField', 'DateField'))
                current = snapshot_python_sources(root, [external])
                actual, hit = store.load_cached_static_index(root, current)
            self.assertEqual(hit, 'partial')
            expected = self.legacy_index(root, current.files)
            self.assertEqual(actual.to_cache_dict(), expected.to_cache_dict())
            self.assertEqual(actual.fields, expected.fields)
            self.assertEqual(initial.to_cache_dict(), initial_wire)
            self.assertEqual(actual.modules['outside.models'].module_name, 'outside.models')


if __name__ == '__main__':
    unittest.main()
