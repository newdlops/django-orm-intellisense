"""Chunked cache writes preserve bytes, failure cleanup and atomic readers."""
import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from django_orm_intellisense.cache import store
from django_orm_intellisense.runtime.lookup_catalog import LookupTypeTable, lookup_catalog_json_default


class CacheWriteAtomicTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='djls-cache-write-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.path = self.root / 'cache.json'

    def assert_bytes(self, payload):
        expected = json.dumps(payload, sort_keys=True, default=lookup_catalog_json_default).encode('utf-8')
        store._write_cache_payload(self.path, payload)
        self.assertEqual(self.path.read_bytes(), expected)
        self.assertFalse(list(self.root.glob('*.tmp')))
        self.assertFalse(list(self.root.glob('.*.tmp')))

    def test_all_chunks_preserve_exact_sorted_json_escaping_scalar_tuple_and_list_bytes(self):
        shared = {'literal': '한글\n"\\' * 1000, 'items': [None, False, True, -10, 1.25]}
        for count in [0, 1, 64, 128, 129, 257]:
            with self.subTest(records=count):
                payload = {'metadata': {'workspaceRoot': '/프로젝트', 'schemaVersion': 34},
                    'payload': {'modules': {f'key_{number:04}': {'value': shared, 'tuple': ('a', None, 1)}
                                for number in reversed(range(count))},
                        'candidates': [{'number': number, 'value': shared} for number in range(count)]},
                    'unknown': {'__proto__': 'constructor', 'escaped"key': ['\n', '\t']}}
                self.assert_bytes(payload)

    def test_custom_lookup_table_and_nonstring_keys_keep_standard_encoder_contract(self):
        table = LookupTypeTable.from_types({'root': {'fieldKind': 'CharField', 'lookups': ['exact'], 'transforms': {}}})
        self.assert_bytes({'payload': {'catalog': table}, 'metadata': {'schemaVersion': 34}})
        for payload in [{1: 'one', 2: 'two'}, {None: None}, {True: False}, {1.5: 'float'},
                        {'values': [float('nan'), float('inf'), -float('inf')]}]:
            self.assert_bytes(payload)

    def test_unsupported_and_circular_serialization_preserve_old_cache_and_remove_temp(self):
        old = {'payload': 'previous complete cache'}
        store._write_cache_payload(self.path, old)
        expected = self.path.read_bytes()
        circular = {}
        circular['self'] = circular
        for payload, error in [({'payload': {'unsupported': object()}}, TypeError),
                               ({'payload': circular}, ValueError),
                               ({'payload': {1: 'mixed', 'a': 'keys'}}, TypeError)]:
            with self.subTest(error=error.__name__):
                with self.assertRaises(error):
                    store._write_cache_payload(self.path, payload)
                self.assertEqual(self.path.read_bytes(), expected)
                self.assertFalse(list(self.root.glob('.*.tmp')))

    def test_replace_failure_preserves_old_cache_and_removes_only_its_temp(self):
        store._write_cache_payload(self.path, {'old': True})
        old = self.path.read_bytes()
        unrelated = self.root / '.unrelated.tmp'
        unrelated.write_text('unrelated')
        with mock.patch.object(Path, 'replace', side_effect=PermissionError('injected replace failure')):
            store._write_cache_payload(self.path, {'new': True})
        self.assertEqual(self.path.read_bytes(), old)
        self.assertEqual(unrelated.read_text(), 'unrelated')
        self.assertEqual(list(self.root.glob('.*.tmp')), [unrelated])

    def test_partial_write_failure_preserves_old_cache_and_cleans_temp(self):
        store._write_cache_payload(self.path, {'old': True})
        old = self.path.read_bytes()

        def failed(stream, payload, encoder, depth):
            stream.write('{"incomplete":')
            raise OSError('injected interrupted write')

        with mock.patch.object(store, '_write_cache_json_value', side_effect=failed):
            store._write_cache_payload(self.path, {'new': True})
        self.assertEqual(self.path.read_bytes(), old)
        self.assertFalse(list(self.root.glob('.*.tmp')))

    def test_concurrent_writers_have_distinct_complete_temps_and_readers_keep_old_until_commit(self):
        original = {'revision': 'old', 'payload': list(range(100))}
        store._write_cache_payload(self.path, original)
        old = self.path.read_bytes()
        choices = [{'revision': name, 'payload': list(range(300)), 'literal': name * 1000}
                   for name in ['first', 'second']]
        expected = {json.dumps(value, sort_keys=True).encode() for value in choices}
        entered = threading.Event()
        release = threading.Event()
        lock = threading.Lock()
        paths = []
        replace = Path.replace

        def held(path, target):
            with lock:
                paths.append(path)
                if len(paths) == 2:
                    entered.set()
            if not release.wait(5):
                raise TimeoutError('Cache writers did not resume')
            return replace(path, target)

        with mock.patch.object(Path, 'replace', held), ThreadPoolExecutor(max_workers=2) as pool:
            pending = [pool.submit(store._write_cache_payload, self.path, value) for value in choices]
            try:
                self.assertTrue(entered.wait(5))
                self.assertEqual(len(set(paths)), 2, 'Writers shared a temporary cache file')
                self.assertEqual(self.path.read_bytes(), old)
                self.assertEqual({path.read_bytes() for path in paths}, expected)
            finally:
                release.set()
            for task in pending:
                task.result(timeout=5)
        self.assertIn(self.path.read_bytes(), expected)
        self.assertFalse(list(self.root.glob('.*.tmp')))


if __name__ == '__main__':
    unittest.main()
