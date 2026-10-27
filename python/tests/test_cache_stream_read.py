import io
import json
import random
import tempfile
import threading
import unittest
import weakref
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from pathlib import Path
from unittest import mock

from django_orm_intellisense.cache import store


class CacheStreamReadTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='djls-cache-stream-read-')
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / 'surface.json'
        member = ['scalar', None, 'field', 'CharField']
        self.model = {receiver: {'value': member, 'duplicate': member}
                      for receiver in ['model_class', 'manager', 'queryset', 'instance']}
        self.payload = {'metadata': {'schemaVersion': 34}, 'payload': {'app.Model': self.model}}

    def test_surface_cache_read_avoids_whole_file_text_allocation(self):
        self.path.write_text(json.dumps(self.payload), encoding='utf-8')
        with mock.patch.object(Path, 'read_text', side_effect=AssertionError('Surface cache allocated whole source text')):
            actual = store._read_cache_payload(self.path, compact_surface_models=True)
        self.assertEqual(json.dumps(actual, sort_keys=True), json.dumps(self.payload, sort_keys=True))
        self.assertIsInstance(actual['payload']['app.Model']['instance']['value'], tuple)

    def test_invalid_utf8_cache_is_a_recoverable_miss_and_removed(self):
        for compact in [False, True]:
            with self.subTest(compact=compact):
                self.path.write_bytes(b'{"payload":"\xff"}')
                self.assertIsNone(store._read_cache_payload(self.path, compact_surface_models=compact))
                self.assertFalse(self.path.exists())

    def test_standard_json_values_and_invalid_syntax_across_small_boundaries(self):
        from django_orm_intellisense.cache.json_stream import decode_json_stream
        values = [None, [], {}, True, False, -12345, 1.2345e+200, 1e-250,
                  {'a': {'b': {'c': ['한글🙂', '"\\\n[{}]', 5, None]}}},
                  float('nan'), float('inf'), float('-inf')]
        rng = random.Random(20261009)
        values.extend({'nested': [rng.randrange(-1000, 1000), rng.choice([None, True, '한글'])]}
                      for _ in range(24))
        for chunk in [1, 2, 7, 64, 262144]:
            for value in values:
                raw = ' \n' + json.dumps(value, ensure_ascii=False) + '\t '
                actual = decode_json_stream(io.StringIO(raw), lambda value: value, chunk_size=chunk)
                self.assertEqual(json.dumps(actual, sort_keys=True), json.dumps(json.loads(raw), sort_keys=True))
            for raw in ['', '{', '{"x":1,}', '{1:2}', '{"x" 1}', '{"x":[1 2]}',
                        '{"x":"\\q"}', '{"x":trueX}', '{"x":1e}', '{"x":01}', '{}{}', '\ufeff{}']:
                with self.subTest(chunk=chunk, invalid=raw), self.assertRaises(json.JSONDecodeError):
                    decode_json_stream(io.StringIO(raw), lambda value: value, chunk_size=chunk)
        raw = '{"payload":{"x":1,"x":2},"metadata":{},"payload":{"last":3}}'
        self.assertEqual(decode_json_stream(io.StringIO(raw), lambda value: value, chunk_size=1), json.loads(raw))

    def test_surface_future_shapes_large_values_and_read_key_ownership(self):
        from django_orm_intellisense.cache.json_stream import decode_json_stream
        payload = {'metadata': {'future': self.model}, 'payload': {
            'app.Model': self.model, 'future.Model': {'instance': {'unknown': {'nested': self.model}}}}}
        raw = json.dumps(payload, ensure_ascii=False)
        expected = store._decode_surface_cache_payload(raw)
        for chunk in [1, 7, 65536, 262144]:
            with mock.patch.object(store, 'decode_json_stream', partial(decode_json_stream, chunk_size=chunk)):
                first = store._decode_surface_cache_payload(io.StringIO(raw))
                second = store._decode_surface_cache_payload(io.StringIO(raw))
            self.assertEqual(first, expected)
            self.assertIsInstance(first['metadata']['future']['instance']['value'], list)
            self.assertIsInstance(first['payload']['future.Model']['instance']['unknown']['nested']['instance']['value'], list)
            self.assertIs(first['payload']['app.Model']['instance']['value'],
                          first['payload']['app.Model']['manager']['duplicate'])
            key1 = next(key for key in first['payload']['app.Model']['instance'] if key == 'duplicate')
            key2 = next(key for key in first['payload']['app.Model']['manager'] if key == 'duplicate')
            key3 = next(key for key in second['payload']['app.Model']['manager'] if key == 'duplicate')
            self.assertIs(key1, key2)
            self.assertIsNot(key1, key3)
            first['metadata']['future']['instance']['value'].append('caller mutation')
            self.assertEqual(second, expected)
        payload['payload']['future.Model']['instance']['literal'] = '한글🙂' * 100000
        self.path.write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
        actual = store._read_cache_payload(self.path, compact_surface_models=True)
        self.assertEqual(json.dumps(actual, sort_keys=True), json.dumps(payload, sort_keys=True))

    def test_partial_io_and_unexpected_failures_close_the_stream(self):
        class Failing(io.StringIO):
            def __init__(self, error):
                super().__init__(json.dumps(self_payload))
                self.error = error
                self.calls = 0
            def read(self, size=-1):
                self.calls += 1
                if self.calls == 2:
                    raise self.error
                return super().read(size)
        self_payload = self.payload
        self.path.write_text(json.dumps(self.payload), encoding='utf-8')
        for error in [OSError('injected partial read failure'), RuntimeError('injected unexpected failure')]:
            stream = Failing(error)
            with mock.patch.object(Path, 'open', return_value=stream):
                if isinstance(error, OSError):
                    self.assertIsNone(store._read_cache_payload(self.path, compact_surface_models=True))
                else:
                    with self.assertRaisesRegex(RuntimeError, 'injected unexpected failure'):
                        store._read_cache_payload(self.path, compact_surface_models=True)
            self.assertTrue(stream.closed)
            self.assertTrue(self.path.exists())

    def test_input_and_hook_owners_release_immediately_on_success_and_failure(self):
        from django_orm_intellisense.cache.json_stream import decode_json_stream
        class Hook:
            def __call__(self, value):
                return value
        for raw in ['{"payload":{"one":{"x":1}}}', '{"payload":{"one":']:
            stream, hook = io.StringIO(raw), Hook()
            stream_ref, hook_ref = weakref.ref(stream), weakref.ref(hook)
            try:
                decode_json_stream(stream, hook, chunk_size=7)
            except json.JSONDecodeError:
                pass
            del stream, hook
            self.assertIsNone(stream_ref())
            self.assertIsNone(hook_ref())

    def test_atomic_replacement_during_chunk_read_keeps_a_complete_opened_snapshot(self):
        from django_orm_intellisense.cache.json_stream import decode_json_stream
        self.path.write_text(json.dumps(self.payload), encoding='utf-8')
        started, resume = threading.Event(), threading.Event()
        original_open = Path.open
        class Held:
            def __init__(self, stream):
                self.stream = stream
                self.first = True
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
                        raise RuntimeError('Held cache read timed out')
                return result
        def opened(path, *args, **kwargs):
            stream = original_open(path, *args, **kwargs)
            return Held(stream) if path == self.path else stream
        current = json.loads(json.dumps(self.payload))
        current['payload']['app.Model']['instance']['value'][3] = 'DateField'
        with ThreadPoolExecutor(max_workers=1) as executor, \
                mock.patch.object(Path, 'open', opened), \
                mock.patch.object(store, 'decode_json_stream', partial(decode_json_stream, chunk_size=7)):
            result = executor.submit(store._read_cache_payload, self.path, compact_surface_models=True)
            try:
                self.assertTrue(started.wait(3))
                store._write_cache_payload(self.path, current)
            finally:
                resume.set()
            old = result.result(timeout=5)
        self.assertEqual(json.dumps(old, sort_keys=True), json.dumps(self.payload, sort_keys=True))
        fresh = store._read_cache_payload(self.path, compact_surface_models=True)
        self.assertEqual(json.dumps(fresh, sort_keys=True), json.dumps(current, sort_keys=True))

    def test_corrupt_static_cache_recovers_through_current_partial_source_restore(self):
        from django_orm_intellisense.discovery.workspace import snapshot_python_sources
        from django_orm_intellisense.static_index.indexer import build_static_index
        root = self.path.parent / 'project'
        root.mkdir()
        source = root / 'models.py'
        source.write_text('from django.db import models\nclass Post(models.Model):\n    value=models.CharField()\n')
        (root / 'helper.py').write_text('value=1\n')
        snapshot = snapshot_python_sources(root)
        index = build_static_index(root, snapshot.files)
        cache = self.path.parent / 'cache'
        with mock.patch.object(store, '_workspace_cache_dir', return_value=cache):
            store.save_static_index(root, snapshot, index)
            bad = cache / store.STATIC_INDEX_FULL_CACHE_NAME
            bad.write_bytes(b'{"payload":"\xff"}')
            actual, hit = store.load_cached_static_index(root, snapshot)
            self.assertEqual(hit, 'partial')
            self.assertEqual(actual.to_cache_dict(), index.to_cache_dict())
            self.assertFalse(bad.exists())
            source.write_text(source.read_text().replace('CharField', 'DateField'))
            current = snapshot_python_sources(root)
            changed, hit = store.load_cached_static_index(root, current)
            self.assertEqual(hit, 'partial')
        self.assertEqual(changed.to_cache_dict(), build_static_index(root, current.files).to_cache_dict())
        self.assertEqual(changed.find_field('models.Post', 'value').field_kind, 'DateField')
        self.assertEqual(index.find_field('models.Post', 'value').field_kind, 'CharField')


if __name__ == '__main__':
    unittest.main()
