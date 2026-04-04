from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .models import Category

__all__ = ['Category']


def __getattr__(name: str) -> Any:
    if name != 'Category':
        raise AttributeError(f'module {__name__!r} has no attribute {name!r}')

    from .models import Category

    return Category
