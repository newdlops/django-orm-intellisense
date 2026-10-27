import copy
import io
import json
import tempfile
import threading
import unittest
import weakref
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from pathlib import Path
from unittest import mock

from django_orm_intellisense.cache import store
from django_orm_intellisense.cache.json_stream import (
    StaticModuleStreamReader, decode_static_modules_stream,
)
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.static_index.indexer import ModuleIndex, StaticIndex, build_static_index


class StaticCacheStreamRestoreTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='djls-static-stream-test-')
        self.addCleanup(temporary.cleanup)
        parent = Path(temporary.name).resolve()
        self.root, self.cache = parent / 'project', parent / 'cache'
        self.root.mkdir()
        self.source = self.root / 'models.py'
        self.source.write_text('from django.db import models\nclass Post(models.Model):\n'
                               '    value=models.CharField()\n')
        (self.root / 'helper.py').write_text('value=1\n')
        self.snapshot = snapshot_python_sources(self.root)
        self.index = build_static_index(self.root, self.snapshot.files)
        self.cache_patch = mock.patch.object(store, '_workspace_cache_dir', return_value=self.cache)
        self.cache_patch.start()
        self.addCleanup(self.cache_patch.stop)
        threshold = mock.patch.object(store, '_STATIC_MODULE_STREAM_MIN_BYTES', 0)
        threshold.start()
        self.addCleanup(threshold.stop)
        store.save_static_index(self.root, self.snapshot, self.index)
        self.path = self.cache / store.STATIC_INDEX_FULL_CACHE_NAME
        # Preserve the original, unversioned dictionary regression corpus.
        # Format-2 rows have a separate set of boundary and ownership tests.
        self.wire = store._read_cache_payload(self.path)
        self.wire['metadata'].pop('staticIndexVersion')
        self.path.write_text(json.dumps(self.wire))

    def load(self):
        return store._try_load_full_static_index(self.root, self.snapshot)

    def test_full_restore_avoids_whole_file_text_and_keeps_public_wire_ownership(self):
        with (mock.patch.object(Path, 'read_text', side_effect=AssertionError('Whole static JSON text')),
              mock.patch.object(store, 'build_static_index', side_effect=AssertionError('Full cache rebuilt'))):
            restored, hit = store.load_cached_static_index(self.root, self.snapshot)
        self.assertEqual(hit, 'full')
        self.assertEqual(restored.to_cache_dict(), self.index.to_cache_dict())
        self.assertEqual(restored.fields, self.index.fields)
        self.assertIs(type(restored.modules['models']), ModuleIndex)
        payload = copy.deepcopy(self.wire['payload'])
        direct = StaticIndex.from_cache_dict(payload)
        payload['modules']['models']['definedSymbols'].append('caller_only')
        payload['modules']['models']['pendingFields'][0]['constructorImports'].append('caller_only')
        self.assertEqual(direct.to_cache_dict(), self.index.to_cache_dict())

    def test_duplicate_records_and_payloads_preserve_metadata_and_error_precedence(self):
        module = json.dumps(self.wire['payload']['modules']['models'])
        raw = json.dumps(self.wire)
        cases = [
            raw.replace('"models": ' + module, '"models": {},"models": ' + module),
            '{"payload":{"modules":{"models":{}}},"payload":' + json.dumps(self.wire['payload'])
            + ',"metadata":' + json.dumps(self.wire['metadata']) + '}',
        ]
        for chunk in [1, 7, 64, 262144]:
            for value in cases:
                with self.subTest(chunk=chunk):
                    self.path.write_text(value)
                    with mock.patch.object(store, 'decode_static_modules_stream',
                            partial(decode_static_modules_stream, chunk_size=chunk)):
                        loaded = self.load()
                    self.assertEqual(loaded.to_cache_dict(), self.index.to_cache_dict())
                    self.assertTrue(self.path.exists())
        invalid = copy.deepcopy(self.wire)
        invalid['metadata']['rootTreeFingerprint'] = 'stale'
        invalid['payload']['modules']['models']['classBaseRefs'] = [1]
        self.path.write_text(json.dumps(invalid))
        self.assertIsNone(self.load())
        self.assertTrue(self.path.exists())
        invalid['metadata'] = self.wire['metadata']
        invalid['payload']['pythonFileCount'] = 'bad-count-first'
        self.path.write_text(json.dumps(invalid))
        self.assertIsNone(self.load())
        self.assertFalse(self.path.exists())
        invalid['payload']['pythonFileCount'] = 2
        self.path.write_text(json.dumps(invalid))
        with self.assertRaises(AttributeError):
            self.load()
        self.assertTrue(self.path.exists())

    def test_stale_metadata_skips_hydration_but_later_duplicate_can_restore_raw_modules(self):
        invalid = copy.deepcopy(self.wire)
        invalid['metadata']['rootTreeFingerprint'] = 'stale'
        self.path.write_text(json.dumps(invalid))
        with mock.patch.object(ModuleIndex, 'from_dict', side_effect=AssertionError('Stale cache hydrated')):
            self.assertIsNone(self.load())
        self.assertTrue(self.path.exists())
        raw = json.dumps(invalid)[:-1] + ',"metadata":' + json.dumps(self.wire['metadata']) + '}'
        self.path.write_text(raw)
        with mock.patch.object(ModuleIndex, 'from_dict', wraps=ModuleIndex.from_dict) as restored:
            self.assertEqual(self.load().to_cache_dict(), self.index.to_cache_dict())
        self.assertEqual(restored.call_count, len(self.index.modules))

    def test_small_cache_and_failed_size_hint_keep_single_read_fallback(self):
        with mock.patch.object(store, '_STATIC_MODULE_STREAM_MIN_BYTES', 4 * 1024 * 1024), \
                mock.patch.object(store, '_decode_static_cache_payload', side_effect=AssertionError('Small cache streamed')):
            self.assertEqual(self.load().to_cache_dict(), self.index.to_cache_dict())
        with mock.patch.object(Path, 'stat', side_effect=OSError('size hint unavailable')):
            self.assertEqual(self.load().to_cache_dict(), self.index.to_cache_dict())

    def test_invalid_json_utf8_and_incomplete_modules_recover_with_partial_source_cache(self):
        incomplete = copy.deepcopy(self.wire)
        incomplete['payload']['modules'].pop('models')
        for raw in [b'{"payload":{"modules":', b'{"payload":"\xff"}', json.dumps(incomplete).encode()]:
            with self.subTest(raw=raw[:40]):
                self.path.write_bytes(raw)
                loaded, hit = store.load_cached_static_index(self.root, self.snapshot)
                self.assertEqual(hit, 'partial')
                self.assertFalse(self.path.exists())
                self.assertEqual(loaded.to_cache_dict(), self.index.to_cache_dict())
                self.assertEqual(loaded.fields, self.index.fields)

    def test_unknown_nested_module_shapes_remain_json_values(self):
        future = {'metadata': {'payload': {'modules': self.wire['payload']['modules']}},
                  'payload': {'future': {'modules': self.wire['payload']['modules'],
                                         'literal': '한글🙂' * 20000}}}
        for chunk in [65536, 262144]:
            with mock.patch.object(store, 'decode_static_modules_stream',
                    partial(decode_static_modules_stream, chunk_size=chunk)):
                decoded = store._decode_static_cache_payload(io.StringIO(json.dumps(future, ensure_ascii=False)))
            self.assertEqual(decoded, future)

    def test_partial_io_and_unexpected_read_failures_close_without_deleting_cache(self):
        raw = json.dumps(self.wire)
        class Failing(io.StringIO):
            def __init__(self, error):
                super().__init__(raw)
                self.error, self.calls = error, 0
            def read(self, size=-1):
                self.calls += 1
                if self.calls == 2:
                    raise self.error
                return super().read(7)
        for error in [OSError('partial read failed'), RuntimeError('unexpected read failed')]:
            stream = Failing(error)
            with mock.patch.object(Path, 'open', return_value=stream):
                if isinstance(error, OSError):
                    self.assertIsNone(self.load())
                else:
                    with self.assertRaisesRegex(RuntimeError, 'unexpected read failed'):
                        self.load()
            self.assertTrue(stream.closed)
            self.assertTrue(self.path.exists())

    def test_decoder_stream_hook_and_restorer_owners_release_without_gc(self):
        class Hook:
            def __call__(self, value):
                return value
        for raw in ['{"payload":{"modules":{"one":{}}}}', '{"payload":{"modules":']:
            stream, hook, restorer = io.StringIO(raw), Hook(), Hook()
            refs = [weakref.ref(owner) for owner in [stream, hook, restorer]]
            reader = StaticModuleStreamReader(stream, hook, restorer, 7)
            try:
                reader.read()
            except json.JSONDecodeError:
                pass
            del stream, hook, restorer
            self.assertTrue(all(ref() is None for ref in refs))
            self.assertIsNone(reader.restore_module)
            self.assertFalse(reader.keys)
            self.assertEqual(reader.buffer, '')

    def test_atomic_cache_replacement_during_restore_keeps_one_opened_snapshot(self):
        started, resume = threading.Event(), threading.Event()
        original_open = Path.open
        class Held:
            def __init__(self, stream):
                self.stream, self.first = stream, True
            def __enter__(self):
                return self
            def __exit__(self, *args):
                self.stream.close()
            def read(self, size=-1):
                result = self.stream.read(size)
                if self.first:
                    self.first = False
                    started.set()
                    if not resume.wait(5):
                        raise RuntimeError('Cache read gate timed out')
                return result
        def opened(path, *args, **kwargs):
            stream = original_open(path, *args, **kwargs)
            return Held(stream) if path == self.path else stream
        current = copy.deepcopy(self.wire)
        current['payload']['modules']['models']['definedSymbols'].append('replacement_symbol')
        with ThreadPoolExecutor(max_workers=1) as executor, \
                mock.patch.object(Path, 'open', opened), \
                mock.patch.object(store, 'decode_static_modules_stream',
                    partial(decode_static_modules_stream, chunk_size=7)):
            loaded = executor.submit(self.load)
            try:
                self.assertTrue(started.wait(3))
                store._write_cache_payload(self.path, current)
            finally:
                resume.set()
            previous = loaded.result(timeout=5)
        self.assertEqual(previous.to_cache_dict(), self.index.to_cache_dict())
        self.assertEqual(self.load().to_cache_dict(), StaticIndex.from_cache_dict(current['payload']).to_cache_dict())

    def test_same_size_source_edit_rejects_full_cache_and_preserves_old_owner(self):
        initial = self.load()
        old_wire = initial.to_cache_dict()
        self.source.write_text(self.source.read_text().replace('CharField', 'DateField'))
        current = snapshot_python_sources(self.root)
        restored, hit = store.load_cached_static_index(self.root, current)
        self.assertEqual(hit, 'partial')
        self.assertEqual(restored.to_cache_dict(), build_static_index(self.root, current.files).to_cache_dict())
        self.assertEqual(restored.find_field('models.Post', 'value').field_kind, 'DateField')
        self.assertEqual(initial.to_cache_dict(), old_wire)


if __name__ == '__main__':
    unittest.main()
