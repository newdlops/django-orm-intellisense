# Fixture for captain regression reproduction.
# Contains plain Model.objects.filter calls WITHOUT importing the class.
# This mirrors the captain scenario where the daemon's local indices
# don't have the model and the resolver has no import binding to fall
# back to either - the only resolution paths are short-name index
# lookup or BG IPC. When the test drops Author from every local index
# AND forces resolveRelationTarget unresolved, this fixture's lookups
# should all land in noRecv (unknown_root).


def use_author_filter():
    return Author.objects.filter(name__icontains='django')


def use_author_filter_2():
    return Author.objects.filter(name__exact='Alice')


def use_author_get():
    return Author.objects.get(name__startswith='X')


def use_author_exclude():
    return Author.objects.exclude(name__endswith='z')


def use_author_count():
    return Author.objects.filter(name__contains='abc').count()
