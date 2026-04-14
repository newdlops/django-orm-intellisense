from __future__ import annotations

from typing import cast

from ..runtime.inspector import RuntimeInspection, get_runtime_field
from ..semantic.graph import ModelGraph
from ..static_index.indexer import FieldCandidate

RELATION_ONLY_METHODS = {'select_related', 'prefetch_related'}
ATTRIBUTE_PATH_METHODS = {'select_related', 'prefetch_related', 'only', 'defer'}
FILTER_LOOKUP_METHODS = {'filter', 'exclude', 'get', 'get_or_create', 'update_or_create'}
DEFAULT_LOOKUP_OPERATORS = (
    'exact',
    'iexact',
    'contains',
    'icontains',
    'in',
    'gt',
    'gte',
    'lt',
    'lte',
    'startswith',
    'istartswith',
    'endswith',
    'iendswith',
    'range',
    'isnull',
    'regex',
    'iregex',
    'date',
    'year',
    'month',
    'day',
    'week',
    'week_day',
    'quarter',
    'time',
    'hour',
    'minute',
    'second',
)

_ONE_HOP_DESCENDANT_CACHE_OWNER = 0
_ONE_HOP_DESCENDANT_CACHE: dict[
    tuple[str, str, bool],
    tuple[dict[str, object], ...],
] = {}

# Maximum number of items returned by lookupPathCompletions.
# Keeps serialised JSON payloads small enough that they do not
# block the stdout IPC pipe for hundreds of milliseconds.
MAX_LOOKUP_PATH_ITEMS = 500


def list_lookup_path_completions(
    *,
    model_graph: ModelGraph,
    runtime: RuntimeInspection,
    base_model_label: str,
    prefix: str,
    method: str,
) -> dict[str, object]:
    normalized_prefix = _normalize_lookup_path(prefix, method)
    completed_segments, current_partial = _split_lookup_prefix(normalized_prefix)
    traversal = _analyze_lookup_completion_context(
        model_graph=model_graph,
        runtime=runtime,
        base_model_label=base_model_label,
        segments=completed_segments,
        method=method,
    )
    if not traversal['resolved']:
        return {
            'items': [],
            'resolved': False,
            'reason': traversal['reason'],
        }

    include_prefixed_lookup_items = (
        method in FILTER_LOOKUP_METHODS
        and (bool(current_partial) or not completed_segments)
    )
    include_eager_descendants = not completed_segments

    items: list[dict[str, object]]
    if traversal['completionMode'] == 'field':
        current_model_label = str(traversal['currentModelLabel'])
        relation_only = method in RELATION_ONLY_METHODS
        matching_fields = [
            field
            for field in _lookup_fields_for_method(
                model_graph=model_graph,
                model_label=current_model_label,
                method=method,
            )
            if (field.is_relation or not relation_only)
            and field.name.startswith(current_partial)
        ]
        items = [
            _lookup_item_dict(field)
            for field in matching_fields
        ]
        if include_prefixed_lookup_items:
            items.extend(
                _prefixed_lookup_chain_completion_items(
                    runtime=runtime,
                    fields=matching_fields,
                )
            )
        if include_eager_descendants:
            items.extend(
                _lookup_descendant_completion_items(
                    model_graph=model_graph,
                    model_label=current_model_label,
                    current_partial=current_partial,
                    relation_only=relation_only,
                    method=method,
                )
            )
    elif traversal['completionMode'] == 'field_and_lookup':
        current_model_label = str(traversal['currentModelLabel'])
        relation_only = method in RELATION_ONLY_METHODS
        matching_fields = [
            field
            for field in _lookup_fields_for_method(
                model_graph=model_graph,
                model_label=current_model_label,
                method=method,
            )
            if (field.is_relation or not relation_only)
            and field.name.startswith(current_partial)
        ]
        items = [
            _lookup_item_dict(field)
            for field in matching_fields
        ]
        if include_prefixed_lookup_items:
            items.extend(
                _prefixed_lookup_chain_completion_items(
                    runtime=runtime,
                    fields=matching_fields,
                )
            )
        if include_eager_descendants:
            items.extend(
                _lookup_descendant_completion_items(
                    model_graph=model_graph,
                    model_label=current_model_label,
                    current_partial=current_partial,
                    relation_only=relation_only,
                    method=method,
                )
            )
        items.extend(
            _lookup_chain_completion_items(
                runtime=runtime,
                field=traversal['lookupField'],
                current_partial=current_partial,
            )
        )
    else:
        items = _lookup_chain_completion_items(
            runtime=runtime,
            field=traversal['lookupField'],
            current_partial=current_partial,
            runtime_field=traversal.get('runtimeField'),
        )

    items.sort(
        key=lambda item: (
            _lookup_completion_group(item),
            str(item['name']).count('__'),
            0 if item.get('isRelation') else 1,
            str(item['name']).lower(),
        )
    )
    truncated = len(items) > MAX_LOOKUP_PATH_ITEMS
    if truncated:
        items = items[:MAX_LOOKUP_PATH_ITEMS]
    return {
        'items': items,
        'resolved': True,
        'currentModelLabel': traversal.get('currentModelLabel'),
        'truncated': truncated,
    }


def resolve_lookup_path(
    *,
    model_graph: ModelGraph,
    runtime: RuntimeInspection,
    base_model_label: str,
    path: str,
    method: str,
) -> dict[str, object]:
    normalized_path = _normalize_lookup_path(path, method)
    if not normalized_path:
        return {
            'resolved': False,
            'reason': 'empty',
        }

    segments = [segment for segment in normalized_path.split('__') if segment]
    current_model_label = base_model_label
    resolved_segments: list[dict[str, object]] = []
    terminal_field: FieldCandidate | None = None
    lookup_operator: str | None = None

    for index, segment in enumerate(segments):
        field = _lookup_field_for_method(
            model_graph=model_graph,
            model_label=current_model_label,
            field_name=segment,
            method=method,
        )
        if field is None:
            if (
                method in FILTER_LOOKUP_METHODS
                and terminal_field is not None
            ):
                lookup_resolution = _resolve_lookup_chain(
                    runtime=runtime,
                    field=terminal_field,
                    segments=segments[index:],
                )
                if lookup_resolution['resolved']:
                    lookup_operator = lookup_resolution.get('lookupOperator')
                    break
                return {
                    'resolved': False,
                    'reason': lookup_resolution['reason'],
                    'resolvedSegments': resolved_segments,
                    'missingSegment': lookup_resolution.get('missingSegment', segment),
                }
            return {
                'resolved': False,
                'reason': 'segment_not_found',
                'resolvedSegments': resolved_segments,
                'missingSegment': segment,
            }

        resolved_segments.append(_lookup_item_dict(field))
        terminal_field = field

        is_last = index == len(segments) - 1
        if is_last:
            break

        next_segment = segments[index + 1]
        if field.is_relation and field.related_model_label:
            next_field = _lookup_field_for_method(
                model_graph=model_graph,
                model_label=field.related_model_label,
                field_name=next_segment,
                method=method,
            )
            if next_field is not None:
                current_model_label = field.related_model_label
                continue

            if method in FILTER_LOOKUP_METHODS:
                lookup_resolution = _resolve_lookup_chain(
                    runtime=runtime,
                    field=field,
                    segments=segments[index + 1:],
                )
                if lookup_resolution['resolved']:
                    lookup_operator = lookup_resolution.get('lookupOperator')
                    break
                return {
                    'resolved': False,
                    'reason': lookup_resolution['reason'],
                    'resolvedSegments': resolved_segments,
                    'missingSegment': lookup_resolution.get('missingSegment', next_segment),
                }

            return {
                'resolved': False,
                'reason': 'segment_not_found',
                'resolvedSegments': resolved_segments,
                'missingSegment': next_segment,
            }

        if not field.is_relation or not field.related_model_label:
            if method in FILTER_LOOKUP_METHODS:
                lookup_resolution = _resolve_lookup_chain(
                    runtime=runtime,
                    field=field,
                    segments=segments[index + 1:],
                )
                if lookup_resolution['resolved']:
                    lookup_operator = lookup_resolution.get('lookupOperator')
                    break
                return {
                    'resolved': False,
                    'reason': lookup_resolution['reason'],
                    'resolvedSegments': resolved_segments,
                    'missingSegment': lookup_resolution.get('missingSegment', next_segment),
                }

            return {
                'resolved': False,
                'reason': 'non_relation_intermediate',
                'resolvedSegments': resolved_segments,
                'missingSegment': segment,
            }

    if terminal_field is None:
        return {
            'resolved': False,
            'reason': 'empty',
        }

    if method in RELATION_ONLY_METHODS and not terminal_field.is_relation:
        return {
            'resolved': False,
            'reason': 'relation_required',
            'resolvedSegments': resolved_segments,
        }

    return {
        'resolved': True,
        'target': _lookup_item_dict(terminal_field),
        'resolvedSegments': resolved_segments,
        'baseModelLabel': base_model_label,
        'lookupOperator': lookup_operator,
    }


def _analyze_lookup_completion_context(
    *,
    model_graph: ModelGraph,
    runtime: RuntimeInspection,
    base_model_label: str,
    segments: list[str],
    method: str,
) -> dict[str, object]:
    current_model_label = base_model_label
    last_field: FieldCandidate | None = None
    index = 0
    visited_models: set[str] = {base_model_label}

    while index < len(segments):
        segment = segments[index]
        field = _lookup_field_for_method(
            model_graph=model_graph,
            model_label=current_model_label,
            field_name=segment,
            method=method,
        )
        if field is None:
            return {
                'resolved': False,
                'reason': 'segment_not_found',
            }

        last_field = field

        next_segment = segments[index + 1] if index + 1 < len(segments) else None
        if next_segment is None:
            if field.is_relation and field.related_model_label:
                if method in FILTER_LOOKUP_METHODS:
                    return {
                        'resolved': True,
                        'currentModelLabel': field.related_model_label,
                        'completionMode': 'field_and_lookup',
                        'lookupField': field,
                    }
                return {
                    'resolved': True,
                    'currentModelLabel': field.related_model_label,
                    'completionMode': 'field',
                }

            if method in FILTER_LOOKUP_METHODS:
                lookup_context = _resolve_lookup_completion_chain(
                    runtime=runtime,
                    field=field,
                    segments=[],
                )
                return {
                    'resolved': lookup_context['resolved'],
                    'reason': lookup_context.get('reason'),
                    'completionMode': 'lookup_chain' if lookup_context['resolved'] else None,
                    'lookupField': field,
                    'runtimeField': lookup_context.get('runtimeField'),
                }

            return {
                'resolved': False,
                'reason': 'non_relation_intermediate',
            }

        if field.is_relation and field.related_model_label:
            next_field = _lookup_field_for_method(
                model_graph=model_graph,
                model_label=field.related_model_label,
                field_name=next_segment,
                method=method,
            )
            if next_field is not None:
                if field.related_model_label in visited_models:
                    # Cycle detected — stop traversal, return what we have.
                    return {
                        'resolved': True,
                        'currentModelLabel': field.related_model_label,
                        'completionMode': 'field',
                    }
                visited_models.add(field.related_model_label)
                current_model_label = field.related_model_label
                index += 1
                continue

            if method in FILTER_LOOKUP_METHODS:
                lookup_context = _resolve_lookup_completion_chain(
                    runtime=runtime,
                    field=field,
                    segments=segments[index + 1:],
                )
                return {
                    'resolved': lookup_context['resolved'],
                    'reason': lookup_context.get('reason'),
                    'completionMode': 'lookup_chain' if lookup_context['resolved'] else None,
                    'lookupField': field,
                    'runtimeField': lookup_context.get('runtimeField'),
                }

            return {
                'resolved': False,
                'reason': 'segment_not_found',
            }

        if method in FILTER_LOOKUP_METHODS:
            lookup_context = _resolve_lookup_completion_chain(
                runtime=runtime,
                field=field,
                segments=segments[index + 1:],
            )
            return {
                'resolved': lookup_context['resolved'],
                'reason': lookup_context.get('reason'),
                'completionMode': 'lookup_chain' if lookup_context['resolved'] else None,
                'lookupField': field,
                'runtimeField': lookup_context.get('runtimeField'),
            }

        return {
            'resolved': False,
            'reason': 'non_relation_intermediate',
        }

    if (
        last_field is not None
        and method in FILTER_LOOKUP_METHODS
        and not last_field.is_relation
    ):
        return {
            'resolved': True,
            'completionMode': 'lookup_chain',
            'lookupField': last_field,
        }

    return {
        'resolved': True,
        'currentModelLabel': current_model_label,
        'completionMode': 'field',
    }


def _split_lookup_prefix(prefix: str) -> tuple[list[str], str]:
    if not prefix:
        return [], ''

    if prefix.endswith('__'):
        return [segment for segment in prefix.split('__') if segment], ''

    parts = prefix.split('__')
    return [segment for segment in parts[:-1] if segment], parts[-1]


def _normalize_lookup_path(path: str, method: str) -> str:
    normalized = path.strip()
    if method == 'order_by' and normalized.startswith('-'):
        return normalized[1:]
    return normalized


def _lookup_item_dict(
    field: FieldCandidate,
) -> dict[str, object]:
    return _lookup_path_item_dict(field.name, field)


def _lookup_path_item_dict(
    path_name: str,
    field: FieldCandidate,
) -> dict[str, object]:
    return {
        'name': path_name,
        'modelLabel': field.model_label,
        'relatedModelLabel': field.related_model_label,
        'filePath': field.file_path,
        'line': field.line,
        'column': field.column,
        'fieldKind': field.field_kind,
        'isRelation': field.is_relation,
        'fieldPath': path_name,
        'relationDirection': field.relation_direction,
        'source': field.source,
        'lookupOperator': None,
    }


def _lookup_descendant_completion_items(
    *,
    model_graph: ModelGraph,
    model_label: str,
    current_partial: str,
    relation_only: bool,
    method: str,
) -> list[dict[str, object]]:
    items = _one_hop_descendant_completion_items(
        model_graph=model_graph,
        model_label=model_label,
        relation_only=relation_only,
        method=method,
    )
    return [
        item
        for item in items
        if str(item['name']).startswith(current_partial)
    ]


def _one_hop_descendant_completion_items(
    *,
    model_graph: ModelGraph,
    model_label: str,
    relation_only: bool,
    method: str,
) -> tuple[dict[str, object], ...]:
    global _ONE_HOP_DESCENDANT_CACHE_OWNER

    owner = id(model_graph)
    if owner != _ONE_HOP_DESCENDANT_CACHE_OWNER:
        _ONE_HOP_DESCENDANT_CACHE.clear()
        _ONE_HOP_DESCENDANT_CACHE_OWNER = owner

    key = (model_label, method, relation_only)
    cached = _ONE_HOP_DESCENDANT_CACHE.get(key)
    if cached is not None:
        return cached

    items_by_name: dict[str, dict[str, object]] = {}
    for relation_field in _lookup_fields_for_method(
        model_graph=model_graph,
        model_label=model_label,
        method=method,
    ):
        if not relation_field.is_relation or not relation_field.related_model_label:
            continue

        for child_field in _lookup_fields_for_method(
            model_graph=model_graph,
            model_label=relation_field.related_model_label,
            method=method,
        ):
            if relation_only and not child_field.is_relation:
                continue

            path_name = f'{relation_field.name}__{child_field.name}'
            items_by_name.setdefault(
                path_name,
                _lookup_path_item_dict(path_name, child_field),
            )

    cached_items = tuple(
        cast(dict[str, object], items_by_name[name])
        for name in sorted(items_by_name)
    )
    _ONE_HOP_DESCENDANT_CACHE[key] = cached_items
    return cached_items


def _lookup_fields_for_method(
    *,
    model_graph: ModelGraph,
    model_label: str,
    method: str,
) -> list[FieldCandidate]:
    fields = model_graph.fields_for_model(model_label)
    if _allows_related_query_aliases(method):
        return [field for field in fields if not _is_hidden_lookup_field_name(field.name)]

    return [
        field
        for field in fields
        if field.source != 'related_query_alias'
        and not _is_hidden_lookup_field_name(field.name)
    ]


def _lookup_field_for_method(
    *,
    model_graph: ModelGraph,
    model_label: str,
    field_name: str,
    method: str,
) -> FieldCandidate | None:
    field = model_graph.find_field(model_label, field_name)
    if field is None:
        return None

    if not _allows_related_query_aliases(method) and field.source == 'related_query_alias':
        return None
    if _is_hidden_lookup_field_name(field.name):
        return None

    return field


def _allows_related_query_aliases(method: str) -> bool:
    return method not in ATTRIBUTE_PATH_METHODS


def _is_hidden_lookup_field_name(name: str) -> bool:
    return name.endswith('+')


def _prefixed_lookup_chain_completion_items(
    *,
    runtime: RuntimeInspection,
    fields: list[FieldCandidate],
) -> list[dict[str, object]]:
    items_by_name: dict[str, dict[str, object]] = {}

    for field in fields:
        for item in _lookup_chain_completion_items(
            runtime=runtime,
            field=field,
            current_partial='',
        ):
            prefixed_name = f"{field.name}__{item['name']}"
            prefixed_item = dict(item)
            prefixed_item['name'] = prefixed_name
            items_by_name.setdefault(prefixed_name, prefixed_item)

    return list(items_by_name.values())


def _lookup_completion_group(item: dict[str, object]) -> int:
    field_kind = item.get('fieldKind')
    if field_kind == 'lookup_operator' or field_kind == 'lookup_transform':
        return 1

    if '__' in str(item.get('name', '')):
        return 2

    return 0


def _lookup_operator_item_dict(
    *,
    owner_model_label: str,
    operator: str,
    field_path: str | None = None,
) -> dict[str, object]:
    return {
        'name': operator,
        'modelLabel': owner_model_label,
        'relatedModelLabel': None,
        'filePath': None,
        'line': None,
        'column': None,
        'fieldKind': 'lookup_operator',
        'isRelation': False,
        'fieldPath': field_path,
        'relationDirection': None,
        'source': 'django_lookup',
        'lookupOperator': operator,
    }


def _lookup_transform_item_dict(
    *,
    owner_model_label: str,
    transform: str,
    field_path: str | None = None,
) -> dict[str, object]:
    return {
        'name': transform,
        'modelLabel': owner_model_label,
        'relatedModelLabel': None,
        'filePath': None,
        'line': None,
        'column': None,
        'fieldKind': 'lookup_transform',
        'isRelation': False,
        'fieldPath': field_path,
        'relationDirection': None,
        'source': 'django_transform',
        'lookupOperator': None,
    }


def _lookup_chain_completion_items(
    *,
    runtime: RuntimeInspection,
    field: FieldCandidate,
    current_partial: str,
    field_path: str | None = None,
    runtime_field: object | None = None,
) -> list[dict[str, object]]:
    owner_model_label = field.model_label
    operator_field_path = field_path or field.name
    field_object = _runtime_lookup_field(
        runtime=runtime,
        field=field,
        runtime_field=runtime_field,
    )
    if field_object is None:
        return [
            _lookup_operator_item_dict(
                owner_model_label=owner_model_label,
                operator=operator,
                field_path=operator_field_path,
            )
            for operator in DEFAULT_LOOKUP_OPERATORS
            if operator.startswith(current_partial)
        ]

    items: dict[str, dict[str, object]] = {}
    for transform_name in _runtime_transform_names(field_object):
        if transform_name.startswith(current_partial):
            items[transform_name] = _lookup_transform_item_dict(
                owner_model_label=owner_model_label,
                transform=transform_name,
                field_path=operator_field_path,
            )

    for lookup_name in _runtime_lookup_names(field_object):
        if lookup_name.startswith(current_partial):
            items[lookup_name] = _lookup_operator_item_dict(
                owner_model_label=owner_model_label,
                operator=lookup_name,
                field_path=operator_field_path,
            )

    return list(items.values())


def _resolve_lookup_completion_chain(
    *,
    runtime: RuntimeInspection,
    field: FieldCandidate,
    segments: list[str],
) -> dict[str, object]:
    field_object = _runtime_lookup_field(
        runtime=runtime,
        field=field,
    )
    if field_object is None:
        if not segments:
            return {
                'resolved': True,
                'runtimeField': None,
            }
        return {
            'resolved': False,
            'reason': 'invalid_lookup_operator',
            'missingSegment': segments[0],
        }

    current_field_object = field_object
    for index, segment in enumerate(segments):
        transformed_field = _runtime_transform_output_field(current_field_object, segment)
        if transformed_field is not None:
            current_field_object = transformed_field
            continue

        if _runtime_lookup_exists(current_field_object, segment):
            return {
                'resolved': False,
                'reason': 'invalid_lookup_operator',
                'missingSegment': segment,
            }

        return {
            'resolved': False,
            'reason': 'invalid_lookup_operator',
            'missingSegment': segment,
        }

    return {
        'resolved': True,
        'runtimeField': current_field_object,
    }


def _resolve_lookup_chain(
    *,
    runtime: RuntimeInspection,
    field: FieldCandidate,
    segments: list[str],
) -> dict[str, object]:
    field_object = _runtime_lookup_field(
        runtime=runtime,
        field=field,
    )
    if field_object is None:
        if len(segments) == 1 and _is_lookup_operator(segments[0]):
            return {
                'resolved': True,
                'lookupOperator': segments[0],
            }
        return {
            'resolved': False,
            'reason': 'invalid_lookup_operator',
            'missingSegment': segments[0] if segments else None,
        }

    current_field_object = field_object
    lookup_operator: str | None = None
    for index, segment in enumerate(segments):
        transformed_field = _runtime_transform_output_field(current_field_object, segment)
        if transformed_field is not None:
            current_field_object = transformed_field
            continue

        if _runtime_lookup_exists(current_field_object, segment):
            if index != len(segments) - 1:
                return {
                    'resolved': False,
                    'reason': 'invalid_lookup_operator',
                    'missingSegment': segment,
                }
            lookup_operator = segment
            break

        return {
            'resolved': False,
            'reason': 'invalid_lookup_operator',
            'missingSegment': segment,
        }

    return {
        'resolved': True,
        'lookupOperator': lookup_operator,
    }


def _runtime_lookup_field(
    *,
    runtime: RuntimeInspection,
    field: FieldCandidate,
    runtime_field: object | None = None,
) -> object | None:
    if runtime_field is not None:
        return runtime_field

    if runtime.bootstrap_status != 'ready':
        return None

    return get_runtime_field(
        runtime.settings_module,
        model_label=field.model_label,
        field_name=field.name,
    )


def _runtime_lookup_names(field: object) -> list[str]:
    if not hasattr(field, 'get_lookups'):
        return []

    lookups = field.get_lookups()  # type: ignore[call-arg]
    if not isinstance(lookups, dict):
        return []

    names: list[str] = []
    for name in lookups:
        if _runtime_lookup_exists(field, str(name)):
            names.append(str(name))
    return sorted(set(names))


def _runtime_transform_names(field: object) -> list[str]:
    if not hasattr(field, 'get_lookups'):
        return []

    lookups = field.get_lookups()  # type: ignore[call-arg]
    if not isinstance(lookups, dict):
        return []

    names: list[str] = []
    for name in lookups:
        if _runtime_transform_output_field(field, str(name)) is not None:
            names.append(str(name))
    return sorted(set(names))


def _runtime_lookup_exists(field: object, lookup_name: str) -> bool:
    if not hasattr(field, 'get_lookup'):
        return False

    try:
        return field.get_lookup(lookup_name) is not None  # type: ignore[call-arg]
    except Exception:
        return False


def _runtime_transform_output_field(field: object, transform_name: str) -> object | None:
    if not hasattr(field, 'get_transform'):
        return None

    try:
        transform_class = field.get_transform(transform_name)  # type: ignore[call-arg]
    except Exception:
        return None

    if transform_class is None:
        return None

    try:
        transform = transform_class(_RuntimeLookupLhs(field))
    except Exception:
        return None

    try:
        return getattr(transform, 'output_field', None)
    except Exception:
        return None


class _RuntimeLookupLhs:
    def __init__(self, output_field: object) -> None:
        self.output_field = output_field


def _is_lookup_operator(segment: str) -> bool:
    return segment in DEFAULT_LOOKUP_OPERATORS
