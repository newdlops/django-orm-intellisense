import unittest
from unittest import mock

from tests.lookup_catalog_fixture import build_fixture
from django_orm_intellisense.runtime.lookup_catalog import collect_lookup_catalog


class LookupRegistryFastHitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        build_fixture()

    def test_repeated_default_field_registry_does_not_rescan_transform_classes(self):
        from django.db import models
        from django.db.models import Transform
        import django_orm_intellisense.runtime.lookup_catalog as collector
        registry = {('sample.Item', f'value_{number}'): models.IntegerField() for number in range(100)}
        calls = []
        original = issubclass
        def counted(cls, target):
            if target is Transform:
                calls.append(cls)
            return original(cls, target)
        with mock.patch.object(collector, 'issubclass', counted, create=True):
            selected = collect_lookup_catalog(registry, include_class_defaults=False)
        one = collect_lookup_catalog({('sample.Item', 'value_0'): models.IntegerField()}, include_class_defaults=False)
        self.assertEqual(len(selected['types']), len(one['types']))
        self.assertEqual(len(set(selected['fields']['sample.Item'].values())), 1)
        self.assertLess(len(calls), 100, 'Same default registry inspected once per repeated field')

    def test_parameterized_custom_transforms_stay_distinct_and_instance_lookup_stays_local(self):
        from django.db import models
        from django.db.models.lookups import Exact
        class Size(models.Transform):
            lookup_name = 'fast_hit_size'
            @property
            def output_field(self):
                return models.DateField() if self.lhs.output_field.max_length == 10 else models.CharField()
        class OnlyHere(Exact):
            lookup_name = 'fast_hit_only_here'
        short, long, plain = models.CharField(max_length=10), models.CharField(max_length=30), models.CharField(max_length=30)
        short.register_lookup(Size); long.register_lookup(Size)
        short.register_lookup(OnlyHere)
        registry = {('sample.Item', name): field for name, field in [('short', short), ('long', long), ('plain', plain)]}
        catalog = collect_lookup_catalog(registry, include_class_defaults=False)
        types = catalog['types']
        roots = {name: types[key] for name, key in catalog['fields']['sample.Item'].items()}
        self.assertEqual(types[roots['short']['transforms']['fast_hit_size']]['fieldKind'], 'DateField')
        self.assertEqual(types[roots['long']['transforms']['fast_hit_size']]['fieldKind'], 'CharField')
        self.assertIn('fast_hit_only_here', roots['short']['lookups'])
        self.assertNotIn('fast_hit_only_here', roots['long']['lookups'])
        self.assertNotIn('fast_hit_size', roots['plain']['transforms'])

    def test_in_place_same_size_registry_replacement_cannot_reuse_old_fast_descriptor(self):
        from django.db import models
        from django.db.models.lookups import Exact
        class Change(models.Transform):
            lookup_name = 'fast_hit_change'
            output_field = models.DateField()
        first, second = models.IntegerField(), models.IntegerField()
        shared = dict(first.get_lookups())
        shared['fast_hit_change'] = Exact
        calls = []
        def registry_for(field):
            calls.append(field)
            if field is second:
                shared['fast_hit_change'] = Change
            return shared
        with mock.patch.object(models.IntegerField, 'get_lookups', registry_for):
            selected = collect_lookup_catalog({('sample.Item', 'a'): first, ('sample.Item', 'b'): second},
                                              include_class_defaults=False)
        roots = selected['fields']['sample.Item']
        first_type, second_type = selected['types'][roots['a']], selected['types'][roots['b']]
        self.assertIn('fast_hit_change', first_type['lookups'])
        self.assertNotIn('fast_hit_change', first_type['transforms'])
        self.assertIn('fast_hit_change', second_type['transforms'])
        self.assertEqual(selected['types'][second_type['transforms']['fast_hit_change']]['fieldKind'], 'DateField')

    def test_builtin_field_method_override_keeps_per_instance_dispatch(self):
        from django.db import models
        from django.db.models.lookups import Exact
        first, second = models.IntegerField(), models.IntegerField()
        original = models.IntegerField.get_lookup
        def lookup(field, name):
            if name == 'exact' and field is second:
                return None
            return original(field, name)
        with mock.patch.object(models.IntegerField, 'get_lookup', lookup):
            catalog = collect_lookup_catalog({('sample.Item', 'a'): first, ('sample.Item', 'b'): second},
                                             include_class_defaults=False)
        roots = catalog['fields']['sample.Item']
        self.assertIn('exact', catalog['types'][roots['a']]['lookups'])
        self.assertNotIn('exact', catalog['types'][roots['b']]['lookups'])


if __name__ == '__main__':
    unittest.main()
