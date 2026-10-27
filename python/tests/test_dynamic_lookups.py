from __future__ import annotations

import importlib.util
import unittest
from unittest import mock

from django_orm_intellisense.features.lookup_paths import list_lookup_path_completions, resolve_lookup_path
from django_orm_intellisense.runtime.inspector import RuntimeInspection
from tests.lookup_catalog_fixture import build_fixture


@unittest.skipUnless(importlib.util.find_spec('django'), 'Django is not installed')
class DynamicLookupTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.models, cls.registry, cls.runtime, cls.graph, _ = build_fixture()

    def resolve(self, path, method='filter', label='lookup_test.Item'):
        return resolve_lookup_path(model_graph=self.graph, runtime=self.runtime,
                                   base_model_label=label, path=path, method=method)

    def names(self, prefix, method='filter', label='lookup_test.Item'):
        result = list_lookup_path_completions(model_graph=self.graph, runtime=self.runtime,
                                             base_model_label=label, prefix=prefix, method=method)
        self.assertTrue(result['resolved'], result)
        return {item['name']: item for item in result['items']}

    def test_registered_names_match_django_for_every_fixture_field(self):
        from django.db.models import Lookup, Transform
        for (label, name), field in self.registry.items():
            from django_orm_intellisense.runtime.inspector import get_runtime_field
            field = get_runtime_field('lookup_fixture', model_label=label, field_name=name, for_lookup=True)
            if not hasattr(field, 'get_lookups'):
                continue
            type_id = self.runtime.lookup_catalog['fields'][label][name]
            descriptor = self.runtime.lookup_catalog['types'][type_id]
            expected = {**getattr(getattr(field, 'output_field', None), 'get_lookups', lambda: {})(),
                        **field.get_lookups()}
            with self.subTest(label=label, name=name):
                self.assertEqual(set(descriptor['lookups']), {
                    n for n in expected if field.get_lookup(n) is not None
                    and (type(field).__name__ != 'CompositePrimaryKey'
                         or getattr(field.get_lookup(n), 'allows_composite_expressions', False))
                })
                self.assertEqual(set(descriptor['transforms']), {
                    n for n, lookup in expected.items() if issubclass(lookup, Transform)
                })

    def test_instance_registration_is_not_promoted_to_sibling_fields(self):
        self.assertIn('only_here', self.names('title__'))
        self.assertNotIn('only_here', self.names('other__'))
        self.assertTrue(self.resolve('title__only_here')['resolved'])
        self.assertFalse(self.resolve('other__only_here')['resolved'])

    def test_output_field_and_chained_transforms(self):
        for path, kind in [('title__length', 'IntegerField'),
                           ('published__date__iso_year', 'IntegerField'),
                           ('generated__date__year', 'IntegerField'),
                           ('title__lower__length__gte', 'IntegerField')]:
            with self.subTest(path=path):
                result = self.resolve(path)
                self.assertTrue(result['resolved'], result)
                self.assertEqual(result['terminalType']['outputFieldKind'], kind)
        self.assertIn('gte', self.names('title__length__'))
        self.assertNotIn('year', self.names('title__length__'))

    def test_json_dynamic_keys_and_negative_indices(self):
        for path in ['payload__nested__0__name__icontains', 'payload__items__-1__isnull',
                     'payload__contains__name__iexact', 'payload__nested__has_any_keys']:
            with self.subTest(path=path):
                self.assertTrue(self.resolve(path)['resolved'])
        self.assertIn('icontains', self.names('payload__nested__0__'))

    def test_field_projection_and_async_lookup_methods(self):
        for method in ['values', 'values_list', 'order_by', 'distinct']:
            with self.subTest(method=method):
                self.assertTrue(self.resolve('published__year', method)['resolved'])
                self.assertFalse(self.resolve('published__year__gte', method)['resolved'])
                self.assertIn('year', self.names('published__', method))
                self.assertNotIn('gte', self.names('published__', method))
        for method in ['aget', 'aget_or_create', 'aupdate_or_create']:
            self.assertTrue(self.resolve('title__length__gte', method)['resolved'])

    def test_custom_primary_key_and_fk_target_type(self):
        self.assertIsNone(self.graph.find_field('lookup_test.Owner', 'id'))
        self.assertIn('in', self.names('owner_id__'))
        self.assertNotIn('icontains', self.names('owner_id__'))
        self.assertTrue(self.resolve('owner__in')['resolved'])

    def test_postgres_dynamic_transforms(self):
        if 'lookup_test.Collection' not in self.runtime.lookup_catalog['fields']:
            self.skipTest('psycopg is not installed')
        for path in ['tags__0__icontains', 'tags__0_2__contains', 'tags__len__gte',
                     'attributes__key__icontains', 'span__startswith__gte']:
            with self.subTest(path=path):
                result = self.resolve(path, label='lookup_test.Collection')
                self.assertTrue(result['resolved'], result)
        self.assertIn('icontains', self.names('tags__0__', label='lookup_test.Collection'))

    def test_catalog_roundtrip_preserves_registry_metadata(self):
        restored = RuntimeInspection.from_cache_dict(self.runtime.to_cache_dict())
        self.assertEqual(restored.lookup_catalog, self.runtime.lookup_catalog)

    def test_registry_entry_selection_matches_full_method_resolution(self):
        from django_orm_intellisense.runtime.lookup_catalog import collect_lookup_catalog
        selected = collect_lookup_catalog(self.registry)
        with mock.patch('django_orm_intellisense.runtime.lookup_catalog._uses_default_registry_method',
                        return_value=False):
            expected = collect_lookup_catalog(self.registry)
        self.assertEqual(selected, expected)

    def test_default_registry_entries_avoid_repeated_lookup_resolution(self):
        from django.db import models
        from django.db.models.lookups import Exact
        from django.db.models.query_utils import RegisterLookupMixin
        from django_orm_intellisense.runtime.lookup_catalog import collect_lookup_catalog

        class InstanceLookup(Exact):
            lookup_name = 'selection_here'

        field = models.CharField(max_length=30)
        field.register_lookup(InstanceLookup)
        # Wrap with the same method identity used by the selector, so calls
        # measure actual fallback dispatch rather than disable the fast path.
        original = RegisterLookupMixin.get_lookup
        calls = []
        def counting_lookup(owner, name):
            calls.append(name)
            return original(owner, name)
        with mock.patch.object(RegisterLookupMixin, 'get_lookup', counting_lookup):
            catalog = collect_lookup_catalog({('sample.Item', 'title'): field},
                                             include_class_defaults=False)
        descriptor = catalog['types'][catalog['fields']['sample.Item']['title']]
        self.assertIn('selection_here', descriptor['lookups'])
        self.assertEqual(calls, [])

    def test_lookup_and_transform_overrides_preserve_custom_dispatch(self):
        from django.db import models
        from django.db.models.lookups import Exact
        from django_orm_intellisense.runtime.lookup_catalog import collect_lookup_catalog

        class Marker(Exact):
            lookup_name = 'selection_marker'

        class Shift(models.Transform):
            lookup_name = 'selection_shift'
            output_field = models.IntegerField()

        class CustomField(models.CharField):
            def get_lookup(self, name):
                return None if name == 'selection_marker' else super().get_lookup(name)

            def get_transform(self, name):
                return None if name == 'selection_shift' else super().get_transform(name)

        class RegistryOverride(models.CharField):
            def _get_lookup(self, name):
                return None if name == 'selection_marker' else super()._get_lookup(name)

        fields = [CustomField(max_length=30), RegistryOverride(max_length=30),
                  models.CharField(max_length=30)]
        for field in fields:
            field.register_lookup(Marker)
            field.register_lookup(Shift)
        registry = {('sample.Item', f'value_{number}'): field
                    for number, field in enumerate(fields)}
        selected = collect_lookup_catalog(registry, include_class_defaults=False)
        with mock.patch('django_orm_intellisense.runtime.lookup_catalog._uses_default_registry_method',
                        return_value=False):
            expected = collect_lookup_catalog(registry, include_class_defaults=False)
        self.assertEqual(selected, expected)
        descriptors = [selected['types'][selected['fields']['sample.Item'][f'value_{number}']]
                       for number in range(len(fields))]
        self.assertNotIn('selection_marker', descriptors[0]['lookups'])
        self.assertNotIn('selection_shift', descriptors[0]['transforms'])
        self.assertNotIn('selection_marker', descriptors[1]['lookups'])
        self.assertIn('selection_marker', descriptors[2]['lookups'])

    def test_transform_none_entry_falls_back_and_other_entries_shadow_output(self):
        from django.db import models
        from django.db.models.lookups import Exact
        from django_orm_intellisense.runtime.lookup_catalog import collect_lookup_catalog

        class FromOutput(Exact):
            lookup_name = 'selection_fallback'

        class Shadowed(Exact):
            lookup_name = 'selection_shadowed'

        class ShadowTransform(models.Transform):
            lookup_name = 'selection_shadowed'
            output_field = models.IntegerField()

        output = models.CharField(max_length=30)
        output.register_lookup(FromOutput)
        output.register_lookup(Shadowed)

        class Projection(models.Transform):
            lookup_name = 'selection_projection'
            output_field = output
            class_lookups = {'selection_fallback': None,
                             'selection_shadowed': ShadowTransform}

        source = models.CharField(max_length=30)
        source.register_lookup(Projection)
        registry = {('sample.Item', 'title'): source}
        selected = collect_lookup_catalog(registry, include_class_defaults=False)
        with mock.patch('django_orm_intellisense.runtime.lookup_catalog._uses_default_registry_method',
                        return_value=False):
            expected = collect_lookup_catalog(registry, include_class_defaults=False)
        self.assertEqual(selected, expected)
        source_descriptor = selected['types'][selected['fields']['sample.Item']['title']]
        projected = selected['types'][source_descriptor['transforms']['selection_projection']]
        self.assertIn('selection_fallback', projected['lookups'])
        self.assertNotIn('selection_shadowed', projected['lookups'])
        self.assertIn('selection_shadowed', projected['transforms'])

    def test_computed_output_fields_retain_per_lookup_property_dispatch(self):
        from django.db import models
        from django_orm_intellisense.runtime.lookup_catalog import collect_lookup_catalog
        reads = []

        class Computed(models.Transform):
            lookup_name = 'selection_computed'

            @property
            def output_field(self):
                reads.append('output')
                return models.IntegerField()

        source = models.CharField(max_length=30)
        source.register_lookup(Computed)
        registry = {('sample.Item', 'title'): source}
        selected = collect_lookup_catalog(registry, include_class_defaults=False)
        selected_reads = len(reads)
        reads.clear()
        with mock.patch('django_orm_intellisense.runtime.lookup_catalog._uses_default_registry_method',
                        return_value=False):
            expected = collect_lookup_catalog(registry, include_class_defaults=False)
        self.assertEqual(selected, expected)
        self.assertEqual(selected_reads, len(reads))
        self.assertGreater(selected_reads, 2)

    def test_registry_overrides_retain_per_name_dispatch(self):
        from django.db import models
        from django_orm_intellisense.runtime.lookup_catalog import collect_lookup_catalog
        reads = []

        class CustomRegistry(models.CharField):
            def get_lookups(self):
                reads.append('instance')
                return super().get_lookups()

        class CustomClassRegistry(models.CharField):
            @classmethod
            def get_class_lookups(cls):
                reads.append('class')
                return super().get_class_lookups()

        registry = {('sample.Item', 'instance'): CustomRegistry(max_length=30),
                    ('sample.Item', 'class'): CustomClassRegistry(max_length=30)}
        selected = collect_lookup_catalog(registry, include_class_defaults=False)
        selected_reads = list(reads)
        reads.clear()
        with mock.patch('django_orm_intellisense.runtime.lookup_catalog._uses_default_registry_method',
                        return_value=False):
            expected = collect_lookup_catalog(registry, include_class_defaults=False)
        self.assertEqual(selected, expected)
        self.assertEqual(selected_reads, reads)
        self.assertGreater(reads.count('instance'), 2)
        self.assertGreater(reads.count('class'), 2)

    def test_catalog_does_not_change_registries_by_importing_optional_fields(self):
        import subprocess
        import sys
        script = '''
from django.conf import settings
settings.configure(INSTALLED_APPS=[])
import django
django.setup()
import sys
from django.db.models import DateTimeField
from django_orm_intellisense.runtime.lookup_catalog import collect_lookup_catalog
field = DateTimeField()
before = set(field.get_lookups())
collect_lookup_catalog({('app.Item', 'created'): field})
assert set(field.get_lookups()) == before
assert 'django.contrib.postgres.fields' not in sys.modules
'''
        subprocess.run([sys.executable, '-c', script], check=True)

    def test_raster_band_catalog_handles_fresh_factory_classes_without_expanding_forever(self):
        # RasterField's Django implementation generates a new class per band.
        # Reproduce that registry behavior without requiring GDAL/GEOS here.
        from django.db import models
        from django_orm_intellisense.runtime.lookup_catalog import collect_lookup_catalog

        class RasterBandTransform(models.Transform):
            __module__ = 'django.contrib.gis.db.models.lookups'

        class RasterField(models.Field):
            __module__ = 'django.contrib.gis.db.models.fields'

            def get_transform(self, name):
                try:
                    band_index = int(name)
                except ValueError:
                    return super().get_transform(name)
                return type('SpecificRasterBandTransform', (RasterBandTransform,), {'band_index': band_index})

        baseline = collect_lookup_catalog({})
        catalog = collect_lookup_catalog({('geo.Raster', 'image'): RasterField()})
        root = catalog['types'][catalog['fields']['geo.Raster']['image']]
        self.assertEqual(root['dynamicTransform']['kind'], 'band')
        band_id = root['dynamicTransform']['outputType']
        self.assertEqual(catalog['types'][band_id]['dynamicTransform']['outputType'], band_id)
        self.assertEqual(len(catalog['types']), len(baseline['types']) + 2)


if __name__ == '__main__':
    unittest.main()
