"""Decode complete models incrementally without changing surface ownership."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from django_orm_intellisense.cache import store


class SurfaceDecodeCompactionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='djls-surface-decode-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.cache = self.root / 'cache'

    def model(self):
        shared = ['scalar', None, 'method', None]
        return {receiver: {'same': list(shared), 'other': list(shared),
            'title': ['scalar', None, 'field', 'CharField'],
            'custom': ['scalar', None, 'unknown', {'extra': ['a', None, True]}]}
            for receiver in ['model_class', 'manager', 'queryset', 'instance']}

    def load(self, surface):
        with mock.patch.object(store, '_workspace_cache_dir', return_value=self.cache):
            store.save_surface_index(self.root, 'source', 'runtime', surface)
            return store.load_cached_surface_index(self.root, 'source', 'runtime')

    def test_complete_models_compact_during_decode_before_surface_validation(self):
        expected = {'app.Post': self.model(), 'app.Other': self.model()}

        def validate(surface, **kwargs):
            for model in surface.values():
                self.assertIsInstance(model['instance']['same'], tuple)
                self.assertIs(model['instance']['same'], model['queryset']['other'])
            return None

        with mock.patch.object(store, '_surface_index_cache_problem', side_effect=validate):
            actual = self.load(expected)
        self.assertEqual(json.loads(json.dumps(actual)), expected)
        self.assertIsNot(actual['app.Post']['instance'], actual['app.Post']['queryset'])
        self.assertIsNot(actual['app.Post']['instance']['same'], actual['app.Other']['instance']['same'])
        actual['app.Post']['instance']['custom'][3]['extra'].append('mutation')
        self.assertNotIn('mutation', actual['app.Post']['queryset']['custom'][3]['extra'])
        self.assertNotIn('mutation', actual['app.Other']['instance']['custom'][3]['extra'])

    def test_partial_unknown_and_unusual_names_keep_complete_wire_data_and_fallback(self):
        expected = {'__proto__': {'instance': {'constructor': ['scalar', None, 'field', 'DateField'],
            'three': ['scalar', None, 'field'], 'five': ['scalar', None, 'field', 'DateField', 'extra'],
            'boolean': ['scalar', None, 'field', True], 'nested': [['a'], None, 'field', None]}},
            'app.Future': self.model()}
        expected['app.Future']['future_receiver'] = {'a': ['scalar', None, 'field', 'TextField']}
        expected['app.Future']['future_data'] = {'large': '한글' * 50000, 'literal': [[False, None, 2.5]]}
        actual = self.load(expected)
        self.assertEqual(json.loads(json.dumps(actual)), expected)
        self.assertIsInstance(actual['__proto__']['instance']['constructor'], tuple)
        self.assertIsInstance(actual['__proto__']['instance']['three'], list)
        self.assertIsInstance(actual['__proto__']['instance']['boolean'], list)
        self.assertIsInstance(actual['app.Future']['future_receiver']['a'], tuple)

    def test_separate_reads_do_not_share_tuple_pools_or_mutable_maps(self):
        expected = {'app.Post': self.model()}
        first = self.load(expected)
        second = self.load(expected)
        self.assertIsNot(first['app.Post']['instance']['same'], second['app.Post']['instance']['same'])
        first['app.Post']['instance']['title'] = ('scalar', None, 'field', 'DateField')
        self.assertEqual(second['app.Post']['instance']['title'][3], 'CharField')
        self.assertEqual(json.loads(json.dumps(second)), expected)

    def test_cache_metadata_rejection_and_corruption_keep_existing_contract(self):
        expected = {'app.Post': self.model()}
        with mock.patch.object(store, '_workspace_cache_dir', return_value=self.cache):
            store.save_surface_index(self.root, 'source', 'runtime', expected)
            self.assertIsNone(store.load_cached_surface_index(self.root, 'changed-source', 'runtime'))
            self.assertIsNone(store.load_cached_surface_index(self.root, 'source', 'changed-runtime'))
            path = self.cache / store.SURFACE_INDEX_CACHE_NAME
            self.assertTrue(path.exists())
            path.write_text('{broken')
            self.assertIsNone(store.load_cached_surface_index(self.root, 'source', 'runtime'))
            self.assertFalse(path.exists())

    def test_receiver_shaped_unknown_nested_data_is_not_compacted_as_a_model(self):
        expected = {'app.Post': self.model()}
        expected['app.Post']['future_data'] = {'nested': self.model()}
        actual = self.load(expected)
        self.assertEqual(json.loads(json.dumps(actual)), expected)
        nested = actual['app.Post']['future_data']['nested']
        self.assertIsInstance(nested['instance']['same'], list)
        nested['instance']['same'].append('mutable unknown data')
        self.assertEqual(nested['queryset']['same'], expected['app.Post']['future_data']['nested']['queryset']['same'])

    def test_scalar_and_mutable_unknown_members_remain_json_arrays_after_repeated_valid_members(self):
        expected = {'app.Post': self.model(), 'app.Other': self.model()}
        invalid = [False, True, 0, 1, 2.5, [], {}, ['nested'], {'nested': []}]
        for model in expected.values():
            for receiver in ('model_class', 'manager', 'queryset', 'instance'):
                for offset, value in enumerate(invalid):
                    for slot in range(4):
                        member = ['scalar', None, 'method', None]
                        member[slot] = value
                        model[receiver][f'unknown_{offset}_{slot}'] = member
                model[receiver]['none'] = [None, None, None, None]
                model[receiver]['empty'] = ['', '', '', '']
        actual = self.load(expected)
        self.assertEqual(json.loads(json.dumps(actual)), expected)
        for model in actual.values():
            for receiver in ('model_class', 'manager', 'queryset', 'instance'):
                for name, member in model[receiver].items():
                    if name.startswith('unknown_'):
                        self.assertIsInstance(member, list)
                self.assertIs(model[receiver]['none'], model['instance']['none'])
                self.assertIs(model[receiver]['empty'], model['instance']['empty'])
        actual['app.Post']['instance']['unknown_8_0'][0]['nested'].append('mutation')
        self.assertEqual(actual['app.Post']['manager']['unknown_8_0'][0]['nested'], [])
        self.assertEqual(actual['app.Other']['instance']['unknown_8_0'][0]['nested'], [])

    def test_relation_target_type_and_origin_keep_distinct_compact_members(self):
        expected = {'app.Post': self.model()}
        members = [
            ['model_instance', 'app.Author', 'field', 'ForeignKey'],
            ['model_instance', 'app.Editor', 'field', 'ForeignKey'],
            ['model_instance', 'app.Author', 'property', 'ForeignKey'],
            ['model_instance', 'app.Author', 'field', 'OneToOneField'],
        ]
        for receiver in expected['app.Post'].values():
            for offset, member in enumerate(members):
                receiver[f'relation_{offset}'] = list(member)
        actual = self.load(expected)
        self.assertEqual(json.loads(json.dumps(actual)), expected)
        model = actual['app.Post']
        for offset in range(len(members)):
            name = f'relation_{offset}'
            self.assertIs(model['instance'][name], model['manager'][name])
            for other in range(offset):
                self.assertIsNot(model['instance'][name], model['instance'][f'relation_{other}'])


if __name__ == '__main__':
    unittest.main()
