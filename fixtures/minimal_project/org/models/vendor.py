from django.db import models

from .base import VendorBase


class Vendor(VendorBase):
    name = models.CharField(max_length=128)
    settlement_cycles = models.JSONField(blank=True, null=True)
