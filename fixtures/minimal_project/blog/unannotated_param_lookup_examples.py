"""Fixture exercising lookups on UN-annotated function parameters.

Production trace captured `directors_meeting.director_attendance_set`
patterns — function parameter named with snake_case matching a model
PascalCase name (`DirectorsMeeting`) but without an explicit type
annotation. The receiver resolver already has a snake→pascal fallback;
this fixture verifies it works through the diagnostic pipeline so the
unannotated-param + reverse-accessor pattern doesn't end up in noRecv.

`author` (unannotated) → snake-to-Pascal → `Author` → instance type;
`.posts` is the reverse accessor from `Post.author` (related_name='posts').
"""
from blog import Post


def lookups_via_unannotated_param(author):
    author.posts.filter(title__contains="a")
    author.posts.filter(title__contains="b")
    author.posts.filter(title__icontains="c")
    author.posts.filter(title__startswith="d")
    author.posts.filter(title__endswith="e")
    author.posts.filter(title__exact="f")
    author.posts.filter(published=True)
    if not author.posts.filter(title__contains="g").exists():
        pass
    if not author.posts.filter(title__contains="h").exists():
        pass
    return Post.objects.filter(author=author)
