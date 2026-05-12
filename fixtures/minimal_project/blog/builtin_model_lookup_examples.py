"""Fixture exercising lookups on Django built-in models.

Production trace captured `User.objects` (Django's auth.User) as a noRecv
sample because the workspace-discovery pass naturally misses Django's
own packaged models. The daemon now ships a small static-fallback bundle
for the most common built-ins (auth.User, auth.Group, auth.Permission,
contenttypes.ContentType, sessions.Session) so receivers like
`User.objects.filter(...)` resolve and lookup paths can be validated.
"""
from django.contrib.auth.models import User, Group, Permission
from django.contrib.contenttypes.models import ContentType
from django.contrib.sessions.models import Session


def builtin_lookups():
    User.objects.filter(username__contains="a")
    User.objects.filter(username__icontains="b")
    User.objects.filter(email__contains="c")
    User.objects.filter(email__startswith="d")
    User.objects.filter(first_name__contains="e")
    User.objects.filter(last_name__contains="f")
    User.objects.filter(is_active=True)
    User.objects.filter(is_staff=False)
    User.objects.filter(is_superuser=False)
    User.objects.filter(date_joined__year=2024)
    Group.objects.filter(name__contains="g")
    Permission.objects.filter(codename__contains="h")
    ContentType.objects.filter(app_label__contains="i")
    ContentType.objects.filter(model__contains="j")
    Session.objects.filter(expire_date__year=2024)
    if not User.objects.filter(username__contains="k").exists():
        pass
    if not Group.objects.filter(name__exact="l").exists():
        pass
