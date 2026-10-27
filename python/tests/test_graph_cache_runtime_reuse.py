import copy
import dataclasses
import json
import sys
import tempfile
import unittest
import weakref
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from django_orm_intellisense.cache import store
from django_orm_intellisense.discovery.workspace import snapshot_python_sources
from django_orm_intellisense.runtime.inspector import (RuntimeInspection, RuntimeModelSummary,
    RuntimeFieldSummary, RuntimeRelationSummary, create_pending_runtime_inspection)
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.server import app
from django_orm_intellisense.static_index.indexer import build_static_index


class GraphCacheRuntimeReuseTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='djls-runtime-value-test-')
        self.addCleanup(temporary.cleanup)
        parent = Path(temporary.name).resolve()
        self.root, self.cache = parent / 'project', parent / 'cache'
        package = self.root / 'blog'; package.mkdir(parents=True)
        (package / '__init__.py').write_text('')
        (package / 'models.py').write_text('from django.db import models\n'
            'class Post(models.Model):\n    title=models.CharField(max_length=19)\n'
            'class Tag(models.Model):\n    post=models.ForeignKey(Post,on_delete=models.CASCADE)\n')
        self.snapshot = snapshot_python_sources(self.root)
        self.index = build_static_index(self.root, self.snapshot.files)
        post = RuntimeModelSummary('blog.Post', 'blog.models', ['id', 'title'], [], ['tag_set'],
            [RuntimeFieldSummary('id', 'BigAutoField', False, None, None), RuntimeFieldSummary('title', 'CharField', False, None, None)],
            [RuntimeRelationSummary('tag_set', 'blog.Tag', 'reverse', 'ManyToOneRel')], ['objects'])
        tag = RuntimeModelSummary('blog.Tag', 'blog.models', ['id', 'post'], ['post'], [],
            [RuntimeFieldSummary('id', 'BigAutoField', False, None, None), RuntimeFieldSummary('post', 'ForeignKey', True, 'blog.Post', 'forward')],
            [RuntimeRelationSummary('post', 'blog.Post', 'forward', 'ForeignKey')], ['objects'])
        self.runtime = dataclasses.replace(create_pending_runtime_inspection(None), django_importable=True,
            bootstrap_status='ready', model_count=2, model_catalog=(post, tag), model_preview=[post, tag])
        self.graph = build_model_graph(self.index, self.runtime)
        self.expected = store._model_graph_to_cache_dict(self.graph)
        for patcher in [mock.patch.object(store, '_workspace_cache_dir', return_value=self.cache),
                mock.patch.object(store, '_GRAPH_FIELDS_STREAM_MIN_BYTES', 0)]:
            patcher.start(); self.addCleanup(patcher.stop)
        store.save_static_index(self.root, self.snapshot, self.index)
        runtime_source = app._runtime_source_fingerprint(
            source_snapshot=self.snapshot, static_index=self.index, settings_module=None)
        self.fingerprint = app._runtime_cache_fingerprint(self.runtime, source_fingerprint=runtime_source)
        store.save_model_graph(self.root, self.snapshot.fingerprint, self.fingerprint, self.graph)
        self.path = self.cache / store.MODEL_GRAPH_CACHE_NAME
        self.wire = json.loads(self.path.read_text())

    def load(self, owner=None):
        return store.load_cached_model_graph(self.root, self.snapshot.fingerprint, self.fingerprint,
            static_index=self.index, runtime_inspection=self.runtime if owner is None else owner)

    def test_default_factory_and_loader_keep_independent_records(self):
        owner = self.runtime.model_catalog[0]
        default = RuntimeModelSummary.from_dict(owner.to_dict())
        without_owner = store.load_cached_model_graph(self.root, self.snapshot.fingerprint, self.fingerprint, static_index=self.index)
        self.assertEqual(default.to_dict(), owner.to_dict())
        self.assertIsNot(default.fields[0], owner.fields[0])
        self.assertIsNot(without_owner.nodes_by_label['blog.Post'].runtime_model.fields[0], owner.fields[0])
        self.assertEqual(store._model_graph_to_cache_dict(without_owner), self.expected)

    def test_cached_graph_shares_only_complete_primitive_value_records(self):
        graph = self.load()
        self.assertEqual(store._model_graph_to_cache_dict(graph), self.expected)
        for owner in self.runtime.model_catalog:
            model = graph.nodes_by_label[owner.label].runtime_model
            self.assertIsNot(model, owner)
            for name in ['field_names', 'relation_names', 'reverse_relation_names', 'manager_names', 'fields', 'relations']:
                self.assertIsNot(getattr(model, name), getattr(owner, name))
            for left, right in zip(model.fields + model.relations, owner.fields + owner.relations):
                self.assertIs(left, right)
                with self.assertRaises(dataclasses.FrozenInstanceError): left.name = 'changed'
        self.assertIs(graph.find_field('blog.Post', 'title'), self.index.find_field('blog.Post', 'title'))

    def test_model_and_owner_list_mutations_remain_read_local(self):
        first, second = self.load(), self.load()
        first.nodes_by_label['blog.Post'].runtime_model.fields.clear()
        first.nodes_by_label['blog.Post'].runtime_model.manager_names.append('local')
        first.nodes_by_label.pop('blog.Tag')
        self.assertEqual(store._model_graph_to_cache_dict(second), self.expected)
        owner = self.runtime.model_catalog[0]
        owner.fields.clear(); owner.relations.clear(); owner.field_names.clear()
        self.assertEqual(store._model_graph_to_cache_dict(second), self.expected)

    def test_future_differing_partial_and_coercible_raw_records_use_normal_conversion(self):
        owner = self.runtime.model_catalog[1]
        for sequence, cases in [('fields', [('fieldKind', 'DateField'), ('isRelation', 1), ('relatedModelLabel', ''),
                ('direction', ''), ('name', 10), ('future', {'nested': [1]})]),
                ('relations', [('fieldKind', 'ManyToManyField'), ('direction', 10), ('relatedModelLabel', ''), ('future', True)])]:
            for key, value in cases:
                with self.subTest(sequence=sequence, key=key):
                    raw = owner.to_dict(); raw[sequence][0][key] = value
                    expected = RuntimeModelSummary.from_dict(copy.deepcopy(raw))
                    restored = RuntimeModelSummary.from_dict(raw, _reuse_from=owner)
                    self.assertEqual(restored.to_dict(), expected.to_dict())
                    self.assertIsNot(getattr(restored, sequence)[0], getattr(owner, sequence)[0])
        raw = owner.to_dict(); raw['fields'][0].pop('direction')
        restored = RuntimeModelSummary.from_dict(raw, _reuse_from=owner)
        self.assertEqual(restored.to_dict(), RuntimeModelSummary.from_dict(raw).to_dict())
        self.assertIsNot(restored.fields[0], owner.fields[0])

    def test_owner_bearing_subclasses_and_mutable_values_never_cross_owners(self):
        class Owner: pass
        class Text(str): pass
        owner = self.runtime.model_catalog[1]
        for sequence, key, value in [('fields', 'name', ['mutable']), ('fields', 'is_relation', 1),
                ('fields', 'related_model_label', ''), ('fields', 'direction', ''),
                ('relations', 'related_model_label', ''), ('relations', 'direction', ['mutable'])]:
            with self.subTest(sequence=sequence, key=key):
                unsafe = dataclasses.replace(getattr(owner, sequence)[0], **{key: value})
                copied = dataclasses.replace(owner, **{sequence: [unsafe, *getattr(owner, sequence)[1:]]})
                raw = copied.to_dict()
                restored = RuntimeModelSummary.from_dict(raw, _reuse_from=copied)
                self.assertEqual(restored.to_dict(), RuntimeModelSummary.from_dict(raw).to_dict())
                self.assertIsNot(getattr(restored, sequence)[0], unsafe)
        held = Owner(); reference = weakref.ref(held); text = Text('id'); text.owner = held
        unsafe = dataclasses.replace(owner.fields[0], name=text)
        copied = dataclasses.replace(owner, fields=[unsafe])
        raw = copied.to_dict(); restored = RuntimeModelSummary.from_dict(raw, _reuse_from=copied)
        self.assertIs(type(restored.fields[0].name), str)
        del copied, raw, unsafe, text, held
        self.assertIsNone(reference())

    def test_skips_and_errors_retain_original_factory_semantics(self):
        owner = self.runtime.model_catalog[0]
        raw = owner.to_dict(); raw['fields'].insert(0, None); raw['relations'].append('ignored')
        self.assertEqual(RuntimeModelSummary.from_dict(raw, _reuse_from=owner).to_dict(), RuntimeModelSummary.from_dict(raw).to_dict())
        for mutate in [lambda value: value['fields'][0].pop('name'), lambda value: value.update(fields=None),
                lambda value: value.update(managerNames=None), lambda value: value['relations'][0].pop('direction')]:
            raw = owner.to_dict(); mutate(raw)
            with self.assertRaises((KeyError, TypeError, ValueError)) as expected:
                RuntimeModelSummary.from_dict(copy.deepcopy(raw))
            with self.assertRaises(type(expected.exception)) as actual:
                RuntimeModelSummary.from_dict(raw, _reuse_from=owner)
            self.assertEqual(actual.exception.args, expected.exception.args)

    def test_stale_cache_rejects_before_runtime_value_hydration(self):
        with mock.patch.object(RuntimeModelSummary, 'from_dict', side_effect=AssertionError('Stale runtime hydrated')):
            self.assertIsNone(store.load_cached_model_graph(self.root, 'stale-source', self.fingerprint,
                static_index=self.index, runtime_inspection=self.runtime))
            self.assertIsNone(store.load_cached_model_graph(self.root, self.snapshot.fingerprint, 'stale-runtime',
                static_index=self.index, runtime_inspection=self.runtime))
        self.assertTrue(self.path.exists())

    def test_malformed_runtime_value_cleanup_and_owner_release(self):
        other = RuntimeInspection.from_cache_dict(self.runtime.to_cache_dict()); reference = weakref.ref(other)
        broken = copy.deepcopy(self.wire); broken['payload']['nodesByLabel']['blog.Post']['runtimeModel']['fields'][0].pop('name')
        self.path.write_text(json.dumps(broken))
        self.assertIsNone(self.load(other)); self.assertFalse(self.path.exists())
        del other; self.assertIsNone(reference())
        self.assertEqual(self.runtime.model_catalog[0].fields[0].name, 'id')

    def test_duplicate_json_runtime_nodes_keep_last_value_precedence(self):
        model = self.wire['payload']['nodesByLabel']['blog.Post']['runtimeModel']
        raw = json.dumps(self.wire).replace('"runtimeModel": ' + json.dumps(model),
            '"runtimeModel":{"fields":[{}]},"runtimeModel": ' + json.dumps(model))
        self.assertNotEqual(raw, json.dumps(self.wire)); self.path.write_text(raw)
        self.assertEqual(store._model_graph_to_cache_dict(self.load()), self.expected)

    def test_runtime_owner_and_summaries_release_without_gc_with_graph_alive(self):
        other = RuntimeInspection.from_cache_dict(self.runtime.to_cache_dict())
        references = [weakref.ref(other), *[weakref.ref(model) for model in other.model_catalog]]
        graph = self.load(other); del other
        self.assertTrue(all(reference() is None for reference in references))
        self.assertEqual(store._model_graph_to_cache_dict(graph), self.expected)

    def test_parallel_readers_share_only_their_supplied_values(self):
        other = RuntimeInspection.from_cache_dict(self.runtime.to_cache_dict())
        with ThreadPoolExecutor(max_workers=2) as pool:
            first, second = list(pool.map(self.load, [self.runtime, other]))
        first_model = first.nodes_by_label['blog.Post'].runtime_model
        second_model = second.nodes_by_label['blog.Post'].runtime_model
        self.assertIs(first_model.fields[0], self.runtime.model_catalog[0].fields[0])
        self.assertIs(second_model.fields[0], other.model_catalog[0].fields[0])
        self.assertIsNot(first_model.fields[0], second_model.fields[0])
        first_model.fields.clear()
        self.assertEqual(store._model_graph_to_cache_dict(second), self.expected)

    def test_initialize_passes_the_current_runtime_owner_to_cached_graph(self):
        stdout = sys.stdout
        try: server = app.DaemonServer(self.root)
        finally: sys.stdout = stdout
        server._state_generation = 7
        with mock.patch.object(app, 'load_cached_runtime_inspection', return_value=self.runtime), \
                mock.patch.object(app, 'build_model_graph', side_effect=AssertionError('Cached graph rebuilt')), \
                mock.patch.object(server, '_schedule_surface_index_idle_load'), \
                mock.patch.object(server, '_start_runtime_field_registry_prewarm'):
            result = server._initialize_from_source_snapshot(generation=7, initialized_at=server.initialized_at,
                workspace_root=self.root, settings_module=None, defer_runtime=False, venv_info=None,
                source_snapshot=self.snapshot, started_at=app.time.perf_counter())
        self.assertIsNotNone(result)
        self.assertEqual(store._model_graph_to_cache_dict(server.model_graph), self.expected)
        self.assertIs(server.model_graph.nodes_by_label['blog.Post'].runtime_model.fields[0], self.runtime.model_catalog[0].fields[0])


if __name__ == '__main__': unittest.main()
