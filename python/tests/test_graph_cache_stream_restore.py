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
from django_orm_intellisense.cache.json_stream import GraphFieldStreamReader, decode_graph_fields_stream
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection
from django_orm_intellisense.server import app
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.static_index.indexer import FieldCandidate, build_static_index


class GraphCacheStreamRestoreTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='djls-graph-stream-test-')
        self.addCleanup(temporary.cleanup)
        parent = Path(temporary.name).resolve()
        self.root, self.cache = parent / 'project', parent / 'cache'
        package = self.root / 'blog'; package.mkdir(parents=True)
        (package / '__init__.py').write_text('')
        (package / 'limits.py').write_text('MAX_LENGTH=19\n')
        (package / 'models.py').write_text('from django.db import models\nfrom .limits import MAX_LENGTH\n'
            'class Target(models.Model):\n    code=models.CharField(primary_key=True)\n'
            'class Post(models.Model):\n    value=models.CharField(max_length=MAX_LENGTH)\n'
            '    target=models.ForeignKey(Target,on_delete=models.CASCADE,related_name="posts")\n')
        self.snapshot = snapshot_python_sources(self.root)
        self.index = build_static_index(self.root, self.snapshot.files)
        self.runtime = create_pending_runtime_inspection(None)
        self.graph = build_model_graph(self.index, self.runtime)
        for patcher in [mock.patch.object(store, '_workspace_cache_dir', return_value=self.cache),
                mock.patch.object(store, '_GRAPH_FIELDS_STREAM_MIN_BYTES', 0)]:
            patcher.start(); self.addCleanup(patcher.stop)
        self.runtime_fingerprint = app._runtime_cache_fingerprint(self.runtime)
        store.save_model_graph(self.root, self.snapshot.fingerprint, self.runtime_fingerprint, self.graph)
        self.path = self.cache / store.MODEL_GRAPH_CACHE_NAME
        # Keep the original dictionary-format regression corpus independent
        # of the current writer. Format-2 rows have their own boundary tests.
        self.wire = store._read_cache_payload(self.path)
        self.wire['metadata']['modelGraphVersion'] = 1
        self.path.write_text(json.dumps(self.wire))
        self.expected = store._model_graph_to_cache_dict(self.graph)

    def load(self, index=None):
        return store.load_cached_model_graph(self.root, self.snapshot.fingerprint, self.runtime_fingerprint,
            static_index=self.index if index is None else index)

    def tiny(self):
        return {'metadata': self.wire['metadata'], 'payload': {'fieldsByModelLabel': {'blog.Post': {
            'value': self.wire['payload']['fieldsByModelLabel']['blog.Post']['value']}}, 'nodesByLabel': {}, 'edgesBySourceLabel': {}}}

    def test_streamed_restore_preserves_full_graph_aliases_and_public_raw_behavior(self):
        with mock.patch.object(Path, 'read_text', side_effect=AssertionError('Whole graph input text')):
            restored = self.load()
        self.assertEqual(store._model_graph_to_cache_dict(restored), self.expected)
        self.assertIs(restored.find_field('blog.Post', 'value'), self.index.find_field('blog.Post', 'value'))
        without_owner = store.load_cached_model_graph(self.root, self.snapshot.fingerprint, self.runtime_fingerprint)
        self.assertEqual(store._model_graph_to_cache_dict(without_owner), self.expected)
        self.assertIsNot(without_owner.find_field('blog.Post', 'value'), restored.find_field('blog.Post', 'value'))
        wire = store._read_cache_payload(self.path)
        self.assertEqual(wire, self.wire)
        self.assertIs(type(wire['payload']['fieldsByModelLabel']['blog.Post']['value']), dict)
        raw = copy.deepcopy(self.wire['payload'])
        raw['fieldsByModelLabel']['blog.Post']['value'] = self.index.find_field('blog.Post', 'value')
        self.assertIsNone(store._model_graph_from_cache_dict(raw).find_field('blog.Post', 'value'))

    def test_duplicate_models_payloads_and_metadata_keep_full_json_precedence(self):
        wire = self.tiny(); model = json.dumps(wire['payload']['fieldsByModelLabel']['blog.Post'])
        expected = store._model_graph_to_cache_dict(store._model_graph_from_cache_dict(wire['payload']))
        raw = json.dumps(wire)
        stale = {**wire['metadata'], 'sourceFingerprint': 'stale'}
        cases = [raw.replace('"blog.Post": ' + model, '"blog.Post":{"value":{}},"blog.Post": ' + model),
            '{"metadata":' + json.dumps(wire['metadata']) + ',"payload":{"fieldsByModelLabel":{"blog.Post":{"value":{}}}},"payload":'
                + json.dumps(wire['payload']) + '}',
            '{"metadata":' + json.dumps(stale) + ',"payload":' + json.dumps(wire['payload'])
                + ',"metadata":' + json.dumps(wire['metadata']) + '}']
        for chunk in [1, 7, 64, 262144]:
            for value in cases:
                with self.subTest(chunk=chunk):
                    self.path.write_text(value)
                    with mock.patch.object(store, 'decode_graph_fields_stream', partial(decode_graph_fields_stream, chunk_size=chunk)):
                        self.assertEqual(store._model_graph_to_cache_dict(self.load()), expected)
                    self.assertTrue(self.path.exists())

    def test_stale_and_late_metadata_defer_hydration_and_invalid_record_errors(self):
        invalid = self.tiny(); invalid['metadata'] = {**invalid['metadata'], 'sourceFingerprint': 'stale'}
        invalid['payload']['fieldsByModelLabel']['blog.Post']['value'] = {}
        self.path.write_text(json.dumps(invalid))
        with mock.patch.object(store, '_restore_graph_field', side_effect=AssertionError('Stale graph hydrated')):
            self.assertIsNone(self.load())
        self.assertTrue(self.path.exists())
        late = json.dumps(invalid)[:-1] + ',"metadata":' + json.dumps(self.wire['metadata']) + '}'
        self.path.write_text(late)
        self.assertIsNone(self.load()); self.assertFalse(self.path.exists())
        original = store._restore_graph_field
        def restore(field, index):
            if 'line' not in field: raise RuntimeError('injected invalid-field failure')
            return original(field, index)
        model = json.dumps(self.tiny()['payload']['fieldsByModelLabel']['blog.Post'])
        raw = json.dumps(self.tiny()).replace('"blog.Post": ' + model, '"blog.Post":{"value":{}},"blog.Post": ' + model)
        self.path.write_text(raw)
        with mock.patch.object(store, '_restore_graph_field', restore):
            self.assertIsNotNone(self.load())
        self.path.write_text(json.dumps(invalid)[:-1] + ',"metadata":' + json.dumps(self.wire['metadata']) + '}')
        with mock.patch.object(store, '_restore_graph_field', restore), self.assertRaisesRegex(RuntimeError, 'invalid-field failure'):
            self.load()
        self.assertTrue(self.path.exists())

    def test_small_graph_and_failed_size_hint_keep_readable_fallback(self):
        with mock.patch.object(store, '_GRAPH_FIELDS_STREAM_MIN_BYTES', 4 * 1024 * 1024), \
                mock.patch.object(store, '_decode_graph_cache_payload', side_effect=AssertionError('Small graph streamed')):
            self.assertEqual(store._model_graph_to_cache_dict(self.load()), self.expected)
        with mock.patch.object(Path, 'stat', side_effect=OSError('size hint unavailable')), \
                mock.patch.object(store, '_decode_graph_cache_payload', side_effect=AssertionError('Failed hint streamed')):
            self.assertEqual(store._model_graph_to_cache_dict(self.load()), self.expected)

    def test_invalid_json_utf8_and_final_field_data_are_recoverable_misses(self):
        broken = copy.deepcopy(self.wire); broken['payload']['fieldsByModelLabel']['blog.Post']['value'].pop('line')
        for raw in [b'{"metadata":', b'{"payload":"\xff"}', json.dumps(broken).encode(),
                    json.dumps(self.wire).encode() + b' trailing']:
            self.path.write_bytes(raw)
            self.assertIsNone(self.load()); self.assertFalse(self.path.exists())
            self.assertEqual(self.index.find_field('blog.Post', 'value').field_kind, 'CharField')

    def test_future_nested_shapes_unicode_and_large_literals_stay_json_values(self):
        field_map = self.tiny()['payload']['fieldsByModelLabel']
        future = {'metadata': {'payload': {'fieldsByModelLabel': field_map}},
            'payload': {'future': {'fieldsByModelLabel': field_map}, 'literal': '한글🙂',
                'fieldsByModelLabel': {'future.Model': [1, True, None]}}}
        for chunk in [1, 7, 64, 262144]:
            with mock.patch.object(store, 'decode_graph_fields_stream', partial(decode_graph_fields_stream, chunk_size=chunk)):
                result = store._decode_graph_cache_payload(io.StringIO(json.dumps(future, ensure_ascii=False)), self.index)
            self.assertEqual(result, future)
        future['payload']['literal'] *= 100000
        self.assertEqual(store._decode_graph_cache_payload(io.StringIO(json.dumps(future, ensure_ascii=False)), self.index), future)

    def test_partial_io_and_unexpected_failures_close_without_removing_cache(self):
        raw = json.dumps(self.wire)
        class Failing(io.StringIO):
            def __init__(self, error):
                super().__init__(raw); self.error = error; self.calls = 0
            def read(self, size=-1):
                self.calls += 1
                if self.calls == 2: raise self.error
                return super().read(7)
        for error in [OSError('injected I/O failure'), RuntimeError('injected unexpected failure')]:
            stream = Failing(error)
            with mock.patch.object(Path, 'open', return_value=stream):
                if isinstance(error, OSError): self.assertIsNone(self.load())
                else:
                    with self.assertRaisesRegex(RuntimeError, 'unexpected failure'): self.load()
            self.assertTrue(stream.closed); self.assertTrue(self.path.exists())

    def test_atomic_replacement_during_restore_uses_one_complete_opened_snapshot(self):
        started, resume = threading.Event(), threading.Event(); original_open = Path.open
        class Held:
            def __init__(self, stream): self.stream = stream; self.first = True
            def __enter__(self): return self
            def __exit__(self, *args): self.stream.close()
            def read(self, size=-1):
                value = self.stream.read(size)
                if self.first:
                    self.first = False; started.set()
                    if not resume.wait(5): raise RuntimeError('Graph read was not released')
                return value
        def opened(path, *args, **kwargs):
            stream = original_open(path, *args, **kwargs)
            return Held(stream) if path == self.path else stream
        changed = copy.deepcopy(self.wire)
        changed['payload']['fieldsByModelLabel']['blog.Post']['value']['fieldKind'] = 'DateField'
        with ThreadPoolExecutor(max_workers=1) as pool, mock.patch.object(Path, 'open', opened), \
                mock.patch.object(store, 'decode_graph_fields_stream', partial(decode_graph_fields_stream, chunk_size=7)):
            pending = pool.submit(self.load)
            try:
                self.assertTrue(started.wait(3)); store._write_cache_payload(self.path, changed)
            finally: resume.set()
            previous = pending.result(timeout=5)
        self.assertEqual(store._model_graph_to_cache_dict(previous), self.expected)
        self.assertEqual(self.load().find_field('blog.Post', 'value').field_kind, 'DateField')
        self.assertEqual(self.index.find_field('blog.Post', 'value').field_kind, 'CharField')

    def test_reader_and_static_owner_release_without_collecting_garbage(self):
        class Owner: pass
        class Hook:
            def __init__(self, owner): self.owner = owner
            def __call__(self, value): return value
        for raw in ['{"payload":{"fieldsByModelLabel":{"one":{}}}}', '{"payload":{"fieldsByModelLabel":']:
            owner = Owner(); stream = io.StringIO(raw); hook, restorer, matcher = Hook(owner), Hook(owner), Hook(owner)
            refs = [weakref.ref(value) for value in [owner, stream, hook, restorer, matcher]]
            reader = GraphFieldStreamReader(stream, hook, restorer, 7, matcher)
            try: reader.read()
            except json.JSONDecodeError: pass
            del owner, stream, hook, restorer, matcher
            self.assertTrue(all(value() is None for value in refs))
            self.assertIsNone(reader.restore_model_fields); self.assertIsNone(reader.metadata_matches)
            self.assertIsNone(reader.stream); self.assertIsNone(reader.decoder)
        other = build_static_index(self.root, self.snapshot.files); reference = weakref.ref(other)
        restored = self.load(other); del other
        self.assertIsNone(reference())
        self.assertEqual(store._model_graph_to_cache_dict(restored), self.expected)

    def test_parallel_restores_keep_read_local_containers_and_static_owners(self):
        other = build_static_index(self.root, self.snapshot.files)
        with ThreadPoolExecutor(max_workers=2) as pool:
            first, second = list(pool.map(self.load, [self.index, other]))
        self.assertIs(first.find_field('blog.Post', 'value'), self.index.find_field('blog.Post', 'value'))
        self.assertIs(second.find_field('blog.Post', 'value'), other.find_field('blog.Post', 'value'))
        self.assertIsNot(first.find_field('blog.Post', 'value'), second.find_field('blog.Post', 'value'))
        first.fields_by_model_label['blog.Post'].pop('value')
        self.assertEqual(store._model_graph_to_cache_dict(second), self.expected)
        self.assertIs(type(second.find_field('blog.Post', 'value')), FieldCandidate)


if __name__ == '__main__': unittest.main()
