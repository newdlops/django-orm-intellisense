import io
import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from django_orm_intellisense.cache import store


class OrdinaryCacheStreamTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='djls-ordinary-cache-stream-test-')
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / store.MODEL_GRAPH_CACHE_NAME
        self.payload = {'metadata': {'schemaVersion': 34}, 'payload': {'modules': {
            'app.first': {'filePath': '/project/한글/models_with_long_name.py',
                          'modelLabel': 'app.ALongModelName', 'fieldKind': 'CharField', 'args': [None, True, 3]},
            'app.second': {'filePath': '/project/한글/models_with_long_name.py',
                           'modelLabel': 'app.ALongModelName', 'fieldKind': 'CharField', 'args': [None, True, 3]}}}}

    def test_graph_cache_read_avoids_whole_input_text_and_keeps_complete_metadata(self):
        self.path.write_text(json.dumps(self.payload), encoding='utf-8')
        with mock.patch.object(Path, 'read_text', side_effect=AssertionError('Graph cache allocated whole input text')):
            actual = store._read_cache_payload(self.path)
        self.assertEqual(actual, self.payload)
        first, second = actual['payload']['modules'].values()
        for name in ['filePath', 'modelLabel', 'fieldKind']:
            self.assertIs(first[name], second[name])
        self.assertIsNot(first['args'], second['args'])

    def test_depth_three_unicode_numbers_and_unknown_large_values_match_full_decoder(self):
        from django_orm_intellisense.cache.json_stream import MetadataStreamReader
        raw_values = ['{"payload":{"modules":{"one":{"filePath":"x","n":1.23e+200}}}}',
            '{"payload":{"modules":{"one":null,"two":[1,true,"한글🙂"]}}}',
            '{"payload":{"modules":{"one":1,"one":2}}}',
            '{"payload":{"nested":{"model_class":{"x":["scalar",null,"field","CharField"]}}}}']
        original_init = MetadataStreamReader.__init__
        for chunk in [1, 2, 7, 64, 262144]:
            def initialize(reader, stream, hook, **kwargs):
                return original_init(reader, stream, hook, chunk_size=chunk, **kwargs)
            with mock.patch.object(MetadataStreamReader, '__init__', initialize):
                for raw in raw_values:
                    actual = store._decode_cache_payload(io.StringIO(raw))
                    self.assertEqual(actual, store._decode_cache_payload(raw))
                for raw in ['{"payload":{"modules":{"one":', '{"payload":{"modules":{"one":1e}}}',
                            '{"payload":{"modules":{"one":"\\q"}}}', '{} trailing']:
                    with self.assertRaises(json.JSONDecodeError):
                        store._decode_cache_payload(io.StringIO(raw))
        payload = json.loads(json.dumps(self.payload))
        payload['payload']['future'] = {'literal': '한글🙂' * 100000, 'fieldKind': 19, 'filePath': None}
        raw = json.dumps(payload, ensure_ascii=False)
        self.assertEqual(store._decode_cache_payload(io.StringIO(raw)), store._decode_cache_payload(raw))

    def test_parallel_reads_preserve_read_local_key_and_value_pools_and_mutable_containers(self):
        self.path.write_text(json.dumps(self.payload), encoding='utf-8')
        with ThreadPoolExecutor(max_workers=2) as executor:
            first, second = list(executor.map(store._read_cache_payload, [self.path, self.path]))
        first_entries = list(first['payload']['modules'].values())
        second_entries = list(second['payload']['modules'].values())
        self.assertIsNot(first_entries[0]['filePath'], second_entries[0]['filePath'])
        key1 = next(key for key in first_entries[0] if key == 'modelLabel')
        key2 = next(key for key in first_entries[1] if key == 'modelLabel')
        key3 = next(key for key in second_entries[0] if key == 'modelLabel')
        self.assertIs(key1, key2)
        self.assertIsNot(key1, key3)
        first_entries[0]['args'].append('caller mutation')
        self.assertEqual(second, self.payload)
        self.assertEqual(first_entries[1]['args'], [None, True, 3])

    def test_ordinary_read_failure_closes_descriptor_and_does_not_remove_valid_cache(self):
        self.path.write_text(json.dumps(self.payload), encoding='utf-8')
        class Failing(io.StringIO):
            def __init__(self, raw, error):
                super().__init__(raw)
                self.error = error
                self.calls = 0
            def read(self, size=-1):
                self.calls += 1
                if self.calls > 1:
                    raise self.error
                return super().read(size)
        for error in [OSError('injected I/O failure'), RuntimeError('injected unexpected failure')]:
            stream = Failing(json.dumps(self.payload), error)
            with mock.patch.object(Path, 'open', return_value=stream):
                if isinstance(error, OSError):
                    self.assertIsNone(store._read_cache_payload(self.path))
                else:
                    with self.assertRaisesRegex(RuntimeError, 'injected unexpected failure'):
                        store._read_cache_payload(self.path)
            self.assertTrue(stream.closed)
            self.assertTrue(self.path.exists())


if __name__ == '__main__':
    unittest.main()
