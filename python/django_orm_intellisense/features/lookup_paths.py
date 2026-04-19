from __future__ import annotations

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


def _resolve_lookup_chain(
    *,
    runtime: RuntimeInspection,
    field: FieldCandidate,
    segments: list[str],
) -> dict[str, object]:
    field_object = _runtime_lookup_field(runtime=runtime, field=field)
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
) -> object | None:
    if runtime.bootstrap_status != 'ready':
        return None

    return get_runtime_field(
        runtime.settings_module,
        model_label=field.model_label,
        field_name=field.name,
    )


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
