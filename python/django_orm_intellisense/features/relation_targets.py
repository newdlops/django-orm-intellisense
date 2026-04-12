from __future__ import annotations

from ..semantic.graph import ModelGraph, ModelGraphNode


def list_relation_targets(
    *,
    model_graph: ModelGraph,
    prefix: str | None = None,
) -> list[dict[str, object]]:
    normalized_prefix = (prefix or '').strip().lower()
    values = [
        _target_dict(model_graph, node)
        for node in model_graph.nodes_by_label.values()
    ]
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
    model_graph: ModelGraph,
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

    exact_label_match = model_graph.node_for_model(normalized_value)
    if exact_label_match is not None:
        return {
            'resolved': True,
            'matchKind': 'exact_label',
            'target': _target_dict(model_graph, exact_label_match),
        }

    exact_import_path_match = model_graph.node_for_import_path(normalized_value)
    if exact_import_path_match is not None:
        return {
            'resolved': True,
            'matchKind': 'exact_import_path',
            'target': _target_dict(model_graph, exact_import_path_match),
        }

    if '.' not in normalized_value:
        by_object_name = model_graph.nodes_for_object_name(normalized_value)
        if len(by_object_name) == 1:
            return {
                'resolved': True,
                'matchKind': 'unique_object_name',
                'target': _target_dict(model_graph, by_object_name[0]),
            }

        if len(by_object_name) > 1:
            return {
                'resolved': False,
                'reason': 'ambiguous_object_name',
                'candidates': [
                    _target_dict(model_graph, node)
                    for node in by_object_name
                ],
            }

    return {
        'resolved': False,
        'reason': 'not_found',
    }


def _target_dict(
    model_graph: ModelGraph,
    node: ModelGraphNode,
) -> dict[str, object]:
    field_names: list[str]
    if node.runtime_model is not None:
        field_names = list(node.runtime_model.field_names)
    else:
        field_names = [
            field.name
            for field in model_graph.fields_for_model(node.label)
            if field.relation_direction != 'reverse'
        ]

    source = (
        'runtime'
        if node.runtime_model is not None
        else node.model_candidate.source
        if node.model_candidate is not None
        else 'static'
    )

    return {
        'appLabel': node.app_label,
        'objectName': node.object_name,
        'label': node.label,
        'module': node.module,
        'importPath': node.import_path,
        'source': source,
        'fieldNames': field_names,
        'relationNames': list(node.relation_names),
        'reverseRelationNames': list(node.reverse_relation_names),
        'managerNames': list(node.manager_names),
        'filePath': node.file_path,
        'line': node.line,
        'column': node.column,
    }


def _matches_prefix(target: dict[str, object], normalized_prefix: str) -> bool:
    return (
        str(target['label']).lower().startswith(normalized_prefix)
        or str(target['objectName']).lower().startswith(normalized_prefix)
        or str(target['module']).lower().startswith(normalized_prefix)
        or str(target.get('importPath') or '').lower().startswith(normalized_prefix)
    )
