from django.db import models


class Vendor(models.Model):
    name = models.CharField(max_length=128)
    settlement_cycles = models.JSONField(blank=True, null=True)
