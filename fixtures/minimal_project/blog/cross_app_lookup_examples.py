"""Fixture exercising lookups against models in a different app of the
same workspace.

`Vendor` lives in `org/models/vendor.py` while this file lives in `blog/`.
The diagnostic resolver should discover `Vendor` from the workspace
static index (it is one of the indexed models) and resolve
`Vendor.objects.filter(...)` against it.

Production trace included `RegistrationAssistance.objects` style noRecv
samples — workspace-defined models that the receiver resolver failed to
locate. This fixture is the minimal reproducer.
"""
from org.models import Vendor


def cross_app_lookups():
    Vendor.objects.filter(name__contains="a")
    Vendor.objects.filter(name__icontains="b")
    Vendor.objects.filter(name__startswith="c")
    Vendor.objects.filter(name__endswith="d")
    Vendor.objects.filter(name__exact="e")
    Vendor.objects.filter(name__iexact="f")
    Vendor.objects.filter(name__regex="g")
    if not Vendor.objects.filter(name__contains="h").exists():
        pass
    if not Vendor.objects.filter(name__contains="i").exists():
        pass
    assert Vendor.objects.filter(name__contains="j").count() >= 0
