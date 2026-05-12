"""Fixture exercising lookups on plural-named function parameters that
should map to a singular model via the snake_case→PascalCase fuzzy
fallback.

Production trace captured patterns like `directors_meeting.director_attendance_set`
as noRecv samples. The variable name (e.g. `vendors`, `directors_meeting`)
is plural in style but the underlying intent is a singular model
(`Vendor`, `DirectorMeeting`). The receiver resolver now tries
"drop trailing 's' from each segment" variants so these patterns
resolve without explicit type annotations.

This fixture uses `vendors` parameter (plural) referring to the
singular `Vendor` model in org/models/. The fuzzy fallback should
recognize `vendors` → `Vendor` and resolve `vendors.<field>` lookups
via the model graph.
"""
from org.models import Vendor  # noqa: F401 — keeps app routing stable


def collection_filter_lookups(vendors):
    vendors.filter(name__contains="a")
    vendors.filter(name__icontains="b")
    vendors.filter(name__startswith="c")
    vendors.filter(name__endswith="d")
    vendors.filter(name__exact="e")
    vendors.filter(name__iexact="f")
    vendors.filter(name__regex="g")
    if not vendors.filter(name__contains="h").exists():
        pass
    if not vendors.filter(name__contains="i").exists():
        pass
    return vendors.filter(name__contains="j")
