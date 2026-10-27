import io
import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from django_orm_intellisense.cache import store
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.static_index.indexer import StaticIndex, build_static_index


class StaticCacheSpoolTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='djls-static-spool-test-')
        self.addCleanup(self.temporary.cleanup)
        parent = Path(self.temporary.name).resolve()
        self.root = parent / 'project'
        package = self.root / 'blog'
        package.mkdir(parents=True)
        (package / '__init__.py').write_text('')
        (package / 'models.py').write_text('from django.db import models\nclass Post(models.Model):\n    value=models.CharField()\n')
        (package / 'helper.py').write_text('value=1\n')
        (package / 'broken.py').write_text('class Broken(\n')
        self.snapshot = snapshot_python_sources(self.root)
        self.index = build_static_index(self.root, self.snapshot.files)
        self.cache = parent / 'cache'
        patcher = mock.patch.object(store, '_workspace_cache_dir', return_value=self.cache)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_static_save_does_not_materialize_the_whole_serialized_index(self):
        expected = self.index.to_cache_dict()
        with mock.patch.object(StaticIndex, 'to_cache_dict', side_effect=AssertionError('Whole serialized static index retained before cache writes')):
            store.save_static_index(self.root, self.snapshot, self.index)
        full = store._read_cache_payload(self.cache / store.STATIC_INDEX_FULL_CACHE_NAME)
        self.assertEqual(full['payload'], expected)

    def test_sorted_cache_bytes_and_single_conversion_match_eager_for_external_collisions_and_unicode(self):
        from benchmarks.static_cache_spool_candidate import previous_save_static_index
        from benchmarks import static_cache_spool_candidate as control
        external = self.root.parent / 'aaa' / 'src' / 'zzpkg'
        external.mkdir(parents=True)
        (external / '__init__.py').write_text('')
        (external / 'models.py').write_text('from django.db import models\nclass External(models.Model):\n    한글=models.CharField()\n')
        package = self.root / 'blog' / 'entities'
        package.mkdir()
        (self.root / 'blog' / 'entities.py').write_text('value=1\n')
        (package / '__init__.py').write_text('value=2\n')
        snapshot = snapshot_python_sources(self.root, [external])
        index = build_static_index(self.root, snapshot.files)
        expected = index.to_cache_dict()
        class Clock:
            @staticmethod
            def now(tz=None):
                return datetime(2026, 10, 9, tzinfo=timezone.utc)
        with mock.patch.object(store, 'datetime', Clock), mock.patch.object(control, 'datetime', Clock):
            previous_save_static_index(self.root, snapshot, index)
            old = {name: (self.cache / name).read_bytes() for name in [store.STATIC_INDEX_CACHE_NAME, store.STATIC_INDEX_FULL_CACHE_NAME]}
            calls = Counter()
            original = store.module_to_row
            def to_dict(module):
                calls[module.module_name] += 1
                return original(module)
            with mock.patch.object(store, 'module_to_row', to_dict):
                store.save_static_index(self.root, snapshot, index)
            self.assertEqual(calls, {name: 1 for name in index.modules})
            for name, previous in old.items():
                current = (self.cache / name).read_bytes()
                # The compact wire must remain deterministic and fully sorted.
                self.assertEqual(current, json.dumps(json.loads(current), sort_keys=True,
                    default=store.lookup_catalog_json_default).encode())
                expanded = store._read_cache_payload(self.cache / name)
                expanded['metadata'].pop('staticIndexVersion')
                self.assertEqual(expanded['metadata'].pop('sourceCoordinatesVersion'),
                    'utf16-1based-v1')
                self.assertEqual(expanded, json.loads(previous))
        restored, hit = store.load_cached_static_index(self.root, snapshot)
        self.assertEqual(hit, 'full')
        self.assertEqual(restored.to_cache_dict(), expected)
        self.assertEqual(restored.fields, index.fields)
        self.assertEqual(index.to_cache_dict(), expected)

    def test_serialization_failure_keeps_both_old_files_and_closes_spool(self):
        store.save_static_index(self.root, self.snapshot, self.index)
        old = {name: (self.cache / name).read_bytes() for name in [store.STATIC_INDEX_CACHE_NAME, store.STATIC_INDEX_FULL_CACHE_NAME]}
        for error in [RuntimeError('injected serialization failure'), TypeError('injected unsupported value')]:
            spool = io.BytesIO()
            with mock.patch.object(store.tempfile, 'TemporaryFile', return_value=spool), \
                    mock.patch.object(store, 'module_to_row', side_effect=error):
                with self.assertRaises(type(error)):
                    store.save_static_index(self.root, self.snapshot, self.index)
            self.assertTrue(spool.closed)
            self.assertEqual({name: (self.cache / name).read_bytes() for name in old}, old)
            self.assertFalse(list(self.cache.glob('.*.tmp')))

    def test_spool_io_failures_keep_old_targets_and_close_only_owned_resources(self):
        store.save_static_index(self.root, self.snapshot, self.index)
        old = {name: (self.cache / name).read_bytes() for name in [store.STATIC_INDEX_CACHE_NAME, store.STATIC_INDEX_FULL_CACHE_NAME]}
        class Failed(io.BytesIO):
            def __init__(self, operation):
                super().__init__()
                self.operation = operation
            def write(self, value):
                if self.operation == 'write':
                    raise OSError('injected spool write failure')
                if self.operation == 'short_write':
                    return super().write(value[:-1])
                return super().write(value)
            def read(self, size=-1):
                if self.operation == 'read':
                    raise OSError('injected spool read failure')
                value = super().read(size)
                return value[:-1] if self.operation == 'short_read' else value
            def flush(self):
                if self.operation == 'flush':
                    raise OSError('injected spool flush failure')
                return super().flush()
        for operation in ['write', 'short_write', 'read', 'short_read', 'flush']:
            with self.subTest(operation=operation):
                spool = Failed(operation)
                with mock.patch.object(store.tempfile, 'TemporaryFile', return_value=spool):
                    store.save_static_index(self.root, self.snapshot, self.index)
                self.assertTrue(spool.closed)
                self.assertEqual({name: (self.cache / name).read_bytes() for name in old}, old)
                self.assertFalse(list(self.cache.glob('.*.tmp')))

    def test_full_payload_snapshot_is_captured_before_first_target_commit(self):
        expected = self.index.to_cache_dict()
        original = Path.replace
        def replace(path, target):
            result = original(path, target)
            if Path(target).name == store.STATIC_INDEX_CACHE_NAME:
                self.index.python_file_count = 9000
                self.index.model_candidates.clear()
                self.index.shadowed_files['changed.py'] = 'unrelated.py'
            return result
        with mock.patch.object(Path, 'replace', replace):
            store.save_static_index(self.root, self.snapshot, self.index)
        full = store._read_cache_payload(self.cache / store.STATIC_INDEX_FULL_CACHE_NAME)
        self.assertEqual(full['payload'], expected)

    def test_concurrent_static_saves_keep_spools_separate_and_complete_each_target(self):
        first_snapshot, first_index = self.snapshot, self.index
        path = self.root / 'blog' / 'models.py'
        path.write_text(path.read_text().replace('CharField', 'DateField'))
        second_snapshot = snapshot_python_sources(self.root)
        second_index = build_static_index(self.root, second_snapshot.files)
        spools = []
        lock = threading.Lock()
        ready, release = threading.Event(), threading.Event()
        original = store.tempfile.TemporaryFile
        class Held:
            def __init__(self, inner):
                self.inner = inner
            def __getattr__(self, name):
                return getattr(self.inner, name)
            def __enter__(self):
                return self
            def __exit__(self, *args):
                self.inner.close()
            def flush(self):
                self.inner.flush()
                with lock:
                    spools.append(self.inner)
                    if len(spools) == 2:
                        ready.set()
                if not release.wait(5):
                    raise TimeoutError('Held spools did not resume')
        def temporary(*args, **kwargs):
            return Held(original(*args, **kwargs))
        with mock.patch.object(store.tempfile, 'TemporaryFile', temporary), ThreadPoolExecutor(max_workers=2) as executor:
            tasks = [executor.submit(store.save_static_index, self.root, snapshot, index)
                     for snapshot, index in [(first_snapshot, first_index), (second_snapshot, second_index)]]
            try:
                self.assertTrue(ready.wait(3))
                self.assertEqual(len({id(spool) for spool in spools}), 2)
            finally:
                release.set()
            for task in tasks:
                task.result(timeout=5)
        self.assertTrue(all(spool.closed for spool in spools))
        full = store._read_cache_payload(self.cache / store.STATIC_INDEX_FULL_CACHE_NAME)
        self.assertIn(full['payload'], [first_index.to_cache_dict(), second_index.to_cache_dict()])
        self.assertFalse(list(self.cache.glob('.*.tmp')))


if __name__ == '__main__':
    unittest.main()
