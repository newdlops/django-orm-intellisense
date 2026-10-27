from django.db import models
from django.db.models.functions import Length, Lower
from django.db.models.lookups import Exact


class InstanceOnlyLookup(Exact):
    lookup_name = 'instance_only'


class LookupSample(models.Model):
    title = models.CharField(max_length=255)
    other = models.CharField(max_length=255)
    created = models.DateTimeField()
    payload = models.JSONField()
    이름 = models.CharField(max_length=50)


LookupSample._meta.get_field('title').register_lookup(InstanceOnlyLookup)
LookupSample._meta.get_field('title').register_lookup(Length)
LookupSample._meta.get_field('title').register_lookup(Lower)
