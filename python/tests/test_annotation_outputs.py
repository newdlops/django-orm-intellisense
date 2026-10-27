from __future__ import annotations
import importlib.util
import unittest
from tests.lookup_catalog_fixture import build_fixture


@unittest.skipUnless(importlib.util.find_spec('django'), 'Django is not installed')
class AnnotationOutputTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        classes, *_ = build_fixture()
        cls.model = next(model for model in classes if model.__name__ == 'Item')

    def test_positional_aliases_and_operators_match_django(self):
        from django.db.models import Count, F, Sum, Q
        for expression, alias in [(Count('id'), 'id__count'), (Count(F('id')), 'id__count'),
                                  (Sum('count', default=0), 'count__sum')]:
            with self.subTest(alias=alias):
                self.assertEqual(expression.default_alias, alias)
                query = self.model.objects.annotate(expression).filter(**{alias + '__gte': 1}).query
                self.assertIn(alias, query.annotations)
                self.assertEqual(type(query.annotations[alias].output_field).__name__, 'IntegerField')
                self.model.objects.annotate(expression).values(alias)
                self.model.objects.annotate(expression).order_by(alias)
        for expression in [Count('*'), Count('id', filter=Q(count__gte=1)), Sum(F('count') + 1)]:
            with self.assertRaises(TypeError):
                _ = expression.default_alias

    def test_source_expression_output_and_unicode_dynamic_paths(self):
        from django.db import models
        for expression, kind in [(models.F('title'), 'CharField'), (models.Sum('count'), 'IntegerField'),
                                  (models.Avg('count'), 'FloatField'), (models.Avg('title'), 'CharField'),
                                  (models.Value(1), 'IntegerField')]:
            self.assertEqual(type(self.model.objects.annotate(result=expression).query.annotations['result'].output_field).__name__, kind)
        for path in ['payload__고객__0__icontains', 'payload__customer name__+1__icontains']:
            self.model.objects.filter(**{path: 'value'})
        self.model.objects.annotate(한글=models.Count('id')).filter(한글__gte=1)
        for path in ['owner', 'owner_id']:
            field = self.model.objects.annotate(copy=models.F(path)).query.annotations['copy'].output_field
            self.assertEqual(type(field).__name__, 'CharField')
            self.assertIsNotNone(field.get_lookup('icontains'))
        self.assertIs(self.model.objects.annotate(average=models.Avg('title')).query.annotations['average'].output_field,
                      self.model._meta.get_field('title'))

    def test_parameterized_array_output_and_source_registrations(self):
        try:
            from django.contrib.postgres.fields import ArrayField
            from django.contrib.postgres.aggregates import ArrayAgg
        except ImportError:
            self.skipTest('psycopg is not installed')
        from django.db import models
        expression = models.Value([], output_field=ArrayField(models.DateTimeField()))
        query = self.model.objects.annotate(dates=expression).filter(dates__0__year__gte=2026).query
        self.assertEqual(type(query.annotations['dates'].output_field.base_field).__name__, 'DateTimeField')
        self.model.objects.annotate(dates=expression).filter(dates__len__gte=1)
        query = self.model.objects.annotate(titles=ArrayAgg('title')).filter(titles__0__only_here='x').query
        self.assertIs(query.annotations['titles'].output_field.base_field, self.model._meta.get_field('title'))


if __name__ == '__main__':
    unittest.main()
