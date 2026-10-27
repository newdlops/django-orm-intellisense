from __future__ import annotations

import dataclasses
import io
import json
import multiprocessing
import os
import pickle
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from concurrent.futures import ProcessPoolExecutor

from django_orm_intellisense.cache.store import load_cached_runtime_inspection, save_runtime_inspection
from django_orm_intellisense.features.orm_members import fingerprint_json_payload
from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection
from django_orm_intellisense.runtime.lookup_catalog import (
    apply_model_catalog_delta, lookup_catalog_json_default,
)
from django_orm_intellisense.server.app import DaemonServer


def _worker_catalog_probe(runtime):
    return json.loads(json.dumps(runtime.lookup_catalog, default=lookup_catalog_json_default))


def _wire(value):
    return json.loads(json.dumps(value, default=lookup_catalog_json_default))


class LookupCatalogDeltaTests(unittest.TestCase):
    def assert_type_equivalent(self, expected, actual, old_id, new_id, seen=None):
        seen = set() if seen is None else seen
        pair = (old_id, new_id)
        if pair in seen:
            return
        seen.add(pair)
        old, new = expected['types'][old_id], actual['types'][new_id]
        self.assertEqual({key: value for key, value in old.items() if key not in ('transforms', 'dynamicTransform')},
                         {key: value for key, value in new.items() if key not in ('transforms', 'dynamicTransform')})
        self.assertEqual(old['transforms'].keys(), new['transforms'].keys())
        for name, target in old['transforms'].items():
            if target is None:
                self.assertIsNone(new['transforms'][name])
            else:
                self.assert_type_equivalent(expected, actual, target, new['transforms'][name], seen)
        old_dynamic, new_dynamic = old.get('dynamicTransform'), new.get('dynamicTransform')
        if old_dynamic is None:
            self.assertIsNone(new_dynamic)
        else:
            self.assertIsNotNone(new_dynamic)
            self.assertEqual({key: value for key, value in old_dynamic.items() if key not in ('outputType', 'sliceType')},
                             {key: value for key, value in new_dynamic.items() if key not in ('outputType', 'sliceType')})
            for name in ('outputType', 'sliceType'):
                if old_dynamic.get(name) is None:
                    self.assertIsNone(new_dynamic.get(name))
                else:
                    self.assert_type_equivalent(expected, actual, old_dynamic[name], new_dynamic[name], seen)

    def assert_model_catalog_equivalent(self, expected, actual, label):
        for table in ('fields', 'expressionFields'):
            old, new = expected.get(table, {}).get(label, {}), actual.get(table, {}).get(label, {})
            self.assertEqual(old.keys(), new.keys(), (label, table))
            for name, type_id in old.items():
                with self.subTest(model=label, table=table, field=name):
                    self.assert_type_equivalent(expected, actual, type_id, new[name])
        self.assertEqual(expected.get('relationPaths', {}).get(label, {}),
                         actual.get('relationPaths', {}).get(label, {}))

    def test_model_edit_catalog_matches_cold_field_and_expression_descriptor_graphs(self):
        from tests.lookup_catalog_fixture import build_fixture
        from django_orm_intellisense.runtime.lookup_catalog import collect_model_lookup_catalog
        models, _, runtime, graph, _ = build_fixture()
        for model in models:
            label = model._meta.label
            chunk = collect_model_lookup_catalog(graph, runtime, label)
            self.assert_model_catalog_equivalent(runtime.lookup_catalog, chunk, label)

    def test_fresh_registry_catalog_keeps_current_types_when_parent_source_overlay_cannot_be_rebuilt(self):
        from tests.lookup_catalog_fixture import build_fixture
        from django_orm_intellisense.runtime.lookup_catalog import collect_model_lookup_catalog
        _, _, runtime, graph, _ = build_fixture()
        field = next(field for fields in graph.fields_by_model_label.values() for field in fields.values()
            if not field.is_relation and field.field_kind == 'CharField')
        with tempfile.TemporaryDirectory(prefix='djls-parent-source-overlay-') as folder:
            stale = dataclasses.replace(field, source='static_edit', file_path=str(Path(folder) / 'missing.py'))
            fields = {**graph.fields_by_model_label,
                field.model_label: {**graph.fields_by_model_label[field.model_label], field.name: stale}}
            overlay = dataclasses.replace(graph, fields_by_model_label=fields)
            parent = collect_model_lookup_catalog(overlay, runtime, field.model_label)
            self.assertNotIn(field.name, parent['fields'][field.model_label])
            fresh = collect_model_lookup_catalog(overlay, runtime, field.model_label, use_current_registry=True)
            self.assert_model_catalog_equivalent(runtime.lookup_catalog, fresh, field.model_label)
            self.assertIs(graph.fields_by_model_label[field.model_label][field.name], field)

    def test_relation_attnames_keep_big_auto_uuid_and_custom_lookup_metadata_after_model_edits(self):
        from django.db import models
        from django.db.models.lookups import Exact
        from tests.lookup_catalog_fixture import build_fixture
        from django_orm_intellisense.runtime import inspector
        from django_orm_intellisense.runtime.lookup_catalog import collect_lookup_catalog, collect_model_lookup_catalog
        from django_orm_intellisense.semantic.graph import build_model_graph
        from django_orm_intellisense.static_index.indexer import StaticIndex
        _, _, base_runtime, _, _ = build_fixture()

        class NumericOwner(models.Model):
            id = models.BigAutoField(primary_key=True)
            code = models.UUIDField(unique=True)
            class Meta:
                app_label = 'catalog_attname'

        class Referencing(models.Model):
            owner = models.ForeignKey(NumericOwner, on_delete=models.CASCADE)
            by_code = models.OneToOneField(NumericOwner, to_field='code', on_delete=models.CASCADE, related_name='+')
            class Meta:
                app_label = 'catalog_attname'

        class RelationOnly(Exact):
            lookup_name = 'relation_only'
        Referencing._meta.get_field('owner').register_lookup(RelationOnly)
        registry, summaries = {}, []
        for model in (NumericOwner, Referencing):
            fields, relations = [], []
            for field in model._meta.get_fields():
                inspector._register_runtime_field(registry, model_label=model._meta.label, field=field)
                target = inspector._related_model_label(field)
                fields.append(inspector.RuntimeFieldSummary(field.name, type(field).__name__, field.is_relation,
                    target, 'forward' if field.is_relation else None))
                if field.is_relation:
                    relations.append(inspector.RuntimeRelationSummary(field.name, target, 'forward', type(field).__name__))
            summaries.append(inspector.RuntimeModelSummary(model._meta.label, model.__module__,
                [field.name for field in fields], [relation.name for relation in relations], [], fields, relations, ['objects']))
        cold = collect_lookup_catalog(registry)
        runtime = dataclasses.replace(base_runtime, settings_module='catalog_attname_fixture',
            model_catalog=tuple(summaries), model_preview=summaries, lookup_catalog=cold)
        label = Referencing._meta.label
        with mock.patch.multiple(inspector, _RUNTIME_FIELD_REGISTRY={}, _RUNTIME_LOOKUP_FIELD_ALIASES={},
                _RUNTIME_FIELD_REGISTRY_SETTINGS_MODULE=None, _RUNTIME_FIELD_REGISTRY_READY=False):
            inspector._set_runtime_field_registry(runtime.settings_module, registry)
            graph = build_model_graph(StaticIndex(0, 0, 0, 0, 0, {}, []), runtime)
            current = cold
            for _ in range(2):
                chunk = collect_model_lookup_catalog(graph, runtime, label)
                self.assert_model_catalog_equivalent(cold, chunk, label)
                current = apply_model_catalog_delta(current, {label: chunk})
                self.assert_model_catalog_equivalent(cold, current, label)
                for name, kind in (('owner_id', 'BigAutoField'), ('by_code_id', 'UUIDField')):
                    descriptor = current['types'][current['fields'][label][name]]
                    self.assertEqual(descriptor['fieldKind'], kind)
                for name in ('owner', 'owner_id'):
                    descriptor = current['types'][current['fields'][label][name]]
                    self.assertIn('relation_only', descriptor['lookups'])

    def setUp(self):
        self.catalog = {
            'types': {'0': {'fieldKind': 'CharField', 'lookups': ['exact'], 'transforms': {}},
                      '1': {'fieldKind': 'IntegerField', 'lookups': ['exact'], 'transforms': {}}},
            'fields': {'sample.A': {'value': '0'}, 'sample.AA': {'value': '0'}},
            'expressionFields': {'sample.A': {'value': '1'}},
            'kinds': {'CharField': '0', 'IntegerField': '1'},
            'relationPaths': {'sample.AA': {'children': {'accessorName': 'children', 'queryName': 'child'}}},
        }
        self.chunk = {
            'types': {
                '0': {'fieldKind': 'DateField', 'lookups': ['exact'], 'transforms': {'year': '1'}},
                '1': {'fieldKind': 'IntegerField', 'lookups': ['exact'], 'transforms': {'cycle': '0'}},
                '2': {'fieldKind': 'ArrayField', 'lookups': ['exact'], 'transforms': {},
                      'dynamicTransform': {'kind': 'index', 'outputType': '0', 'sliceType': '2'}},
                '3': {'fieldKind': 'BinaryField', 'lookups': ['exact'], 'transforms': {}},
            },
            'fields': {'sample.A': {'value': '0', 'dates': '2'}},
            'expressionFields': {'sample.A': {'value': '1'}},
        }

    def changed(self):
        return apply_model_catalog_delta(self.catalog, {'sample.A': self.chunk})

    def test_collector_releases_parameterized_field_without_waiting_for_cyclic_gc(self):
        import gc
        import weakref
        from django.db import models
        from django_orm_intellisense.runtime.lookup_catalog import collect_lookup_catalog
        class SelfOutput(models.Transform):
            lookup_name = 'self_output'
            @property
            def output_field(self):
                return self.lhs.output_field
        field = models.CharField(max_length=30)
        field.register_lookup(SelfOutput)
        reference = weakref.ref(field)
        enabled = gc.isenabled()
        gc.disable()
        try:
            catalog = collect_lookup_catalog({('sample.Post', 'value'): field}, include_class_defaults=False)
            del field
            self.assertIsNone(reference(), 'Collector closure retained the field until cyclic GC')
            descriptor = catalog['types'][catalog['fields']['sample.Post']['value']]
            transformed = catalog['types'][descriptor['transforms']['self_output']]
            self.assertEqual(transformed['transforms']['self_output'], descriptor['transforms']['self_output'])
        finally:
            if enabled:
                gc.enable()

    def test_collector_exception_releases_parameterized_fields_and_keeps_gc_policy(self):
        import gc
        import weakref
        from django.db import models
        from django_orm_intellisense.runtime.lookup_catalog import collect_lookup_catalog
        class SelfOutput(models.Transform):
            lookup_name = 'self_output'
            @property
            def output_field(self):
                return self.lhs.output_field
        field = models.CharField(max_length=30)
        field.register_lookup(SelfOutput)
        reference = weakref.ref(field)
        class BrokenDefaults:
            def __getattr__(self, name):
                raise ValueError('default constructor failed')
        enabled = gc.isenabled()
        gc.disable()
        try:
            with mock.patch.dict(sys.modules, {'django.contrib.postgres.fields': BrokenDefaults()}):
                with self.assertRaisesRegex(ValueError, 'default constructor failed'):
                    collect_lookup_catalog({('sample.Post', 'value'): field})
            del field
            self.assertIsNone(reference(), 'Exceptional collection retained field ownership')
            self.assertFalse(gc.isenabled())
        finally:
            if enabled:
                gc.enable()

    def test_replace_and_delete_preserve_snapshots_cycles_and_unrelated_labels(self):
        original = json.loads(json.dumps(self.catalog))
        first = self.changed()
        self.assertEqual(self.catalog, original)
        prefix = 'model:sample.A:'
        self.assertEqual(first['types'][prefix + '0']['transforms']['year'], prefix + '1')
        self.assertEqual(first['types'][prefix + '1']['transforms']['cycle'], prefix + '0')
        dynamic = first['types'][prefix + '2']['dynamicTransform']
        self.assertEqual(dynamic['outputType'], prefix + '0')
        self.assertEqual(dynamic['sliceType'], prefix + '2')
        self.assertIsNone(first['types'].get(None))
        self.assertIsNone(first['types'].get('model:missing.Model:0'))
        replacement = {'types': {'0': self.catalog['types']['1']},
                       'fields': {'sample.A': {'value': '0'}}}
        second = apply_model_catalog_delta(first, {'sample.A': replacement})
        self.assertNotIn(prefix + '3', second['types'])
        self.assertEqual(first['types'][prefix + '0']['fieldKind'], 'DateField')
        self.assertEqual(second['types'][prefix + '0']['fieldKind'], 'IntegerField')
        for _ in range(100):
            second = apply_model_catalog_delta(second, {'sample.A': replacement})
        self.assertEqual(len(second['types']), 3)
        removed = apply_model_catalog_delta(second, {'sample.A': None})
        self.assertEqual(_wire(removed['types']), self.catalog['types'])
        self.assertNotIn('sample.A', removed['fields'])
        self.assertEqual(removed['fields']['sample.AA'], self.catalog['fields']['sample.AA'])
        self.assertEqual(removed['relationPaths']['sample.AA'], self.catalog['relationPaths']['sample.AA'])

    def test_lookup_name_rows_are_detached_from_caller_inputs(self):
        for source in ('chunk', 'base', 'blocked', 'base_transforms'):
            with self.subTest(source=source):
                catalog = json.loads(json.dumps(self.catalog))
                chunk = json.loads(json.dumps(self.chunk))
                chunk['types']['2']['dynamicTransform']['blockedNames'] = ['reserved']
                snapshot = apply_model_catalog_delta(catalog, {'sample.A': chunk})
                expected = json.dumps(snapshot, sort_keys=True, default=lookup_catalog_json_default)
                if source == 'chunk':
                    chunk['types']['0']['lookups'].append('later_chunk_lookup')
                elif source == 'base':
                    catalog['types']['1']['lookups'].append('later_base_lookup')
                elif source == 'blocked':
                    chunk['types']['2']['dynamicTransform']['blockedNames'].append('later_blocked_name')
                else:
                    catalog['types']['1']['transforms']['later_transform'] = '0'
                self.assertEqual(json.dumps(snapshot, sort_keys=True, default=lookup_catalog_json_default),
                                 expected, 'Caller list mutation changed an already published snapshot')

    def test_shared_rows_preserve_large_registries_and_live_instance_registration(self):
        from django.db import models
        from django.db.models.lookups import Exact
        from django_orm_intellisense.runtime.lookup_catalog import collect_lookup_catalog, _shared_lookup_names
        field = models.CharField()
        names = {f'custom_{number:03}' for number in range(300)}
        for name in names:
            field.register_lookup(type('CustomExact', (Exact,), {'lookup_name': name}))
        before_pool = _shared_lookup_names.cache_info().currsize
        first = collect_lookup_catalog({('sample.Post', 'value'): field}, include_class_defaults=False)
        descriptor = first['types'][first['fields']['sample.Post']['value']]
        self.assertTrue(names <= set(descriptor['lookups']))
        first_wire = _wire(first)
        field.register_lookup(type('LaterExact', (Exact,), {'lookup_name': 'later_instance_lookup'}))
        second = collect_lookup_catalog({('sample.Post', 'value'): field}, include_class_defaults=False)
        current = second['types'][second['fields']['sample.Post']['value']]
        self.assertIn('later_instance_lookup', current['lookups'])
        self.assertNotIn('later_instance_lookup', descriptor['lookups'])
        self.assertEqual(_wire(first), first_wire)
        self.assertEqual(_shared_lookup_names.cache_info().currsize, before_pool,
                         'Large name rows were retained in the sharing pool')

    def test_legacy_cached_rows_keep_wire_fingerprints_and_separate_lookup_capabilities(self):
        from django_orm_intellisense.runtime.lookup_catalog import compact_lookup_catalog
        catalog = json.loads(json.dumps(self.catalog))
        catalog['types']['1']['lookups'] = ['exact', 'gte']
        restored = compact_lookup_catalog(catalog)
        self.assertEqual(_wire(restored), catalog)
        self.assertEqual(fingerprint_json_payload(restored), fingerprint_json_payload(catalog))
        self.assertNotIn('gte', restored['types']['0']['lookups'])
        self.assertIn('gte', restored['types']['1']['lookups'])
        catalog['types']['1']['lookups'].append('caller_only')
        self.assertNotIn('caller_only', restored['types']['1']['lookups'])

    def test_repeated_edit_does_not_enumerate_the_complete_type_table(self):
        first = self.changed()
        with mock.patch.object(type(first['types']), '__iter__',
                               side_effect=AssertionError('Full type enumeration during edit')):
            second = apply_model_catalog_delta(first, {'sample.A': self.chunk})
            self.assertEqual(second['types']['model:sample.A:0']['fieldKind'], 'DateField')
            self.assertEqual(len(second['types']), len(first['types']))

    def test_wire_export_fingerprint_and_restored_catalogue_remain_compatible(self):
        changed = self.changed()
        plain = {**changed, 'types': dict(changed['types'])}
        serialized = json.dumps(changed, sort_keys=True, default=lookup_catalog_json_default)
        self.assertEqual(serialized, json.dumps(plain, sort_keys=True))
        self.assertEqual(fingerprint_json_payload(changed), fingerprint_json_payload(plain))
        restored = json.loads(serialized)
        removed = apply_model_catalog_delta(restored, {'sample.A': None})
        self.assertEqual(_wire(removed['types']), self.catalog['types'])

    def test_worker_pickle_preserves_chunks_and_snapshot_isolation(self):
        changed = self.changed()
        restored = pickle.loads(pickle.dumps(changed))
        self.assertEqual(dict(restored['types']), dict(changed['types']))
        removed = apply_model_catalog_delta(restored, {'sample.A': None})
        self.assertEqual(len(removed['types']), 2)
        self.assertEqual(len(restored['types']), 6)

    def test_spawned_worker_receives_and_serializes_runtime_chunks(self):
        runtime = dataclasses.replace(create_pending_runtime_inspection(None), lookup_catalog=self.changed())
        with ProcessPoolExecutor(max_workers=1, mp_context=multiprocessing.get_context('spawn')) as pool:
            result = pool.submit(_worker_catalog_probe, runtime).result(timeout=15)
        self.assertEqual(result['types'], _wire(runtime.lookup_catalog['types']))

    def test_runtime_cache_roundtrip_writes_the_full_wire_catalogue(self):
        with tempfile.TemporaryDirectory(prefix='djls-catalog-cache-') as temporary:
            root = Path(temporary)
            runtime = dataclasses.replace(create_pending_runtime_inspection(None),
                bootstrap_status='ready', lookup_catalog=self.changed())
            with mock.patch.dict(os.environ, {'DJANGO_ORM_INTELLISENSE_CACHE_DIR': str(root / 'cache')}):
                save_runtime_inspection(root, 'source', None, runtime)
                restored = load_cached_runtime_inspection(root, 'source', None)
            self.assertIsNotNone(restored)
            self.assertEqual(restored.lookup_catalog['types'], dict(runtime.lookup_catalog['types']))

    def test_daemon_full_message_serializes_descriptors_and_rejects_unknown_objects(self):
        with tempfile.TemporaryDirectory(prefix='djls-catalog-message-') as temporary:
            stdout = sys.stdout
            try:
                server = DaemonServer(Path(temporary))
            finally:
                sys.stdout = stdout
            server._real_stdout = io.StringIO()
            changed = self.changed()
            server._write_message({'id': 1, 'result': {'lookupCatalog': changed}})
            message = json.loads(server._real_stdout.getvalue())
            self.assertEqual(message['result']['lookupCatalog']['types'], _wire(changed['types']))
        with self.assertRaises(TypeError):
            json.dumps(object(), default=lookup_catalog_json_default)


if __name__ == '__main__':
    unittest.main()
