"""Cache string sharing preserves metadata, containers and read ownership."""
import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from django_orm_intellisense.cache.store import _read_cache_payload


class CachePayloadStringTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary.name) / 'cache.json'
        self.file_path = '/project/한글 source/app/models_with_a_long_name.py'

    def tearDown(self):
        self.temporary.cleanup()

    def payload(self):
        return {'payload': [
            {'filePath': self.file_path, 'modelLabel': 'app.ExampleModel', 'fieldKind': 'CharField',
             'name': 'value', 'source': 'static', 'args': ['한글', None, True, 19]},
            {'filePath': self.file_path, 'modelLabel': 'app.ExampleModel', 'fieldKind': 'CharField',
             'name': 'value', 'source': 'static', 'args': ['한글', None, True, 19]}]}

    def test_equal_metadata_values_share_immutable_strings_with_complete_wire_data(self):
        expected = self.payload()
        self.path.write_text(json.dumps(expected, ensure_ascii=False), encoding='utf-8')
        result = _read_cache_payload(self.path)
        self.assertEqual(result, expected)
        self.assertEqual(json.dumps(result, sort_keys=True), json.dumps(expected, sort_keys=True))
        first, second = result['payload']
        for key in ['filePath', 'modelLabel', 'fieldKind', 'name', 'source']:
            self.assertIs(first[key], second[key], f'Duplicate metadata string retained: {key}')
        first['args'].append('caller mutation')
        self.assertEqual(second['args'], expected['payload'][1]['args'])

    def test_separate_reads_preserve_ownership_and_do_not_reuse_a_global_string_pool(self):
        self.path.write_text(json.dumps(self.payload(), ensure_ascii=False), encoding='utf-8')
        first = _read_cache_payload(self.path)
        second = _read_cache_payload(self.path)
        self.assertIsNot(first['payload'][0]['filePath'], second['payload'][0]['filePath'])
        first['payload'][0]['modelLabel'] = 'changed.ByCaller'
        self.assertEqual(second['payload'][0]['modelLabel'], 'app.ExampleModel')
        updated = self.payload()
        updated['payload'][0]['fieldKind'] = 'DateField'
        self.path.write_text(json.dumps(updated, ensure_ascii=False), encoding='utf-8')
        self.assertEqual(_read_cache_payload(self.path), updated)

    def test_large_unknown_data_nested_lists_and_scalar_types_remain_complete(self):
        expected = self.payload()
        expected['payload'][0]['unknown'] = {'literal': '한글' * 50000, 'nested': [[False, None, 1.5], ['extra']]}
        expected['payload'][1]['filePath'] = None
        expected['payload'][1]['constructorFingerprint'] = 19
        self.path.write_text(json.dumps(expected, ensure_ascii=False), encoding='utf-8')
        self.assertEqual(_read_cache_payload(self.path), expected)

    def test_concurrent_reads_keep_independent_pools(self):
        self.path.write_text(json.dumps(self.payload(), ensure_ascii=False), encoding='utf-8')
        with ThreadPoolExecutor(max_workers=2) as executor:
            values = list(executor.map(_read_cache_payload, [self.path, self.path]))
        self.assertEqual(values[0], values[1])
        self.assertIsNot(values[0]['payload'][0]['filePath'], values[1]['payload'][0]['filePath'])
        for value in values:
            self.assertIs(value['payload'][0]['filePath'], value['payload'][1]['filePath'])

    def test_missing_malformed_and_non_object_caches_keep_existing_contract(self):
        self.assertIsNone(_read_cache_payload(self.path))
        self.path.write_text('{broken')
        self.assertIsNone(_read_cache_payload(self.path))
        self.assertFalse(self.path.exists())
        self.path.write_text('[1, 2, 3]')
        self.assertIsNone(_read_cache_payload(self.path))
        self.assertTrue(self.path.exists())
