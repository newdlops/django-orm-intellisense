"""Fixture exercising lookups inside Python boolean / conditional contexts.

The diagnostic resolver used to strip whitespace via `compactPythonExpression`
without preserving word boundaries — `not Post.objects.filter(...)` would
collapse into `notPost.objects.filter(...)`, making the receiver look like
the identifier `notPost`. That produced spurious noRecv exits even though
the real receiver (`Post.objects`) is fully resolvable.

Every lookup below uses a valid Post lookup string. After the fix, none of
these should end up in the noRecv exit bucket of phase2-lookups.
"""
from blog import Post


def conditional_lookups():
    if not Post.objects.filter(title__contains="a").exists():
        pass
    if not Post.objects.filter(author__name__contains="b").exists():
        pass
    if Post.objects.filter(title__startswith="c").exists() and Post.objects.filter(title__endswith="d").exists():
        pass
    assert Post.objects.filter(title__icontains="e").count() > 0
    assert not Post.objects.filter(title__iexact="f").exists()
    while Post.objects.filter(title__regex="g").exists():
        break
    return Post.objects.filter(title__startswith="h")


def more_conditionals():
    if not Post.objects.filter(title__contains="i").exists():
        pass
    if not Post.objects.filter(title__contains="j").exists():
        pass
    if not Post.objects.filter(title__contains="k").exists():
        pass
    if not Post.objects.filter(title__contains="l").exists():
        pass
    if not Post.objects.filter(title__contains="m").exists():
        pass
    if not Post.objects.filter(title__contains="n").exists():
        pass
    if not Post.objects.filter(title__contains="o").exists():
        pass
    if not Post.objects.filter(title__contains="p").exists():
        pass
</content>
