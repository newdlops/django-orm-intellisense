from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .models import Author, MultiInheritedLog, Post, Profile, Tag

__all__ = ['Author', 'Profile', 'Post', 'Tag', 'MultiInheritedLog']


def __getattr__(name: str) -> Any:
    if name not in __all__:
        raise AttributeError(f'module {__name__!r} has no attribute {name!r}')

    from .models import Author, MultiInheritedLog, Post, Profile, Tag

    return {
        'Author': Author,
        'Profile': Profile,
        'Post': Post,
        'Tag': Tag,
        'MultiInheritedLog': MultiInheritedLog,
    }[name]
