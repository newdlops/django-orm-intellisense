"""Optional real GeoDjango integration oracle; requires GEOS/GDAL/SpatiaLite."""
from __future__ import annotations

import os
import json
import sys

import django
from django.conf import settings

settings.configure(
    INSTALLED_APPS=[],
    DATABASES={'default': {'ENGINE': 'django.contrib.gis.db.backends.spatialite', 'NAME': ':memory:'}},
    SPATIALITE_LIBRARY_PATH=os.environ['SPATIALITE_LIBRARY_PATH'],
)
django.setup()

from django.contrib.gis.db import models
from django.contrib.gis.db.models.functions import IsEmpty, NumDimensions
from django.contrib.gis.geos import Point
from django.db import connection
from django.db.models.expressions import Col
from django_orm_intellisense.features.lookup_paths import list_lookup_path_completions, resolve_lookup_path
from tests.lookup_catalog_fixture import build_fixture, build_payload

classes, registry, runtime, graph, surface = build_fixture()
place = next(model for model in classes if model.__name__ == 'Place')
tile = next(model for model in classes if model.__name__ == 'Tile')
with connection.cursor() as cursor:
    cursor.execute('SELECT InitSpatialMetaData(1)')
with connection.schema_editor() as editor:
    editor.create_model(place)
place.objects.create(location=Point(1, 2, srid=4326))
assert list(place.objects.values_list('location__num_dimensions', flat=True)) == [2]
assert place.objects.filter(location__num_dimensions__gte=2).count() == 1
assert place.objects.filter(location__num_dimensions=3).count() == 0
assert place.objects.filter(location__isempty=False).count() == 1
assert list(place.objects.annotate(empty=IsEmpty('location')).values_list('empty', flat=True)) == [False]
point3d = models.Value(Point(1, 2, 3, srid=4326), output_field=models.PointField(dim=3))
assert list(place.objects.annotate(dimensions=NumDimensions(point3d)).values_list('dimensions', flat=True)) == [3]
result = resolve_lookup_path(model_graph=graph, runtime=runtime, base_model_label=place._meta.label,
                             path='location__num_dimensions__gte', method='filter')
assert result['resolved'] and result['terminalType']['outputFieldKind'] == 'IntegerField', result
items = list_lookup_path_completions(model_graph=graph, runtime=runtime, base_model_label=place._meta.label,
                                    prefix='location__num_dimensions__', method='filter')['items']
assert 'gte' in {item['name'] for item in items}
assert 'bbcontains' not in {item['name'] for item in items}
image = tile._meta.get_field('image')
band = image.get_transform('1')(Col('__djls__', image))
assert band.band_index == 1 and band.output_field is image
descriptor = runtime.lookup_catalog['types'][runtime.lookup_catalog['fields'][tile._meta.label]['image']]
assert descriptor['dynamicTransform']['kind'] == 'band'
assert len(runtime.lookup_catalog['types']) < 100
print('GeoDjango SQL: dimension 2/3, num_dimensions operators, isempty; real raster registry passed', file=sys.stderr)
print(json.dumps(build_payload(classes, runtime, surface)))
