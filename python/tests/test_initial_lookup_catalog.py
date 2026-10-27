import dataclasses
import copy
import importlib.util
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from django_orm_intellisense.features import lookup_paths
from django_orm_intellisense.runtime import inspector
from django_orm_intellisense.server import app
from django_orm_intellisense.static_index.indexer import FieldCandidate


class InitialLookupCatalogTests(unittest.TestCase):
    def setUp(self):
        self.field = FieldCandidate('sample.Item', 'value', '/source/models.py', 4, 5,
            'CharField', False, None, None, source='runtime')
        self.catalog = {'fields': {'sample.Item': {'value': '0'}}, 'types': {
            '0': {'fieldKind': 'CharField', 'lookups': ['exact'], 'transforms': {'size': '1'}},
            '1': {'fieldKind': 'IntegerField', 'lookups': ['exact', 'gte'], 'transforms': {}},
        }}
        self.runtime = dataclasses.replace(inspector.create_pending_runtime_inspection('sample.settings'),
            bootstrap_status='ready', lookup_catalog=self.catalog)
        self.graph = SimpleNamespace(find_field=lambda label, name: self.field
            if (label, name) == ('sample.Item', 'value') else None)
        self.static = object()

    def server(self, root):
        server = app.DaemonServer(root)
        server.static_index, server.runtime_inspection, server.model_graph = self.static, self.runtime, self.graph
        return server

    def resolve(self, path='value__size__gte', method='filter', **kwargs):
        return lookup_paths.resolve_lookup_path(model_graph=self.graph, runtime=self.runtime,
            base_model_label='sample.Item', path=path, method=method, **kwargs)

    def test_fresh_initialized_catalog_does_not_wait_for_held_parent_registry(self):
        lock = threading.Lock()
        lock.acquire()
        try:
            with tempfile.TemporaryDirectory() as folder, mock.patch.multiple(inspector,
                    _RUNTIME_FIELD_REGISTRY_LOCK=lock, _RUNTIME_FIELD_REGISTRY_READY=False,
                    _RUNTIME_FIELD_REGISTRY_SETTINGS_MODULE=None, _RUNTIME_FIELD_REGISTRY={},
                    _RUNTIME_LOOKUP_FIELD_ALIASES={}, _RUNTIME_FIELD_REGISTRY_LOCK_TIMEOUT_S=0.03):
                server = self.server(Path(folder))
                with mock.patch.object(inspector, '_ensure_runtime_field_registry',
                        side_effect=AssertionError('foreground tried to wait for registry')):
                    result = server._resolve_lookup_path({'baseModelLabel': 'sample.Item',
                        'value': 'value__size__gte', 'method': 'filter'})
                self.assertTrue(result['resolved'], result)
                self.assertEqual(result['terminalType']['outputFieldKind'], 'IntegerField')
        finally:
            lock.release()

    def test_captured_custom_output_negative_and_projection_rules_without_registry(self):
        with mock.patch.multiple(inspector, _RUNTIME_FIELD_REGISTRY_READY=False), \
                mock.patch.object(lookup_paths, '_runtime_lookup_field',
                    side_effect=AssertionError('registry consulted')):
            for method in ('filter', 'aget', 'aupdate_or_create'):
                with self.subTest(method=method):
                    result = self.resolve(method=method, use_initial_catalog=True)
                    self.assertTrue(result['resolved'], result)
                    self.assertEqual(result['terminalType']['outputFieldKind'], 'IntegerField')
            self.assertTrue(self.resolve('value__size', 'values', use_initial_catalog=True)['resolved'])
            for path, method in (('value__size__gte', 'values'),
                    ('value__not_registered', 'filter'), ('value__exact__size', 'filter')):
                with self.subTest(path=path, method=method):
                    self.assertFalse(self.resolve(path, method, use_initial_catalog=True)['resolved'])

    def test_local_callers_and_pending_or_edited_fields_keep_reflection(self):
        with mock.patch.object(inspector, '_RUNTIME_FIELD_REGISTRY_READY', False):
            for name, runtime, field, options in (
                    ('default', self.runtime, self.field, {}),
                    ('pending', dataclasses.replace(self.runtime, bootstrap_status='warming_up'),
                        self.field, {'use_initial_catalog': True}),
                    ('edited', self.runtime, dataclasses.replace(self.field, source='static_edit'),
                        {'use_initial_catalog': True})):
                with self.subTest(name=name), mock.patch.object(lookup_paths, '_runtime_lookup_field',
                        return_value=None) as reflection:
                    lookup_paths._resolve_lookup_chain(runtime=runtime, field=field,
                        segments=['size', 'gte'], **options)
                    reflection.assert_called_once()

    def test_unchanged_static_and_inherited_declarations_use_captured_runtime_capabilities(self):
        with mock.patch.object(inspector, '_RUNTIME_FIELD_REGISTRY_READY', False), \
                mock.patch.object(lookup_paths, '_runtime_lookup_field',
                    side_effect=AssertionError('unchanged declaration waited for registry')):
            for source in ('static', 'static_inheritance'):
                with self.subTest(source=source):
                    self.field = dataclasses.replace(self.field, source=source)
                    self.assertTrue(self.resolve(use_initial_catalog=True)['resolved'])

    @unittest.skipUnless(importlib.util.find_spec('django'), 'Django is not installed')
    def test_ready_registry_resumes_live_instance_registration(self):
        from django.db import models
        from django.db.models.lookups import Exact

        class RegisteredLater(Exact):
            lookup_name = 'registered_later'

        live = models.CharField(max_length=10)
        live.register_lookup(RegisteredLater)
        with mock.patch.multiple(inspector, _RUNTIME_FIELD_REGISTRY_READY=True,
                _RUNTIME_FIELD_REGISTRY_SETTINGS_MODULE='sample.settings',
                _RUNTIME_FIELD_REGISTRY={('sample.Item', 'value'): live},
                _RUNTIME_LOOKUP_FIELD_ALIASES={}):
            result = self.resolve('value__registered_later', use_initial_catalog=True)
            self.assertTrue(result['resolved'], result)
            self.assertEqual(result['lookupOperator'], 'registered_later')

    def test_registry_readiness_is_nonblocking_and_settings_specific(self):
        with mock.patch.multiple(inspector, _RUNTIME_FIELD_REGISTRY_READY=True,
                _RUNTIME_FIELD_REGISTRY_SETTINGS_MODULE='other.settings'), \
                mock.patch.object(inspector, '_ensure_runtime_field_registry',
                    side_effect=AssertionError('peek tried to build')):
            self.assertFalse(inspector.runtime_field_registry_is_ready('sample.settings'))
            self.assertTrue(inspector.runtime_field_registry_is_ready('other.settings'))
            with mock.patch.object(lookup_paths, '_runtime_lookup_field',
                    side_effect=AssertionError('unrelated registry used')):
                self.assertTrue(self.resolve(use_initial_catalog=True)['resolved'])

    def test_incomplete_or_runtime_only_descriptors_keep_reflection(self):
        variants = [None, {}, {'transforms': {'size': None}},
            {'transforms': {}, 'runtimeTransforms': True},
            {'lookups': [], 'transforms': {}, 'runtimeLookups': True}]
        for variant in variants:
            catalog = copy.deepcopy(self.catalog)
            if variant is None:
                catalog['fields'] = {}
            elif not variant:
                catalog['types'].pop('0')
            else:
                catalog['types']['0'].update(variant)
            runtime = dataclasses.replace(self.runtime, lookup_catalog=catalog)
            with self.subTest(variant=variant), \
                    mock.patch.object(inspector, '_RUNTIME_FIELD_REGISTRY_READY', False), \
                    mock.patch.object(lookup_paths, '_runtime_lookup_field', return_value=None) as reflection:
                lookup_paths._resolve_lookup_chain(runtime=runtime, field=self.field,
                    segments=['size', 'gte'], use_initial_catalog=True)
                reflection.assert_called_once()

    def test_source_dirty_or_replaced_state_cannot_enable_initial_catalog_from_rpc_params(self):
        with tempfile.TemporaryDirectory() as folder:
            server = self.server(Path(folder))
            initial = (self.static, self.runtime, self.graph)
            for changed in ('dirty', 'static_index', 'runtime_inspection', 'model_graph'):
                server.static_index, server.runtime_inspection, server.model_graph = initial
                server._source_snapshot_dirty = changed == 'dirty'
                if changed != 'dirty':
                    setattr(server, changed, object())
                with self.subTest(changed=changed), \
                        mock.patch.object(server, '_require_graph_feature_state', return_value=initial), \
                        mock.patch.object(app, 'resolve_lookup_path', return_value={'resolved': False}) as resolve:
                    server._resolve_lookup_path({'baseModelLabel': 'sample.Item', 'value': 'value__size',
                        'method': 'filter', 'use_initial_catalog': True, 'useInitialCatalog': True})
                    self.assertFalse(resolve.call_args.kwargs['use_initial_catalog'])


@unittest.skipUnless(importlib.util.find_spec('django'), 'Django is not installed')
class InitialLookupCatalogDjangoParityTests(unittest.TestCase):
    def test_refreshed_model_chunks_preserve_relation_and_attname_registrations(self):
        from tests.lookup_catalog_fixture import build_fixture
        from django_orm_intellisense.runtime.lookup_catalog import apply_model_catalog_delta, collect_model_lookup_catalog
        _models, _registry, runtime, graph, _surface = build_fixture()
        chunk = collect_model_lookup_catalog(graph, runtime, 'lookup_test.Item')
        refreshed = dataclasses.replace(runtime, lookup_catalog=apply_model_catalog_delta(
            runtime.lookup_catalog, {'lookup_test.Item': chunk}))
        for path in ('owner__length__gte', 'owner_id__length__gte', 'owner_id__icontains'):
            for method in ('filter', 'values'):
                options = dict(model_graph=graph, base_model_label='lookup_test.Item', path=path, method=method)
                with self.subTest(path=path, method=method):
                    expected = lookup_paths.resolve_lookup_path(runtime=runtime, **options)
                    with mock.patch.object(lookup_paths, '_runtime_lookup_field',
                            side_effect=AssertionError('older registry used for fresh model chunk')):
                        current = lookup_paths.resolve_lookup_path(runtime=refreshed, **options)
                    self.assertEqual(current, expected)

    def test_initial_catalog_matches_live_django_paths_and_terminal_types(self):
        from tests.lookup_catalog_fixture import build_fixture, build_payload
        models, _registry, runtime, graph, surface = build_fixture()
        payload = build_payload(models, runtime, surface)
        results = []
        for case in payload['oracleCases']:
            options = dict(model_graph=graph, runtime=runtime, base_model_label=case['model'],
                path=case['path'], method=case['method'])
            with self.subTest(case=case):
                live = lookup_paths.resolve_lookup_path(**options)
                self.assertEqual(live['resolved'], case['resolved'], live)
                with mock.patch.object(inspector, '_RUNTIME_FIELD_REGISTRY_READY', False), \
                        mock.patch.object(lookup_paths, '_runtime_lookup_field',
                            side_effect=AssertionError('captured path tried reflection')):
                    captured = lookup_paths.resolve_lookup_path(**options, use_initial_catalog=True)
                self.assertEqual(captured, live)
                results.append(captured)
        self.assertGreaterEqual(len(results), 50)
