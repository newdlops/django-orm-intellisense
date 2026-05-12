# Fixture for captain regression: classifier sees the `return` keyword as
# the root identifier because it only normalizes the receiver expression
# on the resolver path, not the classifier path.
#
# Each chain below shadows `Author` with an unresolvable function call so
# the receiver-resolver short-circuits to the assignment, fails to resolve
# the shadow, and ultimately returns undefined. The classifier then runs
# on the raw expression — with the bug, it extracts `return` as the root
# and buckets the lookup as `unknown_root`. The desired post-fix behavior
# is to normalize the expression first and bucket it as
# `root_matched:Author`.
from blog import Author


def returns_chain_a():
    Author = _no_such_factory_one()
    return Author.objects.filter(name__icontains='django')


def returns_chain_b():
    Author = _no_such_factory_two()
    return Author.objects.filter(name__exact='Alice')


def returns_chain_c():
    Author = _no_such_factory_three()
    return Author.objects.filter(name__startswith='X')


def returns_chain_d():
    Author = _no_such_factory_four()
    return Author.objects.filter(name__endswith='z')


def returns_chain_e():
    Author = _no_such_factory_five()
    return Author.objects.filter(name__contains='abc')


def returns_chain_f():
    Author = _no_such_factory_six()
    return Author.objects.filter(name__regex='.+')
