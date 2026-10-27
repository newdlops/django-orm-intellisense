import copy
import io
import json
import unittest
import weakref

from django_orm_intellisense.cache import surface_records as records


def fixture():
    return {'instance': {'long_field_name_for_cross_record_identity': ['scalar', None, 'field', 'CharField'],
        'alias': ['scalar', None, 'field', 'CharField'], 'future': {'values': [1, None, True]}},
        'queryset': {'long_field_name_for_cross_record_identity': ['scalar', None, 'field', 'CharField'],
            'filter': ['queryset', 'app.Model', 'method', None]}}


class SurfaceRowSharedConstructionTests(unittest.TestCase):
    def read(self, text, chunk_size=262144):
        reader = records.SurfaceRecordStreamReader(io.StringIO(text), chunk_size=chunk_size)
        payload = reader.read()
        self.assertEqual(reader.names, {})
        self.assertEqual(reader.buffer, '')
        return records.restore_surface_rows(payload['payload'])

    def test_owned_stream_matches_generic_complete_values_and_member_aliases(self):
        entry = fixture()
        row = json.loads(json.dumps(records.model_to_row(entry)))
        expected = records.model_from_row(copy.deepcopy(row), {}.setdefault)
        result = self.read(json.dumps({'payload': {'app.Model': row}}))['app.Model']
        self.assertEqual(result, expected)
        self.assertIs(result['instance']['alias'], result['instance']['long_field_name_for_cross_record_identity'])
        self.assertIs(result['instance']['alias'], result['queryset']['long_field_name_for_cross_record_identity'])

    def test_member_and_receiver_keys_share_across_separately_decoded_models(self):
        row = json.loads(json.dumps(records.model_to_row(fixture())))
        result = self.read(json.dumps({'payload': {'app.A': row, 'app.B': row}}))
        left, right = result['app.A'], result['app.B']
        self.assertIs(next(iter(left)), next(iter(right)))
        name = 'long_field_name_for_cross_record_identity'
        a = next(k for k in left['instance'] if k == name)
        b = next(k for k in left['queryset'] if k == name)
        c = next(k for k in right['instance'] if k == name)
        self.assertIs(a, b)
        self.assertIs(a, c)

    def test_separate_reads_and_receivers_own_mutable_tables(self):
        text = json.dumps({'payload': {'app.Model': json.loads(json.dumps(records.model_to_row(fixture())))}})
        a, b = self.read(text)['app.Model'], self.read(text)['app.Model']
        self.assertIsNot(a, b)
        self.assertIsNot(a['instance'], a['queryset'])
        self.assertIsNot(a['instance'], b['instance'])
        a['instance']['future']['values'].append('changed')
        self.assertEqual(b['instance']['future']['values'], [1, None, True])

    def test_literal_receivers_unknown_shapes_and_literal_compaction_survive(self):
        row = [1, [['scalar', None, 'field', 'CharField']], {
            'raw': [0, {'same': ['scalar', None, 'field', 'CharField'], 'future': {'a': 1}}],
            'scalar': [0, 17], 'mixed': [1, {'ref': 0}, {'literal': ['scalar', None, 'field', 'CharField']}]}]
        result = self.read(json.dumps({'payload': {'app.Model': row}}))['app.Model']
        expected = records.model_from_row(copy.deepcopy(row), {}.setdefault)
        self.assertEqual(result, expected)
        self.assertIs(result['raw']['same'], result['mixed']['ref'])
        self.assertIs(result['mixed']['literal'], result['mixed']['ref'])

    def test_generic_default_still_uses_custom_share_and_defensive_container_copy(self):
        row = json.loads(json.dumps(records.model_to_row(fixture())))
        calls = []
        names = {}
        def share(key, value):
            calls.append(key)
            return names.setdefault(key, value)
        result = records.model_from_row(row, share)
        self.assertTrue(calls)
        self.assertEqual(result, records.model_from_row(copy.deepcopy(row)))
        self.assertIsNot(result['instance'], row[2]['instance'][2])
        result['instance']['added'] = 'own'
        self.assertNotIn('added', row[2]['instance'][2])

    def test_invalid_references_and_overlaps_are_still_rejected(self):
        for index in (True, -1, 1, '0'):
            row = [1, [['scalar', None, 'field', 'CharField']], {'instance': [1, {'x': index}, {}]}]
            with self.subTest(index=index), self.assertRaises(ValueError):
                self.read(json.dumps({'payload': {'app.Model': row}}))
        row = [1, [['scalar', None, 'field', 'CharField']], {'instance': [1, {'x': 0}, {'x': 1}]}]
        with self.assertRaises(ValueError):
            self.read(json.dumps({'payload': {'app.Model': row}}))

    def test_last_duplicate_record_and_payload_win_after_invalid_rows(self):
        valid = json.dumps(json.loads(json.dumps(records.model_to_row(fixture()))))
        bad = json.dumps([1, [], {'instance': [1, {'x': -1}, {}]}])
        for text in ('{"payload":{"app.Model":' + bad + ',"app.Model":' + valid + '}}',
            '{"payload":{"app.Model":' + bad + '},"payload":{"app.Model":' + valid + '}}'):
            with self.subTest(text=text[:45]):
                self.assertEqual(self.read(text)['app.Model'], records.model_from_row(json.loads(valid)))

    def test_chunk_boundaries_and_error_release_read_local_owners_without_gc(self):
        text = json.dumps({'payload': {'app.Model': json.loads(json.dumps(records.model_to_row(fixture())))}}, ensure_ascii=False)
        for size in (1, 7, 64, 257):
            with self.subTest(size=size):
                self.assertEqual(self.read(text, size)['app.Model'], records.model_from_row(json.loads(json.dumps(records.model_to_row(fixture())))))
        stream = io.StringIO(text[:-1])
        ref = weakref.ref(stream)
        reader = records.SurfaceRecordStreamReader(stream, chunk_size=7)
        del stream
        with self.assertRaises(json.JSONDecodeError):
            reader.read()
        self.assertIsNone(ref())
        self.assertEqual(reader.names, {})
        self.assertIsNone(reader.stream)
        self.assertEqual(reader.buffer, '')

    def test_scalar_atoms_share_while_distinct_model_labels_and_kinds_survive(self):
        def row(label):
            return [1, [['scalar', label, 'field', 'CharField'],
                ['scalar', label, 'field', 'x' * 257]], {'instance': [1, {'a': 0, 'long': 1}, {}]}]
        result = self.read(json.dumps({'payload': {'app.A': row('app.A'), 'app.B': row('app.B')}}))
        a, b = result['app.A']['instance'], result['app.B']['instance']
        self.assertEqual(a['a'], ('scalar', 'app.A', 'field', 'CharField'))
        self.assertEqual(b['a'], ('scalar', 'app.B', 'field', 'CharField'))
        self.assertIs(a['a'][0], b['a'][0])
        self.assertIs(a['a'][2], b['long'][2])
        self.assertIsNot(a['a'], b['a'])
        self.assertEqual(a['long'][3], 'x' * 257)

    def test_scalar_atom_branch_retains_validation_and_other_wire_shapes(self):
        definitions = [['instance', 'app.A', 'relation', 'ForeignKey'],
            ['scalar_like', None, 'field', 'Custom'], ['scalar', None, 'field_like', None]]
        row = [1, definitions, {'instance': [1, {str(i): i for i in range(3)}, {}]}]
        result = self.read(json.dumps({'payload': {'app.A': row}}))['app.A']
        self.assertEqual(result, records.model_from_row(copy.deepcopy(row)))
        for invalid in (17, {}, True):
            bad = [1, [['scalar', invalid, 'field', 'CharField']], {'instance': [1, {'a': 0}, {}]}]
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.read(json.dumps({'payload': {'app.A': bad}}))



if __name__ == '__main__':
    unittest.main()
