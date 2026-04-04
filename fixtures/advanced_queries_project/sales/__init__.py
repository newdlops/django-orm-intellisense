from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .models import LineItem, Order, Product

__all__ = ['Product', 'Order', 'LineItem']


def __getattr__(name: str) -> Any:
    if name not in __all__:
        raise AttributeError(f'module {__name__!r} has no attribute {name!r}')

    from .models import LineItem, Order, Product

    return {
        'Product': Product,
        'Order': Order,
        'LineItem': LineItem,
    }[name]
