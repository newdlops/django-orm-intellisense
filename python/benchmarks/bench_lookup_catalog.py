"""Shared lookup metadata cost. Run with the project's Django interpreter."""
from __future__ import annotations
import json
import statistics
import time
from datetime import datetime, timezone

import django
from django.conf import settings
if not settings.configured:
    settings.configure(INSTALLED_APPS=[])
django.setup()
from django.db import models
from django_orm_intellisense.runtime.lookup_catalog import collect_lookup_catalog

factories = [models.CharField, models.IntegerField, models.DateTimeField, models.JSONField]
registry = {('bench.Model' + str(i // 100), 'field_' + str(i % 100)): factories[i % 4]()
            for i in range(10000)}
collect_lookup_catalog(registry)
samples = []
for _ in range(5):
    start = time.perf_counter()
    catalog = collect_lookup_catalog(registry)
    samples.append((time.perf_counter() - start) * 1000)
print(json.dumps({
    'timestamp': datetime.now(timezone.utc).isoformat(), 'djangoVersion': django.get_version(),
    'fields': len(registry), 'models': 100, 'fieldKinds': [factory.__name__ for factory in factories],
    'sharedTypes': len(catalog['types']), 'medianMs': statistics.median(samples),
    'jsonBytes': len(json.dumps(catalog, separators=(',', ':')).encode()), 'repetitions': len(samples),
}, indent=2))
