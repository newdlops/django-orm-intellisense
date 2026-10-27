import dataclasses
import unittest
from types import SimpleNamespace
from unittest import mock

from django_orm_intellisense.features import lookup_paths
from django_orm_intellisense.runtime.inspector import create_pending_runtime_inspection


class LookupCatalogSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.field = SimpleNamespace(model_label='custom.Added', name='value', field_kind='CharField')
        self.catalogue = {'fields': {'custom.Added': {'value': 'model:custom.Added:input'}}, 'types': {
            'model:custom.Added:input': {'fieldKind': 'CharField', 'lookups': ['exact'],
                'transforms': {'size': 'integer', 'unknown_output': None}},
            'integer': {'fieldKind': 'IntegerField', 'lookups': ['exact', 'gte'], 'transforms': {}},
            'json': {'fieldKind': 'JSONField', 'lookups': ['exact', 'has_key'], 'transforms': {},
                'dynamicTransform': {'kind': 'key', 'outputType': 'json', 'blockedNames': ['blocked']}},
            'array': {'fieldKind': 'ArrayField', 'lookups': ['exact'], 'transforms': {},
                'dynamicTransform': {'kind': 'index', 'outputType': 'integer', 'sliceType': 'array'}},
        }}
        self.runtime = dataclasses.replace(create_pending_runtime_inspection(None), bootstrap_status='ready', lookup_catalog=self.catalogue)

    def resolve(self, segments, method='filter'):
        with mock.patch.object(lookup_paths, '_runtime_lookup_field', side_effect=AssertionError('older registry accessed')):
            return lookup_paths._resolve_lookup_chain(runtime=self.runtime, field=self.field, segments=segments, method=method)

    def test_fresh_custom_transform_output_and_method_rules_override_older_parent_registry(self):
        self.assertEqual(self.resolve(['size', 'gte']), {'resolved': True, 'lookupOperator': 'gte',
            'outputFieldKind': 'IntegerField', 'isTransformed': True})
        self.assertEqual(self.resolve(['size'], 'values')['outputFieldKind'], 'IntegerField')
        for segments, method in ((['size', 'gte'], 'values'),
                (['gte'], 'filter'), (['exact', 'gte'], 'filter')):
            self.assertFalse(self.resolve(segments, method)['resolved'])

    def test_expression_descriptor_preserves_dynamic_keys_indices_slices_and_cycles(self):
        self.catalogue['expressionFields'] = {'custom.Added': {'value': 'model:custom.Added:expression'}}
        for key, paths, blocked in (('json', [['a', 'b', 'has_key']], ['blocked']),
                ('array', [['-1', 'gte'], ['0_2', '1', 'gte'], ['0_2', 'exact']], ['invalid'])):
            self.catalogue['types']['model:custom.Added:expression'] = self.catalogue['types'][key]
            for segments in paths:
                self.assertTrue(self.resolve(segments)['resolved'])
            self.assertFalse(self.resolve(blocked)['resolved'])

    def test_missing_or_runtime_only_catalogue_entries_retain_reflection_fallback(self):
        descriptor = self.catalogue['types']['model:custom.Added:input']
        self.assertIsNone(lookup_paths._resolve_lookup_chain_catalog(self.runtime, self.field, ['unknown_output'], 'filter'))
        descriptor['runtimeTransforms'] = True
        with mock.patch.object(lookup_paths, '_runtime_lookup_field', return_value=None) as registry:
            self.assertFalse(lookup_paths._resolve_lookup_chain(runtime=self.runtime, field=self.field,
                segments=['dynamic_unknown'])['resolved'])
        registry.assert_called_once()
        self.catalogue['fields']['custom.Added']['value'] = 'original-cold-type'
        self.assertIsNone(lookup_paths._resolve_lookup_chain_catalog(self.runtime, self.field, ['exact'], 'filter'))
