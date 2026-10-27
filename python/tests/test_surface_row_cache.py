"""Persistent member tables preserve complete values, ownership and old caches."""
import copy
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from django_orm_intellisense.cache import store, surface_records
from tests import test_initialize_cached_surface as cached_surface_tests


class SurfaceRowCacheTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='djls-surface-rows-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.cache = self.root / 'cache'
        self.patch = mock.patch.object(store, '_workspace_cache_dir', return_value=self.cache)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.path = self.cache / store.SURFACE_INDEX_CACHE_NAME

    def surface(self):
        shared = ('scalar', None, 'method', None)
        return {label: {receiver: {'same': shared, 'other': shared,
            'title': ('scalar', None, 'field', 'CharField'),
            'unknown': ['scalar', None, 'method', {'nested': []}]}
            for receiver in ['instance', 'model_class', 'manager', 'queryset', 'related_manager']}
            for label in ['app.Post', 'app.Other']}

    def save(self, surface=None):
        surface = self.surface() if surface is None else surface
        store.save_surface_index(self.root, 'source', 'runtime', surface,
            surface_fingerprints={name: 'a' * 32 for name in surface})
        return json.loads(self.path.read_text())

    def load(self):
        return store.load_cached_surface_index(self.root, 'source', 'runtime')

    def write(self, payload):
        self.path.write_text(json.dumps(payload))

    def wire(self, value):
        return json.loads(json.dumps(value))

    def test_exact_surface_values_and_per_model_immutable_sharing(self):
        original = self.surface();payload = self.save(original)
        self.assertEqual(payload['metadata']['surfaceIndexVersion'], 4)
        self.assertIsInstance(payload['payload']['app.Post'], list)
        actual = self.load()
        self.assertEqual(self.wire(actual), self.wire(original))
        for model in actual.values():
            self.assertIs(model['instance']['same'], model['queryset']['other'])
            self.assertIsNot(model['instance'], model['queryset'])
        self.assertIsNot(actual['app.Post']['instance']['same'], actual['app.Other']['instance']['same'])
        actual['app.Post']['instance']['unknown'][3]['nested'].append('mutation')
        self.assertEqual(actual['app.Post']['queryset']['unknown'][3]['nested'], [])
        self.assertEqual(actual['app.Other']['instance']['unknown'][3]['nested'], [])

    def test_legacy_three_remains_readable_without_eager_rewrite(self):
        original = self.surface();payload = self.save(original)
        payload['metadata']['surfaceIndexVersion'] = 3
        payload['payload'] = self.wire(original);self.write(payload)
        before = self.path.read_bytes();actual = self.load()
        self.assertEqual(self.wire(actual), self.wire(original))
        self.assertEqual(self.path.read_bytes(), before)
        self.assertIs(actual['app.Post']['instance']['same'], actual['app.Post']['manager']['other'])

    def test_separate_reads_and_replaced_members_keep_owned_containers(self):
        self.save();first = self.load();second = self.load()
        self.assertIsNot(first['app.Post']['instance']['same'], second['app.Post']['instance']['same'])
        first['app.Post']['instance']['same'] = ('scalar', None, 'field', 'DateField')
        self.assertEqual(second['app.Post']['instance']['same'], ('scalar', None, 'method', None))
        first['app.Post']['instance']['unknown'][3]['nested'].append('mutation')
        self.assertEqual(second['app.Post']['instance']['unknown'][3]['nested'], [])

    def test_unknown_model_receiver_member_and_nested_receiver_shapes_preserve_json(self):
        original = self.surface();original['literal_model'] = [False, {'nested': []}]
        original['app.Post']['literal_receiver'] = [1, 'value']
        original['app.Post']['future'] = {'nested': self.wire(self.surface()['app.Post']),
            'constructor': ['scalar', None, 'field', True], 'three': ['scalar', None, 'field']}
        self.save(original);actual = self.load()
        self.assertEqual(self.wire(actual), self.wire(original))
        self.assertIsInstance(actual['app.Post']['future']['nested']['instance']['same'], list)
        self.assertIsInstance(actual['app.Post']['future']['constructor'], list)

    def test_json_normalized_subclasses_keep_legacy_compaction(self):
        class Dictionary(dict):pass
        class Sequence(list):pass
        class String(str):pass
        original = {'app.Post': Dictionary({receiver: Dictionary({'same': Sequence(['scalar', None, String('method'), None])})
            for receiver in ['instance', 'manager']})}
        self.save(original);actual = self.load()
        self.assertEqual(self.wire(actual), self.wire(original))
        self.assertIsInstance(actual['app.Post']['instance']['same'], tuple)
        self.assertIs(actual['app.Post']['instance']['same'], actual['app.Post']['manager']['same'])

    def test_literal_normalization_shares_only_valid_members_with_definitions(self):
        row = [1, [['scalar', None, 'method', None]], {
            'instance': [1, {'known': 0}, {'literal': ['scalar', None, 'method', None],
                'invalid': ['scalar', None, 'method', True]}],
            'manager': [0, {'literal': ['scalar', None, 'method', None]}]}]
        payload = self.save();payload['payload'] = {'app.Post': row};self.write(payload)
        actual = self.load()['app.Post']
        self.assertIs(actual['instance']['known'], actual['instance']['literal'])
        self.assertIs(actual['instance']['known'], actual['manager']['literal'])
        self.assertIsInstance(actual['instance']['invalid'], list)

    def test_malformed_tables_references_tags_and_definition_values_reject_cache(self):
        original = [1, [['scalar', None, 'field', 'CharField']], {'instance': [1, {'title': 0}, {}]}]
        cases = [None, {}, [], [True, [], {}], [2, [], {}], [1, {}, {}], [1, [], []],
            [0], [0, {}, 'extra'], [1, [['scalar', None, 'field']], {}],
            [1, [['scalar', None, 'field', True]], {}], [1, [['scalar', None, 'field', {}]], {}]]
        for value in [-1, 1, True, 0.0, '0', None]:
            row = copy.deepcopy(original);row[2]['instance'][1]['title'] = value;cases.append(row)
        for value in [None, [], [False, {}, {}], [2, {}, {}], [1, [], {}], [1, {}, []],
                      [1, {'title': 0}, {'title': ['scalar', None, 'field', 'DateField']}]]:
            row = copy.deepcopy(original);row[2]['instance'] = value;cases.append(row)
        for row in cases:
            with self.subTest(row=row):
                payload = self.save();payload['payload'] = {'app.Post': row};self.write(payload)
                self.assertIsNone(self.load());self.assertFalse(self.path.exists())

    def test_invalid_superseded_models_and_payloads_do_not_change_last_key_wins(self):
        payload = self.save();metadata = json.dumps(payload['metadata']);valid = json.dumps(payload['payload']['app.Post'])
        texts = ['{"metadata":'+metadata+',"payload":{"app.Post":null,"app.Post":'+valid+'}}',
            '{"metadata":'+metadata+',"payload":{"app.Post":null},"payload":{"app.Post":'+valid+'}}']
        for text in texts:
            self.path.write_text(text);self.assertEqual(self.load()['app.Post']['instance']['title'][3], 'CharField')
        self.path.write_text(texts[0] + ' trailing')
        self.assertIsNone(self.load())

    def test_later_legacy_metadata_discards_the_row_decoding_hint(self):
        payload = self.save();first = json.dumps(payload['metadata'])
        payload['metadata']['surfaceIndexVersion'] = 3;last = json.dumps(payload['metadata'])
        # Under final legacy metadata this model is an ordinary unknown JSON
        # array. A leading format-4 hint cannot reinterpret its owner or shape.
        raw = '{"metadata":'+first+',"payload":'+json.dumps(payload['payload'])+',"metadata":'+last+'}'
        self.path.write_text(raw);actual = self.load()
        self.assertEqual(actual, payload['payload'])
        self.assertIsInstance(actual['app.Post'], list)

    def test_late_row_metadata_and_nonseekable_stream_restore_final_payload(self):
        payload = self.save();text = '{"payload":'+json.dumps(payload['payload'])+',"metadata":'+json.dumps(payload['metadata'])+'}'
        self.path.write_text(text);self.assertEqual(self.load()['app.Post']['instance']['title'][3], 'CharField')
        class Nonseekable(io.StringIO):
            def seekable(self):return False
        decoded = store._decode_surface_cache_payload(Nonseekable(text))
        self.assertEqual(decoded['payload']['app.Post']['instance']['title'][3], 'CharField')

    def test_chunk_boundaries_long_metadata_unicode_and_json_errors(self):
        payload = self.save();payload['metadata']['future'] = '한글' * 50000
        text = json.dumps(payload, ensure_ascii=False)
        self.path.write_text(text);self.assertEqual(self.load()['app.Post']['instance']['title'][3], 'CharField')
        self.assertEqual(surface_records.surface_version_hint(io.StringIO(text)), 4)
        short = json.dumps(self.save())
        for size in [1, 7, 63, 1024]:
            decoded = surface_records.SurfaceRecordStreamReader(io.StringIO(short), chunk_size=size).read()
            decoded['payload'] = surface_records.restore_surface_rows(decoded['payload'])
            self.assertEqual(decoded['payload']['app.Post']['instance']['title'][3], 'CharField')
        for malformed in [short[:-1], short + '{}']:
            self.path.write_text(malformed);self.assertIsNone(self.load())

    def test_all_owner_bindings_and_future_versions_keep_normal_miss_behavior(self):
        original = self.save()
        for key,value in [('schemaVersion', -1), ('workspaceRoot', '/other'), ('sourceFingerprint', 'other'),
                          ('runtimeFingerprint', 'other'), ('surfaceIndexVersion', 5)]:
            payload = copy.deepcopy(original);payload['metadata'][key] = value;self.write(payload)
            self.assertIsNone(self.load())

    def fixture(self):
        self.patch.stop()
        fixture = cached_surface_tests.InitializeCachedSurfaceTests();fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        return fixture

    def test_all_nine_initialize_fields_match_legacy_and_rows_with_current_sources(self):
        fixture = self.fixture();rows = fixture.initialize()
        path = store._workspace_cache_dir(fixture.root) / store.SURFACE_INDEX_CACHE_NAME
        payload = json.loads(path.read_text());payload['metadata']['surfaceIndexVersion'] = 3
        payload['payload'] = self.wire(fixture.surface);path.write_text(json.dumps(payload))
        legacy = fixture.initialize()
        for key in ['surfaceIndex', 'surfaceFingerprints', 'sourceProvenance', 'modelNames', 'customLookups',
                    'lookupCatalog', 'customLookupsFingerprint', 'staticFallback', 'staticFallbackFingerprint']:
            self.assertEqual(rows[key], legacy[key], key)

    def test_equal_size_restored_mtime_edit_rejects_old_row_cache_before_publication(self):
        fixture = self.fixture();fixture.edit();actual = fixture.initialize()
        self.assertNotEqual(actual['surfaceIndex'], fixture.surface)
        self.assertEqual(actual['staticFallback']['models.Post']['fieldDetails']['title']['fieldKind'], 'DateField')
