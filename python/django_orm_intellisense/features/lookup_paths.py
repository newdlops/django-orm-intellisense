from __future__ import annotations

import os
import sys
import time

from ..runtime.inspector import RuntimeInspection, get_runtime_field
from ..semantic.graph import ModelGraph
from ..static_index.indexer import FieldCandidate
from .field_types import (
    operand_python_type,
    python_type_for_kind,
    transform_output_kind,
)

# captain 옵션 6 관측 — daemon-side resolve_lookup_path 의 단계별 elapsed.
# 임계값 초과 시에만 단계 분해 로그 emit (정상 케이스 로그 noise 방지).
# 0 으로 설정 시 비활성.
_LOOKUP_PATH_SLOW_LOG_MS = int(
    os.environ.get('DJLS_LOOKUP_PATH_SLOW_LOG_MS', '500') or '500'
)

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
    # captain 옵션 6 — 단계별 elapsed 누적 후 임계 초과 시 한꺼번에 emit.
    _started_total = time.perf_counter()
    _stage_ms: dict[str, float] = {}
    _lookup_chain_calls = 0
    _lookup_chain_total_ms = 0.0

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

    def _maybe_log_slow() -> None:
        total_ms = (time.perf_counter() - _started_total) * 1000
        if total_ms < _LOOKUP_PATH_SLOW_LOG_MS:
            return
        stages = ','.join(
            f'{k}={v:.0f}ms' for k, v in sorted(_stage_ms.items())
        ) or 'none'
        chain_part = (
            f' chain_calls={_lookup_chain_calls} '
            f'chain_total={_lookup_chain_total_ms:.0f}ms'
            if _lookup_chain_calls
            else ''
        )
        print(
            f'[lookup-path:slow] {base_model_label} {path} method={method} '
            f'segments={len(segments)} total={total_ms:.0f}ms '
            f'stages=[{stages}]{chain_part}',
            file=sys.stderr,
            flush=True,
        )

    def _timed_lookup_field(
        *, model_label: str, field_name: str,
    ) -> FieldCandidate | None:
        nonlocal _stage_ms
        _t = time.perf_counter()
        result = _lookup_field_for_method(
            model_graph=model_graph,
            model_label=model_label,
            field_name=field_name,
            method=method,
        )
        elapsed = (time.perf_counter() - _t) * 1000
        _stage_ms['graph_find'] = _stage_ms.get('graph_find', 0.0) + elapsed
        return result

    def _timed_lookup_chain(
        *, field: FieldCandidate, segments: list[str],
    ) -> dict[str, object]:
        nonlocal _lookup_chain_calls, _lookup_chain_total_ms
        _t = time.perf_counter()
        result = _resolve_lookup_chain(
            runtime=runtime, field=field, segments=segments,
        )
        elapsed = (time.perf_counter() - _t) * 1000
        _lookup_chain_calls += 1
        _lookup_chain_total_ms += elapsed
        return result

    try:
        return _resolve_impl(
            base_model_label=base_model_label,
            path=path,
            method=method,
            segments=segments,
            current_model_label=current_model_label,
            resolved_segments=resolved_segments,
            terminal_field=terminal_field,
            lookup_operator=lookup_operator,
            timed_lookup_field=_timed_lookup_field,
            timed_lookup_chain=_timed_lookup_chain,
        )
    finally:
        _maybe_log_slow()


def _resolve_impl(
    *,
    base_model_label: str,
    path: str,
    method: str,
    segments: list[str],
    current_model_label: str,
    resolved_segments: list[dict[str, object]],
    terminal_field: FieldCandidate | None,
    lookup_operator: str | None,
    timed_lookup_field,
    timed_lookup_chain,
) -> dict[str, object]:
    # Output field kind after a trailing transform chain (e.g. IntegerField
    # for `pubdate__year`); None when no transform/lookup chain was walked.
    chain_output_field_kind: str | None = None
    chain_is_transformed = False
    for index, segment in enumerate(segments):
        field = timed_lookup_field(
            model_label=current_model_label,
            field_name=segment,
        )
        if field is None:
            if (
                method in FILTER_LOOKUP_METHODS
                and terminal_field is not None
            ):
                lookup_resolution = timed_lookup_chain(
                    field=terminal_field,
                    segments=segments[index:],
                )
                if lookup_resolution['resolved']:
                    lookup_operator = lookup_resolution.get('lookupOperator')
                    chain_output_field_kind = lookup_resolution.get('outputFieldKind')
                    chain_is_transformed = bool(lookup_resolution.get('isTransformed'))
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
            next_field = timed_lookup_field(
                model_label=field.related_model_label,
                field_name=next_segment,
            )
            if next_field is not None:
                current_model_label = field.related_model_label
                continue

            if method in FILTER_LOOKUP_METHODS:
                lookup_resolution = timed_lookup_chain(
                    field=field,
                    segments=segments[index + 1:],
                )
                if lookup_resolution['resolved']:
                    lookup_operator = lookup_resolution.get('lookupOperator')
                    chain_output_field_kind = lookup_resolution.get('outputFieldKind')
                    chain_is_transformed = bool(lookup_resolution.get('isTransformed'))
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
                lookup_resolution = timed_lookup_chain(
                    field=field,
                    segments=segments[index + 1:],
                )
                if lookup_resolution['resolved']:
                    lookup_operator = lookup_resolution.get('lookupOperator')
                    chain_output_field_kind = lookup_resolution.get('outputFieldKind')
                    chain_is_transformed = bool(lookup_resolution.get('isTransformed'))
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

    target = _lookup_item_dict(terminal_field)
    terminal_type = _build_terminal_type(
        terminal_field=terminal_field,
        chain_output_field_kind=chain_output_field_kind,
        is_transformed=chain_is_transformed,
        lookup_operator=lookup_operator,
    )
    if terminal_type is not None:
        # Surface the inferred type on the target item too, so a client that
        # only reads `target` still sees the python type.
        target['outputFieldKind'] = terminal_type['outputFieldKind']
        target['pythonType'] = terminal_type['pythonType']

    return {
        'resolved': True,
        'target': target,
        'resolvedSegments': resolved_segments,
        'baseModelLabel': base_model_label,
        'lookupOperator': lookup_operator,
        'terminalType': terminal_type,
    }


def _build_terminal_type(
    *,
    terminal_field: FieldCandidate,
    chain_output_field_kind: str | None,
    is_transformed: bool,
    lookup_operator: str | None,
) -> dict[str, object] | None:
    """Build the terminal-type descriptor for a resolved chain. Returns None
    for relation terminals (their type is the related model, surfaced
    separately, not a scalar python type)."""
    if terminal_field.is_relation:
        return None

    output_field_kind = chain_output_field_kind or terminal_field.field_kind
    python_type = python_type_for_kind(output_field_kind)
    operand = (
        operand_python_type(lookup_operator, python_type)
        if lookup_operator
        else None
    )
    return {
        'outputFieldKind': output_field_kind,
        'pythonType': python_type,
        'isTransformed': is_transformed,
        'lookupOperator': lookup_operator,
        'operandPythonType': operand,
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
        # Runtime registry unavailable (not bootstrapped, or build still in
        # progress under the lock timeout). Fall back to the static transform
        # / lookup tables so built-in chains like `pubdate__year` still infer
        # a terminal type without the live Django runtime.
        return _resolve_lookup_chain_static(
            input_field_kind=field.field_kind,
            segments=segments,
        )

    current_field_object = field_object
    output_field_kind: str = field.field_kind
    is_transformed = False
    lookup_operator: str | None = None
    for index, segment in enumerate(segments):
        transformed_field = _runtime_transform_output_field(current_field_object, segment)
        if transformed_field is not None:
            current_field_object = transformed_field
            output_field_kind = type(transformed_field).__name__
            is_transformed = True
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
        'outputFieldKind': output_field_kind,
        'isTransformed': is_transformed,
    }


def _resolve_lookup_chain_static(
    *,
    input_field_kind: str,
    segments: list[str],
) -> dict[str, object]:
    """Resolve a trailing transform/lookup chain using the static
    FIELD_TRANSFORMS table and DEFAULT_LOOKUP_OPERATORS — no live runtime.

    Built-in transforms advance the output field kind (``pubdate__year`` ->
    IntegerField); a single terminal lookup operator may follow. Custom
    runtime lookups are out of scope here (the runtime path covers them)."""
    output_field_kind = input_field_kind
    is_transformed = False
    lookup_operator: str | None = None
    for index, segment in enumerate(segments):
        transformed_kind = transform_output_kind(segment, output_field_kind)
        if transformed_kind is not None:
            output_field_kind = transformed_kind
            is_transformed = True
            continue

        if _is_lookup_operator(segment):
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
        'outputFieldKind': output_field_kind,
        'isTransformed': is_transformed,
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
