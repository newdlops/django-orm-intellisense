from __future__ import annotations

from ..runtime.inspector import RuntimeInspection, RuntimeModelSummary
from ..static_index.indexer import FieldCandidate, StaticIndex

RELATION_ONLY_METHODS = {'select_related', 'prefetch_related'}
FILTER_LOOKUP_METHODS = {'filter', 'exclude', 'get'}
LOOKUP_OPERATORS = (
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


def list_lookup_path_completions(
    *,
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    base_model_label: str,
    prefix: str,
    method: str,
) -> dict[str, object]:
    normalized_prefix = _normalize_lookup_path(prefix, method)
    completed_segments, current_partial = _split_lookup_prefix(normalized_prefix)
    traversal = _analyze_lookup_completion_context(
        static_index=static_index,
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

    items: list[dict[str, object]]
    if traversal['completionMode'] == 'lookup_operator':
        items = [
            _lookup_operator_item_dict(
                owner_model_label=str(traversal['ownerModelLabel']),
                operator=operator,
            )
            for operator in LOOKUP_OPERATORS
            if operator.startswith(current_partial)
        ]
    else:
        current_model_label = str(traversal['currentModelLabel'])
        relation_only = method in RELATION_ONLY_METHODS
        items = [
            _lookup_item_dict(field)
            for field in _lookup_fields_for_model(
                static_index=static_index,
                runtime=runtime,
                model_label=current_model_label,
            )
            if (field.is_relation or not relation_only)
            and field.name.startswith(current_partial)
        ]

    items.sort(
        key=lambda item: (
            0 if item.get('isRelation') else 1,
            str(item['name']).lower(),
        )
    )
    return {
        'items': items,
        'resolved': True,
        'currentModelLabel': traversal.get('currentModelLabel'),
    }


def resolve_lookup_path(
    *,
    static_index: StaticIndex,
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
        field = _find_lookup_field(
            static_index=static_index,
            runtime=runtime,
            model_label=current_model_label,
            field_name=segment,
        )
        if field is None:
            if (
                method in FILTER_LOOKUP_METHODS
                and terminal_field is not None
                and not terminal_field.is_relation
                and _is_lookup_operator(segment)
                and index == len(segments) - 1
            ):
                lookup_operator = segment
                break
            if (
                method in FILTER_LOOKUP_METHODS
                and terminal_field is not None
                and not terminal_field.is_relation
                and index == len(segments) - 1
            ):
                return {
                    'resolved': False,
                    'reason': 'invalid_lookup_operator',
                    'resolvedSegments': resolved_segments,
                    'missingSegment': segment,
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

        if not field.is_relation or not field.related_model_label:
            next_segment = segments[index + 1]
            if (
                method in FILTER_LOOKUP_METHODS
                and not field.is_relation
                and _is_lookup_operator(next_segment)
                and index + 1 == len(segments) - 1
            ):
                lookup_operator = next_segment
                break
            if (
                method in FILTER_LOOKUP_METHODS
                and not field.is_relation
                and index + 1 == len(segments) - 1
            ):
                return {
                    'resolved': False,
                    'reason': 'invalid_lookup_operator',
                    'resolvedSegments': resolved_segments,
                    'missingSegment': next_segment,
                }
            return {
                'resolved': False,
                'reason': 'non_relation_intermediate',
                'resolvedSegments': resolved_segments,
                'missingSegment': segment,
            }

        current_model_label = field.related_model_label

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
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    base_model_label: str,
    segments: list[str],
    method: str,
) -> dict[str, object]:
    current_model_label = base_model_label
    last_field: FieldCandidate | None = None

    for segment in segments:
        field = _find_lookup_field(
            static_index=static_index,
            runtime=runtime,
            model_label=current_model_label,
            field_name=segment,
        )
        if field is None:
            return {
                'resolved': False,
                'reason': 'segment_not_found',
            }

        last_field = field

        if not field.is_relation or not field.related_model_label:
            return {
                'resolved': method in FILTER_LOOKUP_METHODS,
                'reason': None if method in FILTER_LOOKUP_METHODS else 'non_relation_intermediate',
                'completionMode': 'lookup_operator' if method in FILTER_LOOKUP_METHODS else None,
                'ownerModelLabel': field.model_label,
            }

        current_model_label = field.related_model_label

    if (
        last_field is not None
        and method in FILTER_LOOKUP_METHODS
        and not last_field.is_relation
    ):
        return {
            'resolved': True,
            'completionMode': 'lookup_operator',
            'ownerModelLabel': last_field.model_label,
        }

    return {
        'resolved': True,
        'currentModelLabel': current_model_label,
        'completionMode': 'field',
    }


def _lookup_fields_for_model(
    *,
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    model_label: str,
) -> list[FieldCandidate]:
    fields_by_name = {
        field.name: field
        for field in static_index.fields_for_model(model_label)
    }
    runtime_model = _runtime_model_summary(runtime, model_label)
    if runtime_model is None:
        return list(fields_by_name.values())

    model_candidate = static_index.find_model_candidate(model_label)
    fallback_file_path = model_candidate.file_path if model_candidate else ''
    fallback_line = model_candidate.line if model_candidate else 1
    fallback_column = model_candidate.column if model_candidate else 1

    for relation in runtime_model.relations:
        existing = fields_by_name.get(relation.name)
        if (
            existing is not None
            and existing.is_relation
            and existing.related_model_label == relation.related_model_label
        ):
            continue

        fields_by_name[relation.name] = FieldCandidate(
            model_label=model_label,
            name=relation.name,
            file_path=existing.file_path if existing is not None else fallback_file_path,
            line=existing.line if existing is not None else fallback_line,
            column=existing.column if existing is not None else fallback_column,
            field_kind=relation.field_kind,
            is_relation=True,
            relation_direction=relation.direction,
            related_model_label=relation.related_model_label,
            declared_model_label=existing.declared_model_label if existing is not None else model_label,
            related_name=existing.related_name if existing is not None else None,
            source='runtime',
        )

    return list(fields_by_name.values())


def _find_lookup_field(
    *,
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    model_label: str,
    field_name: str,
) -> FieldCandidate | None:
    for field in _lookup_fields_for_model(
        static_index=static_index,
        runtime=runtime,
        model_label=model_label,
    ):
        if field.name == field_name:
            return field

    return None


def _runtime_model_summary(
    runtime: RuntimeInspection,
    model_label: str,
) -> RuntimeModelSummary | None:
    for model in runtime.model_catalog:
        if model.label == model_label:
            return model

    return None


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


def _lookup_item_dict(field: FieldCandidate) -> dict[str, object]:
    return {
        'name': field.name,
        'modelLabel': field.model_label,
        'relatedModelLabel': field.related_model_label,
        'filePath': field.file_path,
        'line': field.line,
        'column': field.column,
        'fieldKind': field.field_kind,
        'isRelation': field.is_relation,
        'relationDirection': field.relation_direction,
        'source': field.source,
        'lookupOperator': None,
    }


def _lookup_operator_item_dict(
    *,
    owner_model_label: str,
    operator: str,
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
        'relationDirection': None,
        'source': 'django_lookup',
        'lookupOperator': operator,
    }


def _is_lookup_operator(segment: str) -> bool:
    return segment in LOOKUP_OPERATORS
