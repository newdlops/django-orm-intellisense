from __future__ import annotations

from ..runtime.inspector import RuntimeInspection, RuntimeModelSummary
from ..static_index.indexer import ModelCandidate, StaticIndex


def list_relation_targets(
    *,
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    prefix: str | None = None,
) -> list[dict[str, object]]:
    normalized_prefix = (prefix or '').strip().lower()
    targets: dict[str, dict[str, object]] = {}

    for model in runtime.model_catalog:
        target = _runtime_target_dict(model, static_index)
        targets[target['label']] = target

    for model in static_index.model_candidates:
        targets.setdefault(model.label, _static_target_dict(model))

    values = list(targets.values())
    if normalized_prefix:
        values = [
            target
            for target in values
            if _matches_prefix(target, normalized_prefix)
        ]

    values.sort(
        key=lambda target: (
            0 if target['source'] == 'runtime' else 1,
            str(target['label']).lower(),
        )
    )
    return values


def resolve_relation_target(
    *,
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    value: str,
) -> dict[str, object]:
    normalized_value = value.strip()
    if not normalized_value:
        return {
            'resolved': False,
            'reason': 'empty',
        }

    if normalized_value == 'self':
        return {
            'resolved': False,
            'reason': 'self_requires_context',
        }

    runtime_targets = list_relation_targets(
        static_index=static_index,
        runtime=runtime,
        prefix='',
    )
    static_targets = [
        _static_target_dict(model) for model in static_index.model_candidates
    ]

    exact_runtime_match = next(
        (
            target
            for target in runtime_targets
            if target['label'] == normalized_value
        ),
        None,
    )
    if exact_runtime_match is not None:
        return {
            'resolved': True,
            'matchKind': 'exact_label',
            'target': exact_runtime_match,
        }

    exact_static_match = next(
        (
            target
            for target in static_targets
            if target['label'] == normalized_value
        ),
        None,
    )
    if exact_static_match is not None:
        return {
            'resolved': True,
            'matchKind': 'exact_label',
            'target': exact_static_match,
        }

    if '.' not in normalized_value:
        by_object_name = [
            target
            for target in runtime_targets
            if target['objectName'] == normalized_value
        ]
        if not by_object_name:
            by_object_name = [
                target
                for target in static_targets
                if target['objectName'] == normalized_value
            ]

        if len(by_object_name) == 1:
            return {
                'resolved': True,
                'matchKind': 'unique_object_name',
                'target': by_object_name[0],
            }

        if len(by_object_name) > 1:
            return {
                'resolved': False,
                'reason': 'ambiguous_object_name',
                'candidates': by_object_name,
            }

    return {
        'resolved': False,
        'reason': 'not_found',
    }


def _runtime_target_dict(
    model: RuntimeModelSummary,
    static_index: StaticIndex,
) -> dict[str, object]:
    app_label, object_name = model.label.split('.', 1)
    static_candidate = static_index.find_model_candidate(model.label)
    return {
        'appLabel': app_label,
        'objectName': object_name,
        'label': model.label,
        'module': model.module,
        'source': 'runtime',
        'fieldNames': list(model.field_names),
        'relationNames': list(model.relation_names),
        'reverseRelationNames': list(model.reverse_relation_names),
        'managerNames': list(model.manager_names),
        'filePath': static_candidate.file_path if static_candidate else None,
        'line': static_candidate.line if static_candidate else None,
        'column': static_candidate.column if static_candidate else None,
    }


def _static_target_dict(model: ModelCandidate) -> dict[str, object]:
    return {
        'appLabel': model.app_label,
        'objectName': model.object_name,
        'label': model.label,
        'module': model.module,
        'source': model.source,
        'fieldNames': [],
        'relationNames': [],
        'reverseRelationNames': [],
        'managerNames': [],
        'filePath': model.file_path,
        'line': model.line,
        'column': model.column,
    }


def _matches_prefix(target: dict[str, object], normalized_prefix: str) -> bool:
    return (
        str(target['label']).lower().startswith(normalized_prefix)
        or str(target['objectName']).lower().startswith(normalized_prefix)
        or str(target['module']).lower().startswith(normalized_prefix)
    )
