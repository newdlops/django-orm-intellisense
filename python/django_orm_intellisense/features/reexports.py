from __future__ import annotations

from ..static_index.indexer import StaticIndex


def resolve_export_origin(
    *,
    static_index: StaticIndex,
    module_name: str,
    symbol: str,
) -> dict[str, object]:
    resolution = static_index.resolve_export_origin(module_name, symbol)
    return resolution.to_dict()
