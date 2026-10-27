import copy
import dataclasses
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
from django_orm_intellisense.cache.json_stream import GraphFieldStreamReader, decode_graph_fields_stream
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.static_index.indexer import build_static_index


# Explicit format contract, independent of the implementation's key tuple.
ROW_KEYS = ('modelLabel', 'name', 'filePath', 'line', 'column', 'fieldKind',
    'isRelation', 'relationDirection', 'relatedModelLabel', 'declaredModelLabel',
    'relatedName', 'relatedQueryName', 'source', 'constructorFingerprint',
    'importedConstants', 'declarationModule')


class GraphCacheRowTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='djls-graph-rows-')
        self.addCleanup(temporary.cleanup)
        parent = Path(temporary.name).resolve()
        self.root, self.cache = parent / 'project-한글', parent / 'cache'
        package = self.root / 'blog'; package.mkdir(parents=True)
        (package / '__init__.py').write_text('')
        (package / 'limits.py').write_text('MAX_LENGTH=19\n')
        (package / 'models.py').write_text('from django.db import models\nfrom .limits import MAX_LENGTH\n'
            'class Target(models.Model):\n    key=models.UUIDField(primary_key=True)\n'
            'class Post(models.Model):\n    value=models.CharField(max_length=MAX_LENGTH)\n'
            '    제목=models.CharField(max_length=MAX_LENGTH)\n'
            '    target=models.ForeignKey(Target,on_delete=models.CASCADE,related_name="글들",related_query_name="글")\n')
        self.snapshot = snapshot_python_sources(self.root)
        self.index = build_static_index(self.root, self.snapshot.files)
        self.graph = build_model_graph(self.index, create_pending_runtime_inspection(None))
        self.expected = store._model_graph_to_cache_dict(self.graph)
        patcher = mock.patch.object(store, '_workspace_cache_dir', return_value=self.cache)
        patcher.start(); self.addCleanup(patcher.stop)
        store.save_model_graph(self.root, self.snapshot.fingerprint, 'runtime', self.graph)
        self.path = self.cache / store.MODEL_GRAPH_CACHE_NAME
        self.wire = json.loads(self.path.read_text())

    def load(self, index=None):
        return store.load_cached_model_graph(self.root, self.snapshot.fingerprint, 'runtime',
            static_index=self.index if index is None else index)

    def write(self, wire):
        self.path.write_text(json.dumps(wire, ensure_ascii=False))

    def row(self, wire=None):
        return (self.wire if wire is None else wire)['payload']['fieldRowsByModelLabel']['blog.Post']['value']

    def assert_graph(self, result, expected=None):
        self.assertIsNotNone(result)
        self.assertEqual(store._model_graph_to_cache_dict(result), self.expected if expected is None else expected)

    def test_compact_writer_preserves_every_value_and_raw_dictionary_api(self):
        self.assertEqual(self.wire['metadata']['modelGraphVersion'], 2)
        self.assertNotIn('fieldsByModelLabel', self.wire['payload'])
        for label, fields in self.wire['payload']['fieldRowsByModelLabel'].items():
            for name, row in fields.items():
                self.assertEqual(len(row), 16)
                self.assertEqual(dict(zip(ROW_KEYS, row)), self.expected['fieldsByModelLabel'][label][name])
        for threshold in [0, 1 << 50]:
            with mock.patch.object(store, '_GRAPH_FIELDS_STREAM_MIN_BYTES', threshold):
                result = self.load(); self.assert_graph(result)
                self.assertIs(result.find_field('blog.Post', 'value'), self.index.find_field('blog.Post', 'value'))
                ownerless = store.load_cached_model_graph(self.root, self.snapshot.fingerprint, 'runtime')
                self.assert_graph(ownerless)
                self.assertIsNot(ownerless.find_field('blog.Post', 'value'), self.index.find_field('blog.Post', 'value'))
        raw = store._read_cache_payload(self.path)
        self.assertEqual(raw['payload'], self.expected)
        self.assertIs(type(raw['payload']['fieldsByModelLabel']['blog.Post']['value']), dict)
        self.assert_graph(store._model_graph_from_cache_dict(raw['payload']))
        with self.assertRaises(ValueError):
            store._model_graph_from_cache_dict(copy.deepcopy(self.wire['payload']))
        self.write(raw)
        self.assert_graph(self.load())

    def test_format_one_remains_readable_in_both_decoders(self):
        wire = {'metadata': {**self.wire['metadata'], 'modelGraphVersion': 1}, 'payload': self.expected}
        self.write(wire)
        for threshold in [0, 1 << 50]:
            with mock.patch.object(store, '_GRAPH_FIELDS_STREAM_MIN_BYTES', threshold):
                self.assert_graph(self.load())
        self.assertEqual(store._read_cache_payload(self.path), wire)

    def test_every_changed_position_uses_complete_independent_restoration(self):
        for threshold in [0, 1 << 50]:
            for position, name in enumerate(ROW_KEYS):
                wire = copy.deepcopy(self.wire); row = self.row(wire)
                row[position] = (row[position] + 1 if name in ('line', 'column') else
                    not row[position] if name == 'isRelation' else
                    [['limits.VALUE', 'changed']] if name == 'importedConstants' else 'changed')
                expected = store._field_candidate_from_cache_dict(dict(zip(ROW_KEYS, row)))
                self.write(wire)
                with self.subTest(threshold=threshold, position=name), \
                        mock.patch.object(store, '_GRAPH_FIELDS_STREAM_MIN_BYTES', threshold):
                    actual = self.load().fields_by_model_label['blog.Post']['value']
                    self.assertEqual(actual, expected)
                    self.assertIsNot(actual, self.index.find_field('blog.Post', 'value'))

    def test_coercible_and_mutable_owner_values_are_never_shared(self):
        field = self.index.find_field('blog.Post', 'value')
        for name, value in [('source', []), ('line', float(field.line)), ('related_name', []),
                ('is_relation', 0), ('constructor_fingerprint', ''), ('related_model_label', ''),
                ('declaration_module', ''), ('related_query_name', ''),
                ('imported_constants', [list(pair) for pair in field.imported_constants])]:
            unsafe = dataclasses.replace(field, **{name: value})
            dictionary = store._field_candidate_to_cache_dict(unsafe)
            row = [dictionary[key] for key in ROW_KEYS]
            with self.subTest(owner=name), mock.patch.object(self.index, 'find_field', return_value=unsafe):
                actual = store._restore_graph_field_row(row, self.index, {}.setdefault)
            self.assertIsNot(actual, unsafe)
            self.assertEqual(actual, store._field_candidate_from_cache_dict(dictionary))
            self.assertEqual(type(getattr(actual, name)), type(getattr(store._field_candidate_from_cache_dict(dictionary), name)))

    def test_stale_or_unknown_metadata_rejects_before_hydration(self):
        for threshold in [0, 1 << 50]:
            for metadata in [{'schemaVersion': -1}, {'workspaceRoot': '/elsewhere'},
                    {'sourceFingerprint': 'stale'}, {'runtimeFingerprint': 'stale'}, {'modelGraphVersion': 3}]:
                wire = copy.deepcopy(self.wire); wire['metadata'].update(metadata)
                self.row(wire).pop(); self.write(wire)
                with self.subTest(threshold=threshold, metadata=metadata), \
                        mock.patch.object(store, '_GRAPH_FIELDS_STREAM_MIN_BYTES', threshold), \
                        mock.patch.object(store, '_restore_graph_field_row', side_effect=AssertionError('Stale rows hydrated')):
                    self.assertIsNone(self.load())
                self.assertTrue(self.path.exists())

    def test_malformed_final_rows_fail_closed_and_remove_derived_cache(self):
        for threshold in [0, 1 << 50]:
            for changed in [self.row()[:-1], self.row() + ['future'],
                    [*self.row()[:3], 'bad-line', *self.row()[4:]],
                    [*self.row()[:14], None, self.row()[15]]]:
                wire = copy.deepcopy(self.wire)
                wire['payload']['fieldRowsByModelLabel']['blog.Post']['value'] = changed
                self.write(wire)
                with self.subTest(threshold=threshold, row=changed), \
                        mock.patch.object(store, '_GRAPH_FIELDS_STREAM_MIN_BYTES', threshold):
                    self.assertIsNone(self.load())
                self.assertFalse(self.path.exists())
                self.assertEqual(self.index.find_field('blog.Post', 'value').field_kind, 'CharField')

    def test_duplicates_late_metadata_and_codec_changes_follow_final_json_values(self):
        metadata, payload = json.dumps(self.wire['metadata']), json.dumps(self.wire['payload'])
        model = json.dumps(self.wire['payload']['fieldRowsByModelLabel']['blog.Post'])
        stale = json.dumps({**self.wire['metadata'], 'sourceFingerprint': 'stale'})
        legacy = json.dumps({**self.wire['metadata'], 'modelGraphVersion': 1})
        both = copy.deepcopy(self.wire['payload']); both['fieldsByModelLabel'] = copy.deepcopy(self.expected['fieldsByModelLabel'])
        both['fieldRowsByModelLabel']['blog.Post']['value'][5] = 'DateField'
        good = [
            '{"payload":' + payload + ',"metadata":' + metadata + '}',
            json.dumps(self.wire).replace('"blog.Post": ' + model, '"blog.Post":{"value":[]},"blog.Post": ' + model),
            '{"metadata":' + metadata + ',"payload":{"fieldRowsByModelLabel":{"blog.Post":{"value":[]}}},"payload":' + payload + '}',
            '{"metadata":' + stale + ',"payload":' + payload + ',"metadata":' + metadata + '}',
            '{"metadata":' + legacy + ',"payload":' + payload + ',"metadata":' + metadata + '}',
            '{"metadata":' + metadata + ',"payload":' + json.dumps(both) + ',"metadata":' + legacy + '}',
        ]
        for threshold in [0, 1 << 50]:
            for chunk in [1, 7, 64, 262144]:
                for raw in good:
                    self.path.write_text(raw)
                    with self.subTest(threshold=threshold, chunk=chunk, raw=raw[:90]), \
                            mock.patch.object(store, '_GRAPH_FIELDS_STREAM_MIN_BYTES', threshold), \
                            mock.patch.object(store, 'decode_graph_fields_stream', partial(decode_graph_fields_stream, chunk_size=chunk)):
                        self.assert_graph(self.load())
                    self.assertTrue(self.path.exists())
                self.path.write_text('{"metadata":' + metadata + ',"payload":' + payload + ',"metadata":' + stale + '}')
                with mock.patch.object(store, '_GRAPH_FIELDS_STREAM_MIN_BYTES', threshold):
                    self.assertIsNone(self.load())
                self.assertTrue(self.path.exists())

    def test_future_nested_rows_and_unknown_formats_remain_json_values(self):
        future = {'fieldRowsByModelLabel': self.wire['payload']['fieldRowsByModelLabel']}
        wire = copy.deepcopy(self.wire)
        wire['metadata']['future'] = copy.deepcopy(future)
        wire['payload']['future'] = copy.deepcopy(future)
        wire['payload']['literal'] = '한글🙂' * 10000
        self.write(wire)
        raw = store._read_cache_payload(self.path)
        self.assertEqual(raw['metadata']['future'], future)
        self.assertEqual(raw['payload']['future'], future)
        for version in [1, 3]:
            wire['metadata']['modelGraphVersion'] = version; self.write(wire)
            self.assertEqual(store._read_cache_payload(self.path), wire)
        for chunk in [1, 7, 64, 262144]:
            with mock.patch.object(store, 'decode_graph_fields_stream', partial(decode_graph_fields_stream, chunk_size=chunk)):
                decoded = store._decode_graph_cache_payload(io.StringIO(json.dumps(wire)), self.index)
            self.assertEqual(decoded, wire)

    def test_failed_size_hint_keeps_readable_small_cache(self):
        with mock.patch.object(Path, 'stat', side_effect=OSError('size hint unavailable')), \
                mock.patch.object(store, '_decode_graph_cache_payload', side_effect=AssertionError('Failed hint streamed')):
            self.assert_graph(self.load())

    def test_read_local_strings_and_mutable_graph_maps_have_separate_lifetimes(self):
        wire = copy.deepcopy(self.wire)
        for row in wire['payload']['fieldRowsByModelLabel']['blog.Post'].values():
            row[12] = 'runtime'
        self.write(wire)
        for threshold in [0, 1 << 50]:
            with mock.patch.object(store, '_GRAPH_FIELDS_STREAM_MIN_BYTES', threshold):
                first, second = self.load(), self.load()
            value, other = first.find_field('blog.Post', 'value'), first.find_field('blog.Post', '제목')
            self.assertIs(value.file_path, other.file_path)
            self.assertIs(value.source, other.source)
            self.assertIsNot(value.file_path, second.find_field('blog.Post', 'value').file_path)
            first.fields_by_model_label['blog.Post'].pop('value')
            self.assertIsNotNone(second.find_field('blog.Post', 'value'))
            self.assertIs(type(other.imported_constants), tuple)

    def test_parallel_restores_share_only_their_supplied_immutable_owner(self):
        other = build_static_index(self.root, self.snapshot.files)
        reference = weakref.ref(other)
        for threshold in [0, 1 << 50]:
            with mock.patch.object(store, '_GRAPH_FIELDS_STREAM_MIN_BYTES', threshold), ThreadPoolExecutor(max_workers=2) as pool:
                first, second = list(pool.map(self.load, [self.index, other]))
            self.assertIs(first.find_field('blog.Post', 'value'), self.index.find_field('blog.Post', 'value'))
            self.assertIs(second.find_field('blog.Post', 'value'), other.find_field('blog.Post', 'value'))
            self.assertIsNot(first.find_field('blog.Post', 'value'), second.find_field('blog.Post', 'value'))
        del other
        self.assertIsNone(reference())
        self.assert_graph(second)

    def test_atomic_replacement_during_stream_uses_one_opened_snapshot(self):
        started, resume = threading.Event(), threading.Event()
        original_open = Path.open
        class Held:
            def __init__(self, stream): self.stream, self.first = stream, True
            def __enter__(self): return self
            def __exit__(self, *args): self.stream.close()
            def read(self, size=-1):
                result = self.stream.read(size)
                if self.first:
                    self.first = False; started.set()
                    if not resume.wait(5): raise RuntimeError('Read not resumed')
                return result
        def opened(path, *args, **kwargs):
            stream = original_open(path, *args, **kwargs)
            return Held(stream) if path == self.path else stream
        changed = copy.deepcopy(self.wire); self.row(changed)[5] = 'DateField'
        with mock.patch.object(store, '_GRAPH_FIELDS_STREAM_MIN_BYTES', 0), \
                mock.patch.object(Path, 'open', opened), \
                mock.patch.object(store, 'decode_graph_fields_stream', partial(decode_graph_fields_stream, chunk_size=7)), \
                ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.load)
            try:
                self.assertTrue(started.wait(3)); store._write_cache_payload(self.path, changed)
            finally:
                resume.set()
            previous = pending.result(timeout=5)
        self.assert_graph(previous)
        self.assertEqual(self.load().find_field('blog.Post', 'value').field_kind, 'DateField')

    def test_reader_releases_row_callback_on_success_and_error(self):
        class Hook:
            def __call__(self, value): return value
        for raw in [json.dumps(self.wire), '{"payload":{"fieldRowsByModelLabel":']:
            row_hook = Hook(); reference = weakref.ref(row_hook)
            reader = GraphFieldStreamReader(io.StringIO(raw), Hook(), Hook(), 7, Hook(), row_hook)
            try:
                reader.read()
            except json.JSONDecodeError:
                pass
            del row_hook
            self.assertIsNone(reference())
            self.assertIsNone(reader.restore_model_rows)
            self.assertIsNone(reader.stream)


if __name__ == '__main__':
    unittest.main()
