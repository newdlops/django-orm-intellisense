"""Real-Django oracle shared by Python tests and the TypeScript resolver tests."""
from __future__ import annotations

import json
import sys
from functools import lru_cache


@lru_cache(maxsize=1)
def _build_fixture():
    import django
    from django.conf import settings
    if not settings.configured:
        settings.configure(INSTALLED_APPS=[], DATABASES={
            'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'},
        })
    django.setup()
    from django.db import models
    from django.db.models.functions import Length, Lower
    from django.db.models.lookups import Exact
    from django_orm_intellisense.runtime import inspector
    from django_orm_intellisense.runtime.lookup_catalog import collect_lookup_catalog
    from django_orm_intellisense.semantic.graph import build_model_graph
    from django_orm_intellisense.static_index.indexer import StaticIndex

    class OnlyHere(Exact):
        lookup_name = 'only_here'

    class SizeAware(models.Transform):
        lookup_name = 'size_aware'

        @property
        def output_field(self):
            return models.IntegerField() if self.lhs.output_field.max_length == 10 else models.CharField()

    class Owner(models.Model):
        slug = models.CharField(max_length=30, primary_key=True)

        class Meta:
            app_label = 'lookup_test'

    class Item(models.Model):
        title = models.CharField(max_length=30)
        short = models.CharField(max_length=10)
        other = models.CharField(max_length=30)
        count = models.IntegerField()
        published = models.DateTimeField()
        payload = models.JSONField()
        uuid = models.UUIDField()
        owner = models.ForeignKey(Owner, on_delete=models.CASCADE)
        generated = models.GeneratedField(expression=models.F('published'),
                                          output_field=models.DateTimeField(), db_persist=True)

        class Meta:
            app_label = 'lookup_test'

    Item._meta.get_field('title').register_lookup(OnlyHere)
    Item._meta.get_field('owner').register_lookup(Length)
    for name in ('title', 'short'):
        field = Item._meta.get_field(name)
        field.register_lookup(Length)
        field.register_lookup(Lower)
        field.register_lookup(SizeAware)

    model_classes = [Owner, Item]
    if hasattr(models, 'CompositePrimaryKey'):
        class Pair(models.Model):
            pk = models.CompositePrimaryKey('left', 'right')
            left = models.IntegerField()
            right = models.IntegerField()

            class Meta:
                app_label = 'lookup_test'
        model_classes.append(Pair)
    try:
        from django.contrib.postgres.fields import ArrayField, HStoreField, IntegerRangeField

        class Collection(models.Model):
            tags = ArrayField(models.CharField(max_length=20))
            attributes = HStoreField()
            span = IntegerRangeField()

            class Meta:
                app_label = 'lookup_test'
        model_classes.append(Collection)
    except ImportError:
        pass
    try:
        from django.contrib.gis.db.models import PointField, RasterField

        class Place(models.Model):
            location = PointField()

            class Meta:
                app_label = 'lookup_test'
        model_classes.append(Place)

        class Tile(models.Model):
            image = RasterField()

            class Meta:
                app_label = 'lookup_test'
        model_classes.append(Tile)
    except (ImportError, Exception):
        pass

    registry = {}
    summaries = []
    for model in model_classes:
        fields = []
        relations = []
        for field in model._meta.get_fields():
            inspector._register_runtime_field(registry, model_label=model._meta.label, field=field)
            target = inspector._related_model_label(field)
            fields.append(inspector.RuntimeFieldSummary(
                name=field.name, field_kind=type(field).__name__, is_relation=field.is_relation,
                related_model_label=target, direction='forward' if field.is_relation else None,
            ))
            if field.is_relation:
                relations.append(inspector.RuntimeRelationSummary(field.name, target, 'forward', type(field).__name__))
        summaries.append(inspector.RuntimeModelSummary(
            model._meta.label, model.__module__, [f.name for f in fields],
            [r.name for r in relations], [], fields, relations, ['objects'],
        ))
    inspector._set_runtime_field_registry('lookup_fixture', registry)
    catalog = collect_lookup_catalog(registry)
    runtime = inspector.RuntimeInspection(
        sys.executable, True, django.get_version(), 'ready', 'lookup_fixture', None,
        1, len(summaries), len(registry), 1, 0, len(summaries), summaries, summaries,
        lookup_catalog=catalog,
    )
    static = StaticIndex(0, 0, 0, 0, 0, {}, [])
    graph = build_model_graph(static, runtime)
    surface = {}
    for model in model_classes:
        surface[model._meta.label] = {'instance': {
            field.name: [
                'instance' if field.is_relation else 'scalar', field.related_model_label,
                'relation' if field.is_relation else 'field', field.field_kind,
            ] for field in graph.fields_for_model(model._meta.label)
        }}
    return model_classes, registry, runtime, graph, surface


def build_fixture():
    result = _build_fixture()
    from django_orm_intellisense.runtime import inspector
    inspector._set_runtime_field_registry('lookup_fixture', result[1])
    return result


def build_payload(model_classes, runtime, surface):
    from django.db import models
    paths = {
        'Item': ['title__only_here', 'other__only_here', 'title__lower__length__gte',
                 'title__length__year', 'title__size_aware__contains', 'short__size_aware__gte',
                 'published__date__year__gte', 'published__iso_week_day', 'count__year',
                 'payload__nested__0__name__icontains', 'payload__contains__nested__isnull',
                 'payload__constructor__icontains', 'payload__toString__isnull',
                 'owner__in', 'owner__slug__icontains', 'owner_id__icontains',
                 'owner__length__gte', 'owner_id__length__gte',
                 'generated__date__iso_year', 'uuid__startswith'],
        'Owner': ['pk__icontains', 'id'],
        'Pair': ['pk__exact', 'pk__in', 'pk__regex', 'pk__range', 'id'],
        'Collection': ['tags__len__gte', 'tags__0__icontains', 'tags__0_2__contains',
                       'tags__0_2__0__startswith', 'attributes__key__icontains',
                       'span__startswith__gte', 'span__isempty'],
        'Place': ['location__num_dimensions__gte', 'location__isempty'],
        'Tile': ['image__1__contains', 'image__1__2__intersects', 'image__band__contains'],
    }
    oracle = []
    for model in model_classes:
        candidates = paths.get(model.__name__, [])
        if model.__name__ == 'Pair':
            from django.db import connection
            with connection.schema_editor() as editor:
                editor.create_model(model)
        for path in candidates:
            for method in ['filter', 'values']:
                try:
                    if method == 'filter':
                        rhs = models.F('pk')
                        if model.__name__ == 'Pair' and path == 'pk__exact': rhs = (1, 2)
                        if model.__name__ == 'Pair' and path == 'pk__in': rhs = [(1, 2)]
                        query = model.objects.filter(**{path: rhs})
                        if model.__name__ == 'Pair':
                            list(query)
                    else:
                        model.objects.values(path)
                    resolved = True
                except Exception:
                    resolved = False
                oracle.append({'model': model._meta.label, 'path': path,
                               'method': method, 'resolved': resolved})
    return {'surfaceIndex': surface, 'lookupCatalog': runtime.lookup_catalog,
            'djangoVersion': runtime.django_version, 'oracleCases': oracle}


if __name__ == '__main__':
    model_classes, _, runtime, _, surface = build_fixture()
    print(json.dumps(build_payload(model_classes, runtime, surface)))
