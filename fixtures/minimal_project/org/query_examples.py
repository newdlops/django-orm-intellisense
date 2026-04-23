from django.db.models import Q

from org.models import Vendor


def vendor_lookup_examples(vendor: Vendor | None):
    Vendor.objects.filter(na='demo')
    Vendor.objects.filter(cre='demo')
    Vendor.objects.filter(created_by__na='demo')
    Vendor.objects.exclude(Q(settlement_cycles__isnull=True) | Q(settlement_cycles=[]))

    if vendor is not None:
        vendor.
