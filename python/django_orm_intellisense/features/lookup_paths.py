from __future__ import annotations

import os
import ast
import re
import sys
import time

from ..runtime.inspector import RuntimeInspection, get_runtime_field, runtime_field_registry_is_ready
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
FILTER_LOOKUP_METHODS = {'filter', 'exclude', 'get', 'get_or_create', 'update_or_create',
                         'aget', 'aget_or_create', 'aupdate_or_create'}
TRANSFORM_PATH_METHODS = FILTER_LOOKUP_METHODS | {
    'values', 'values_list', 'order_by', 'distinct', 'dates', 'datetimes',
    'earliest', 'latest', 'aearliest', 'alatest', 'f_expression',
}


def _supports_transforms(method: str) -> bool:
    return method in TRANSFORM_PATH_METHODS or method.startswith('expression_path:')
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
)


def resolve_lookup_path(
    *,
    model_graph: ModelGraph,
    runtime: RuntimeInspection,
    base_model_label: str,
    path: str,
    method: str,
    use_initial_catalog: bool = False,
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
            runtime=runtime, field=field, segments=segments, method=method,
            use_initial_catalog=use_initial_catalog,
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
                _supports_transforms(method)
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

            if _supports_transforms(method):
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
            if _supports_transforms(method):
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
    if lookup_operator is not None and method not in FILTER_LOOKUP_METHODS:
        return {'resolved': False, 'reason': 'invalid_lookup_operator',
                'resolvedSegments': resolved_segments, 'missingSegment': lookup_operator}
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
    if not _field_allowed_for_method(field, method):
        return None

    return field


def _allows_related_query_aliases(method: str) -> bool:
    return method != 'prefetch_related'


def _field_allowed_for_method(field: FieldCandidate, method: str) -> bool:
    reverse = field.relation_direction == 'reverse'
    if method in {'only', 'defer'} and reverse:
        return not field.related_query_name or field.name == field.related_query_name
    if method not in RELATION_ONLY_METHODS:
        return True
    if not field.is_relation:
        return True
    kind = field.field_kind.removeprefix('reverse_')
    if method == 'select_related':
        if kind not in {'ForeignKey', 'ParentalKey', 'OneToOneField'} or (reverse and kind != 'OneToOneField'):
            return False
        return not reverse or not field.related_query_name or field.name == field.related_query_name
    return not reverse or not field.related_name or field.name == field.related_name


def _is_hidden_lookup_field_name(name: str) -> bool:
    return name.endswith('+')


def _resolve_lookup_chain(
    *,
    runtime: RuntimeInspection,
    field: FieldCandidate,
    segments: list[str],
    method: str = 'filter',
    use_initial_catalog: bool = False,
) -> dict[str, object]:
    captured = _resolve_lookup_chain_catalog(
        runtime, field, segments, method, use_initial_catalog=use_initial_catalog,
    )
    if captured is not None:
        return captured
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

    current_field_object = _runtime_lookup_expression(field_object)
    output_field_kind = (
        field.field_kind if not field.is_relation and getattr(field_object, 'is_relation', False)
        else type(current_field_object.output_field).__name__
    )
    is_transformed = False
    lookup_operator: str | None = None
    for index, segment in enumerate(segments):
        if method in FILTER_LOOKUP_METHODS and index == len(segments) - 1 and _runtime_lookup_exists(current_field_object, segment):
            lookup_operator = segment
            break

        transformed = _runtime_transform_expression(current_field_object, segment)
        if transformed is not None:
            current_field_object = transformed
            output_field_kind = type(transformed.output_field).__name__
            is_transformed = True
            continue

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


def _resolve_lookup_chain_catalog(runtime, field, segments, method, *, use_initial_catalog=False):
    """Use a fresh model chunk or an unchanged initial snapshot during warmup."""
    catalog = runtime.lookup_catalog
    type_id = catalog.get('expressionFields', {}).get(field.model_label, {}).get(field.name)
    if type_id is None:
        type_id = catalog.get('fields', {}).get(field.model_label, {}).get(field.name)
    if not isinstance(type_id, str):
        return None
    lookup_type_id = catalog.get('fields', {}).get(field.model_label, {}).get(field.name, type_id)
    if not type_id.startswith('model:'):
        if not (
            use_initial_catalog
            and runtime.bootstrap_status == 'ready'
            and field.source in {'runtime', 'static', 'static_inheritance', 'related_query_alias'}
            and not runtime_field_registry_is_ready(runtime.settings_module)
        ):
            return None
        # Lookup dispatch retains the relation's registrations, including for
        # its scalar attname. expressionFields describes the SQL value instead.
        type_id = lookup_type_id
    else:
        lookup_descriptor = catalog.get('types', {}).get(lookup_type_id) or {}
        if (getattr(field, 'is_relation', False)
                or lookup_descriptor.get('baseKind') in {'ForeignKey', 'OneToOneField', 'ManyToManyField'}):
            # Refreshed model chunks need the same relation/attname dispatch.
            type_id = lookup_type_id
    descriptor = catalog.get('types', {}).get(type_id)
    if descriptor is None:
        return None
    transformed = False
    lookup = None
    for position, segment in enumerate(segments):
        if method in FILTER_LOOKUP_METHODS and position == len(segments) - 1 and segment in descriptor['lookups']:
            lookup = segment
            break
        transforms = descriptor['transforms']
        output = transforms.get(segment)
        if segment in transforms and output is None:
            return None  # Uncaptured transform output still needs reflection.
        if segment not in transforms:
            dynamic = descriptor.get('dynamicTransform') or {}
            if segment not in dynamic.get('blockedNames', ()):
                if dynamic.get('kind') == 'key' or (dynamic.get('kind') in ('index', 'band') and re.fullmatch(r'[+-]?\d+', segment)):
                    output = dynamic.get('outputType')
                elif dynamic.get('kind') == 'index' and re.fullmatch(r'[+-]?\d+_[+-]?\d+', segment):
                    output = dynamic.get('sliceType')
        current = catalog['types'].get(output) if output is not None else None
        if current is None:
            if descriptor.get('runtimeTransforms') or descriptor.get('runtimeLookups'):
                return None
            return {'resolved': False, 'reason': 'invalid_lookup_operator', 'missingSegment': segment}
        descriptor = current
        transformed = True
    return {'resolved': True, 'lookupOperator': lookup,
        'outputFieldKind': descriptor['fieldKind'], 'isTransformed': transformed}


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

        if _is_lookup_operator(segment) or (output_field_kind == 'JSONField' and segment in {
            'contained_by', 'has_key', 'has_keys', 'has_any_keys',
        }):
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
    if runtime.bootstrap_status != 'ready' or runtime.detached:
        return None

    runtime_field = get_runtime_field(
        runtime.settings_module,
        model_label=field.model_label,
        field_name=field.name,
        for_lookup=True,
    )
    if field.source != 'static_edit' or field.is_relation or getattr(runtime_field, 'is_relation', False):
        return runtime_field
    from ..runtime.source_fields import field_from_source
    return field_from_source(field, runtime_field)


def _runtime_lookup_exists(field: object, lookup_name: str) -> bool:
    if not hasattr(field, 'get_lookup'):
        return False

    try:
        lookup = field.get_lookup(lookup_name)  # type: ignore[call-arg]
        if type(getattr(field, 'output_field', field)).__name__ == 'CompositePrimaryKey':
            return lookup is not None and getattr(lookup, 'allows_composite_expressions', False)
        return lookup is not None
    except Exception:
        return False


def _runtime_transform_expression(field: object, transform_name: str) -> object | None:
    if not hasattr(field, 'get_transform'):
        return None

    try:
        transform_class = field.get_transform(transform_name)  # type: ignore[call-arg]
    except Exception:
        return None

    if transform_class is None:
        return None

    try:
        transform = transform_class(field)
    except Exception:
        return None

    try:
        return transform if getattr(transform, 'output_field', None) is not None else None
    except Exception:
        return None


def _runtime_lookup_expression(field: object) -> object:
    from django.db.models.expressions import Col
    if getattr(field, 'many_to_many', False):
        paths = field.get_path_info()
        if paths:
            field = paths[-1].join_field
    target = field
    return Col('__djls__', target, getattr(target, 'output_field', target))


def list_lookup_path_completions(
    *, model_graph: ModelGraph, runtime: RuntimeInspection,
    base_model_label: str, prefix: str, method: str,
) -> dict[str, object]:
    """Runtime fallback for custom and parameterized transform continuations."""
    normalized = _normalize_lookup_path(prefix, method)
    parts = normalized.split('__')
    partial = parts.pop()
    label = base_model_label
    terminal = None
    expression = None
    transformed = False
    for segment in parts:
        field = None if transformed or (terminal and not terminal.is_relation) else _lookup_field_for_method(
            model_graph=model_graph, model_label=label, field_name=segment, method=method,
        )
        if field is not None:
            terminal = field
            runtime_field = _runtime_lookup_field(runtime=runtime, field=field)
            expression = _runtime_lookup_expression(runtime_field) if runtime_field is not None else None
            if field.is_relation and field.related_model_label:
                label = field.related_model_label
            continue
        if expression is None or not _supports_transforms(method):
            return {'items': [], 'resolved': False, 'reason': 'segment_not_found'}
        expression = _runtime_transform_expression(expression, segment)
        if expression is None:
            return {'items': [], 'resolved': False, 'reason': 'invalid_lookup_operator'}
        transformed = True

    items: dict[str, dict[str, object]] = {}

    def add_operations(lhs: object, owner: str, path: str, name_prefix: str = '') -> None:
        from django.db.models import Transform
        names = {**lhs.output_field.get_lookups(), **getattr(lhs, 'get_lookups', lambda: {})()}
        for name in sorted(names):
            transform = isinstance(names[name], type) and issubclass(names[name], Transform)
            if not transform and (method not in FILTER_LOOKUP_METHODS or lhs.get_lookup(name) is None):
                continue
            item_name = name_prefix + name
            if not item_name.lower().startswith(partial.lower()):
                continue
            items[item_name] = {
                'name': item_name, 'modelLabel': owner, 'fieldPath': path,
                'fieldKind': 'lookup_transform' if transform else 'lookup_operator',
                'isRelation': False, 'source': 'django_transform' if transform else 'django_lookup',
                'lookupOperator': None if transform else name,
            }

    if terminal is None or (terminal.is_relation and not transformed):
        for field in model_graph.fields_for_model(label):
            if _lookup_field_for_method(model_graph=model_graph, model_label=label,
                                        field_name=field.name, method=method) is None:
                continue
            if method in RELATION_ONLY_METHODS and not field.is_relation:
                continue
            if field.name.lower().startswith(partial.lower()):
                items[field.name] = _lookup_item_dict(field)
                if _supports_transforms(method) and (partial or not parts):
                    obj = _runtime_lookup_field(runtime=runtime, field=field)
                    if obj is not None:
                        add_operations(_runtime_lookup_expression(obj), label, field.name, field.name + '__')
    if terminal is not None and expression is not None and _supports_transforms(method):
        add_operations(expression, terminal.model_label, '__'.join(parts))
    return {'items': list(items.values()), 'resolved': True, 'currentModelLabel': label}


def _is_lookup_operator(segment: str) -> bool:
    return segment in DEFAULT_LOOKUP_OPERATORS
