import copy
import dataclasses
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from django_orm_intellisense.cache import store
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.server import app
from django_orm_intellisense.static_index.indexer import build_static_index, reindex_single_file


class GraphCacheFieldReuseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='djls-graph-field-reuse-')
        self.addCleanup(self.temporary.cleanup)
        parent = Path(self.temporary.name).resolve()
        self.root = parent / 'project'
        package = self.root / 'blog'
        package.mkdir(parents=True)
        (package / '__init__.py').write_text('')
        (package / 'limits.py').write_text('MAX_LENGTH=19\n')
        self.source = package / 'models.py'
        self.source.write_text('from django.db import models\nfrom .limits import MAX_LENGTH\n'
            'class Target(models.Model):\n    code=models.CharField(primary_key=True)\n'
            'class Base(models.Model):\n    inherited=models.CharField(max_length=MAX_LENGTH)\n'
            '    class Meta:\n        abstract=True\n'
            'class Post(Base):\n    value=models.CharField(max_length=MAX_LENGTH)\n'
            '    target=models.ForeignKey(Target,on_delete=models.CASCADE,related_name="posts",related_query_name="post_query")\n')
        self.snapshot = snapshot_python_sources(self.root)
        self.index = build_static_index(self.root, self.snapshot.files)
        self.runtime = create_pending_runtime_inspection(None)
        self.graph = build_model_graph(self.index, self.runtime)
        self.cache = parent / 'cache'
        patcher = mock.patch.object(store, '_workspace_cache_dir', return_value=self.cache)
        patcher.start()
        self.addCleanup(patcher.stop)
        store.save_static_index(self.root, self.snapshot, self.index)
        runtime_source = app._runtime_source_fingerprint(
            source_snapshot=self.snapshot, static_index=self.index, settings_module=None)
        self.runtime_fingerprint = app._runtime_cache_fingerprint(self.runtime, source_fingerprint=runtime_source)
        store.save_model_graph(self.root, self.snapshot.fingerprint, self.runtime_fingerprint, self.graph)

    def load(self, index=None, *, source=None, runtime=None):
        return store.load_cached_model_graph(self.root, source or self.snapshot.fingerprint,
            runtime or self.runtime_fingerprint, static_index=index or self.index)

    def test_cached_initialize_reuses_exact_frozen_static_fields(self):
        stdout = sys.stdout
        try:
            server = app.DaemonServer(self.root)
        finally:
            sys.stdout = stdout
        server._state_generation = 7
        with mock.patch.object(app, 'load_cached_runtime_inspection', return_value=self.runtime), \
                mock.patch.object(app, 'build_model_graph', side_effect=AssertionError('Cached graph triggered runtime graph rebuilding')), \
                mock.patch.object(server, '_schedule_surface_index_idle_load'), \
                mock.patch.object(server, '_start_runtime_field_registry_prewarm'):
            initialized = server._initialize_from_source_snapshot(generation=7,
                initialized_at=server.initialized_at, workspace_root=self.root,
                settings_module=None, defer_runtime=False, venv_info=None,
                source_snapshot=self.snapshot, started_at=app.time.perf_counter())
        self.assertIsNotNone(initialized)
        self.assertIs(server.model_graph.find_field('blog.Post', 'value'),
                      server.static_index.find_field('blog.Post', 'value'),
                      'Cached graph duplicated an identical frozen static field')
        self.assertEqual(store._model_graph_to_cache_dict(server.model_graph), store._model_graph_to_cache_dict(self.graph))

    def test_graph_maps_remain_independent_and_source_edit_cannot_mutate_shared_fields(self):
        first, second = self.load(), self.load()
        expected = store._model_graph_to_cache_dict(self.graph)
        self.assertEqual(store._model_graph_to_cache_dict(first), expected)
        self.assertEqual(store._model_graph_to_cache_dict(second), expected)
        shared = self.index.find_field('blog.Post', 'value')
        self.assertIs(first.find_field('blog.Post', 'value'), shared)
        self.assertIs(second.find_field('blog.Post', 'value'), shared)
        with self.assertRaises(dataclasses.FrozenInstanceError):
            shared.field_kind = 'DateField'
        first.fields_by_model_label['blog.Post'].pop('value')
        first.nodes_by_label.pop('blog.Target')
        first.edges_by_source_label.clear()
        self.assertEqual(store._model_graph_to_cache_dict(second), expected)
        self.source.write_text(self.source.read_text().replace('value=models.CharField', 'value=models.DateField'))
        changed, _, _ = reindex_single_file(self.root, self.source, self.index)
        self.assertEqual(changed.find_field('blog.Post', 'value').field_kind, 'DateField')
        self.assertEqual(second.find_field('blog.Post', 'value').field_kind, 'CharField')
        self.assertEqual(self.index.find_field('blog.Post', 'value').field_kind, 'CharField')

    def test_differing_or_future_field_metadata_falls_back_to_independent_restoration(self):
        original = store._model_graph_to_cache_dict(self.graph)
        for key, value in [('fieldKind', 'DateField'), ('source', 'runtime'),
                           ('constructorFingerprint', 'changed-constructor'), ('line', '4'),
                           ('modelLabel', ['non-string-label']), ('name', ['non-string-name']),
                           ('importedConstants', [['limits.VALUE', 'new']]),
                           ('unknownFuture', {'nested': [1, 2]})]:
            with self.subTest(key=key):
                raw = copy.deepcopy(original)
                raw['fieldsByModelLabel']['blog.Post']['value'][key] = value
                expected = store._model_graph_from_cache_dict(copy.deepcopy(raw))
                actual = store._model_graph_from_cache_dict(raw, static_index=self.index)
                self.assertEqual(store._model_graph_to_cache_dict(actual), store._model_graph_to_cache_dict(expected))
                self.assertIsNot(actual.fields_by_model_label['blog.Post']['value'], self.index.find_field('blog.Post', 'value'))
        # A remapped runtime label must retain its own complete graph identity.
        raw = copy.deepcopy(original)
        field = raw['fieldsByModelLabel']['blog.Post']['value']
        field['modelLabel'] = 'canonical.Post'
        actual = store._model_graph_from_cache_dict(raw, static_index=self.index)
        self.assertEqual(actual.fields_by_model_label['blog.Post']['value'].model_label, 'canonical.Post')
        # Frozen dataclasses can still be supplied with mutable nested values
        # by callers; those inputs must not be shared into a restored graph.
        field = self.index.find_field('blog.Post', 'value')
        nested = [list(pair) for pair in field.imported_constants]
        unsafe = dataclasses.replace(field, imported_constants=nested)
        with mock.patch.object(self.index, 'find_field', return_value=unsafe):
            actual = store._model_graph_from_cache_dict(copy.deepcopy(original), static_index=self.index)
        self.assertIsNot(actual.find_field('blog.Post', 'value'), unsafe)
        nested[0][1] = 'caller mutation'
        self.assertEqual(actual.find_field('blog.Post', 'value').imported_constants, field.imported_constants)
        for key, value in [('source', []), ('line', float(field.line)),
                           ('related_name', []), ('is_relation', 0),
                           ('constructor_fingerprint', ''), ('related_model_label', ''),
                           ('declaration_module', ''), ('related_query_name', '')]:
            with self.subTest(coercibleOwner=key):
                unsafe = dataclasses.replace(field, **{key: value})
                raw = store._field_candidate_to_cache_dict(unsafe)
                expected = store._field_candidate_from_cache_dict(raw)
                with mock.patch.object(self.index, 'find_field', return_value=unsafe):
                    actual = store._restore_graph_field(raw, self.index)
                self.assertIsNot(actual, unsafe)
                self.assertEqual(actual, expected)
                self.assertEqual(type(getattr(actual, key)), type(getattr(expected, key)))

    def test_metadata_rejection_and_malformed_field_cleanup_stay_current(self):
        self.assertIsNone(self.load(source='stale-source'))
        self.assertIsNone(self.load(runtime='stale-runtime'))
        path = self.cache / store.MODEL_GRAPH_CACHE_NAME
        payload = store._read_cache_payload(path)
        for metadata in [{'schemaVersion': -1}, {'workspaceRoot': '/different'}]:
            invalid = copy.deepcopy(payload)
            invalid['metadata'].update(metadata)
            store._write_cache_payload(path, invalid)
            self.assertIsNone(self.load())
        broken = copy.deepcopy(payload)
        broken['payload']['fieldsByModelLabel']['blog.Post']['value'].pop('line')
        store._write_cache_payload(path, broken)
        self.assertIsNone(self.load())
        self.assertFalse(path.exists())
        self.assertEqual(self.index.find_field('blog.Post', 'value').field_kind, 'CharField')

    def test_parallel_restores_share_only_their_supplied_immutable_owner(self):
        other = build_static_index(self.root, self.snapshot.files)
        with ThreadPoolExecutor(max_workers=2) as executor:
            first, second = list(executor.map(self.load, [self.index, other]))
        self.assertIs(first.find_field('blog.Post', 'value'), self.index.find_field('blog.Post', 'value'))
        self.assertIs(second.find_field('blog.Post', 'value'), other.find_field('blog.Post', 'value'))
        self.assertIsNot(first.find_field('blog.Post', 'value'), second.find_field('blog.Post', 'value'))
        self.assertIsNot(first.fields_by_model_label, second.fields_by_model_label)
        self.assertIsNot(first.nodes_by_label, second.nodes_by_label)


if __name__ == '__main__':
    unittest.main()
