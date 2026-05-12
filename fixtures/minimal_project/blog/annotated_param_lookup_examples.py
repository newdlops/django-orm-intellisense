"""Fixture exercising lookup receivers on annotated function parameters.

Production trace from captain workspace showed noRecvSamples patterns like
`directors_meeting.director_attendance_set` where `directors_meeting` is a
function parameter typed as `DirectorsMeeting`. The type-annotation
infrastructure (`findFunctionParameterTypeAnnotation`,
`resolveAnnotatedReceiverForMemberAccess`) exists but its integration with
the diagnostic receiver resolver was not verified end-to-end.

This fixture uses Author as the typed parameter (which has reverse
accessor `posts` from Post.author ForeignKey with related_name='posts').
The diagnostic resolver should pick up `Author` from the annotation and
resolve `author.posts.filter(...)` against the Post model.
"""
from blog import Author, Post


def lookups_from_typed_param(author: Author):
    Post.objects.filter(author__name__contains="x")
    author.posts.filter(title__contains="a")
    author.posts.filter(title__contains="b")
    author.posts.filter(title__contains="c")
    author.posts.filter(title__contains="d")
    author.posts.filter(title__contains="e")
    author.posts.filter(title__icontains="f")
    author.posts.filter(title__startswith="g")
    author.posts.filter(title__endswith="h")
    author.posts.filter(title__exact="i")
    author.posts.filter(published=True)


def lookups_with_local_annotation():
    a: Author
    a.posts.filter(title__contains="j")
    a.posts.filter(title__contains="k")
    a.posts.filter(title__contains="l")
