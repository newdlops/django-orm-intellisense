"""Ordinary daemon worker control that recomputes cached surface fingerprints."""
from django_orm_intellisense.server import app
from django_orm_intellisense.__main__ import main

_load_surface = app.load_cached_surface_index


def load_surface_without_saved_fingerprints(*args, **kwargs):
    kwargs.pop('with_fingerprints', None)
    return _load_surface(*args, **kwargs)


app.load_cached_surface_index = load_surface_without_saved_fingerprints

if __name__ == '__main__':
    main()
