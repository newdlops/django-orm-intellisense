"""Bounded cold parse work must preserve ordering, errors and source adoption."""
import ast
import contextlib
import os
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from django_orm_intellisense.cache import save_static_index
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.server import app
from django_orm_intellisense.static_index import indexer
from tests.test_static_fallback_surface_gap import _make_server, _write_blog_models


class StaticParsePipelineTests(unittest.TestCase):
    def serial_reference(self, root, files):
        # An unused cache entry selects the original serial read/parse path;
        # every actual input remains fresh and inheritance is fully expanded.
        return indexer.build_static_index(root, files,
            cached_module_indices={'__serial_reference_not_in_inputs__.py': object()})

    def test_thresholds_preserve_full_metadata_collisions_and_all_file_errors(self):
        with tempfile.TemporaryDirectory(prefix='djls-static-pipeline-order-') as temporary:
            root = Path(temporary).resolve()
            blog = root / 'blog'
            blog.mkdir()
            (blog / '__init__.py').write_text('from .models import *\n')
            (blog / 'base.py').write_text('from django.db import models\n'
                'class Base(models.Model):\n    inherited=models.DateField()\n'
                '    class Meta:\n        abstract=True\n')
            (blog / 'models.py').write_text('from django.db import models\nfrom .base import Base\n'
                'class Post(Base):\n    title=models.CharField(max_length=120)\n'
                '    @property\n    def caption(self):\n        return self.title\n')
            package = root / 'shadow'
            package.mkdir()
            (root / 'shadow.py').write_text('from django.db import models\nclass Hidden(models.Model):\n    hidden=models.IntegerField()\n')
            (package / '__init__.py').write_text('from django.db import models\nclass Visible(models.Model):\n    visible=models.BooleanField()\n')
            broken = root / 'broken.py'; broken.write_text('class Broken(\n')
            invalid = root / 'invalid.py'; invalid.write_bytes(b'\xff\xfe')
            denied = root / 'denied.py'; denied.write_text('value=1\n')
            missing = root / 'missing.py'
            files = [blog / '__init__.py', blog / 'base.py', blog / 'models.py', root / 'shadow.py']
            for number in range(121):
                path = root / f'helper_{number}.py'; path.write_text(f'value={number}\n'); files.append(path)
            files[63:63] = [package / '__init__.py']
            files += [broken, invalid, denied, missing]
            original_read = Path.read_text
            def read(path, *args, **kwargs):
                if path == denied: raise PermissionError('controlled unreadable source')
                return original_read(path, *args, **kwargs)
            # Ensure each error is exercised on both sides of the128-file
            # threshold, then repeat with the collision winner appearing first.
            for count in [127, 128, 129, 130]:
                selected = tuple(files[:count - 4] + [broken, invalid, denied, missing])
                for ordered in [selected, tuple(reversed(selected))]:
                    with self.subTest(files=count, reversed=ordered is not selected), mock.patch.object(Path, 'read_text', read):
                        expected = self.serial_reference(root, ordered)
                        actual = indexer.build_static_index(root, ordered)
                    self.assertEqual(actual.to_cache_dict(), expected.to_cache_dict())
                    self.assertEqual(actual.fields, expected.fields)
                    self.assertEqual(actual.modules['shadow'].file_path, str(package / '__init__.py'))
                    self.assertEqual(actual.unparseable_files, {'broken.py': 'SyntaxError',
                        'invalid.py': 'UnicodeDecodeError', 'denied.py': 'PermissionError', 'missing.py': 'FileNotFoundError'})
                    self.assertEqual(len(actual.modules) + len(actual.unparseable_files) + len(actual.shadowed_files), count)
                    self.assertEqual(actual.find_field('blog.Post', 'inherited').field_kind, 'DateField')

    def test_read_ahead_remains_bounded_when_an_early_parse_is_held(self):
        with tempfile.TemporaryDirectory(prefix='djls-static-pipeline-bound-') as temporary:
            root = Path(temporary).resolve()
            files = tuple(root / f'helper_{number}.py' for number in range(192))
            for number, path in enumerate(files): path.write_text(f'value={number}\n')
            positions = {path: number for number, path in enumerate(files)}
            entered, release, other_reads = threading.Event(), threading.Event(), threading.Event()
            lock = threading.Lock(); reads = []
            original_read, original_parse = Path.read_text, ast.parse
            def read(path, *args, **kwargs):
                result = original_read(path, *args, **kwargs)
                with lock:
                    reads.append(positions[path])
                    if len(reads) >= 10: other_reads.set()
                return result
            def parse(text, *args, **kwargs):
                if text == 'value=0\n':
                    entered.set()
                    if not release.wait(5): raise AssertionError('Controlled parse was not released')
                return original_parse(text, *args, **kwargs)
            with mock.patch.object(Path, 'read_text', read), mock.patch.object(ast, 'parse', parse), \
                    ThreadPoolExecutor(max_workers=1) as controller:
                future = controller.submit(indexer.build_static_index, root, files)
                try:
                    self.assertTrue(entered.wait(5))
                    self.assertTrue(other_reads.wait(5))
                    with lock: self.assertTrue(all(number < 64 for number in reads), reads)
                    self.assertFalse(future.done())
                finally: release.set()
                actual = future.result(timeout=5)
            self.assertEqual(sorted(reads), list(range(192)))
            self.assertEqual(list(actual.modules), [f'helper_{number}' for number in range(192)])

    def test_same_size_restored_mtime_edit_during_batch_retries_before_adoption(self):
        with tempfile.TemporaryDirectory(prefix='djls-static-pipeline-fresh-') as temporary, contextlib.ExitStack() as stack:
            base = Path(temporary).resolve(); root = base / 'workspace'; root.mkdir()
            _write_blog_models(root)
            source = root / 'blog/models.py'
            for number in range(130): (root / f'helper_{number}.py').write_text(f'value={number}\n')
            server = _make_server(root)
            stack.enter_context(mock.patch.dict(os.environ, {'DJANGO_ORM_INTELLISENSE_CACHE_DIR': str(base / 'cache')}))
            for name in ['_start_runtime_warmup', '_start_runtime_field_registry_prewarm', '_schedule_surface_index_idle_load']:
                stack.enter_context(mock.patch.object(server, name))
            entered, release = threading.Event(), threading.Event()
            original = ast.parse
            def parse(text, *args, **kwargs):
                if 'class Post' in text and 'CharField' in text and not entered.is_set():
                    entered.set()
                    if not release.wait(5): raise AssertionError('Controlled source parse was not released')
                return original(text, *args, **kwargs)
            with mock.patch.object(ast, 'parse', parse), \
                    mock.patch.object(app, 'save_static_index', wraps=save_static_index) as save, \
                    ThreadPoolExecutor(max_workers=1) as controller:
                future = controller.submit(server._initialize, {'workspaceRoot': str(root), 'deferRuntime': True})
                try:
                    self.assertTrue(entered.wait(5))
                    stamp = source.stat()
                    old = source.read_text(); new = old.replace('CharField', 'DateField')
                    self.assertEqual(len(old), len(new)); self.assertNotEqual(old, new)
                    source.write_text(new)
                    os.utime(source, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
                finally: release.set()
                result = future.result(timeout=10)
            self.assertEqual(result['staticFallback']['blog.Post']['fieldDetails']['title']['fieldKind'], 'DateField')
            self.assertEqual(save.call_count, 1)
            current = snapshot_python_sources(root)
            self.assertEqual(save.call_args.args[1].fingerprint, current.fingerprint)
            self.assertEqual(server.source_snapshot.fingerprint, current.fingerprint)
            self.assertEqual(server.static_index.to_cache_dict(), self.serial_reference(root, current.files).to_cache_dict())

    def test_unexpected_errors_follow_input_order_when_later_error_finishes_first(self):
        class ControlledFailure(BaseException):
            pass

        with tempfile.TemporaryDirectory(prefix='djls-static-pipeline-error-order-') as temporary:
            root = Path(temporary).resolve()
            files = tuple(root / f'helper_{number}.py' for number in range(128))
            for number, path in enumerate(files): path.write_text(f'value={number}\n')
            later_finished = threading.Event()
            original = indexer._build_module_index

            def build(root, path, *args, **kwargs):
                if path == files[0]:
                    if not later_finished.wait(5): raise AssertionError('Later parse did not run concurrently')
                    raise ControlledFailure('first input')
                if path == files[8]:
                    later_finished.set()
                    raise ControlledFailure('later input')
                return original(root, path, *args, **kwargs)

            with mock.patch.object(indexer, '_build_module_index', build):
                with self.assertRaisesRegex(ControlledFailure, 'first input'):
                    indexer.build_static_index(root, files)
            self.assertTrue(later_finished.is_set())


if __name__ == '__main__': unittest.main()
