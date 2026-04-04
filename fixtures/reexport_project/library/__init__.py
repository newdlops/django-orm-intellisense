from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .public import Book, Shelf
    from .querysets import BookQuerySet

__all__ = ['Book', 'Shelf', 'BookQuerySet']


def __getattr__(name: str) -> Any:
    if name == 'BookQuerySet':
        from .querysets import BookQuerySet

        return BookQuerySet
    if name in {'Book', 'Shelf'}:
        from .public import Book, Shelf

        return {
            'Book': Book,
            'Shelf': Shelf,
        }[name]

    raise AttributeError(f'module {__name__!r} has no attribute {name!r}')
