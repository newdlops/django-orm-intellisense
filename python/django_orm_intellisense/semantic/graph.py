from __future__ import annotations

from collections import deque
from dataclasses import dataclass

from ..discovery.workspace import WorkspaceProfile
from ..runtime.inspector import (
    RuntimeInspection,
    RuntimeModelSummary,
    get_runtime_field,
)
from ..static_index.indexer import FieldCandidate, ModelCandidate, StaticIndex


@dataclass(frozen=True)
class ModelGraphNode:
    label: str
    app_label: str
    object_name: str
    module: str
    import_path: str
    file_path: str | None
    line: int | None
    column: int | None
    field_names: tuple[str, ...]
    relation_names: tuple[str, ...]
    reverse_relation_names: tuple[str, ...]
    manager_names: tuple[str, ...]
    model_candidate: ModelCandidate | None
    runtime_model: RuntimeModelSummary | None


@dataclass(frozen=True)
class ModelGraphEdge:
    source_label: str
    target_label: str
    direction: str
    field_names: tuple[str, ...]
    field_kinds: tuple[str, ...]


@dataclass(frozen=True)
class ModelGraph:
    fields_by_model_label: dict[str, dict[str, FieldCandidate]]
    nodes_by_label: dict[str, ModelGraphNode]
    nodes_by_object_name: dict[str, tuple[ModelGraphNode, ...]]
    node_by_import_path: dict[str, ModelGraphNode]
    edges_by_source_label: dict[str, tuple[ModelGraphEdge, ...]]

    def fields_for_model(self, model_label: str) -> list[FieldCandidate]:
        return list(self.fields_by_model_label.get(model_label, {}).values())

    def find_field(
        self,
        model_label: str,
        field_name: str,
    ) -> FieldCandidate | None:
        return self.fields_by_model_label.get(model_label, {}).get(field_name)

    def node_for_model(self, model_label: str) -> ModelGraphNode | None:
        return self.nodes_by_label.get(model_label)

    def nodes_for_object_name(self, object_name: str) -> list[ModelGraphNode]:
        return list(self.nodes_by_object_name.get(object_name, ()))

    def unique_node_for_object_name(self, object_name: str) -> ModelGraphNode | None:
        nodes = self.nodes_by_object_name.get(object_name, ())
        if len(nodes) != 1:
            return None

        return nodes[0]

    def node_for_import_path(self, import_path: str) -> ModelGraphNode | None:
        return self.node_by_import_path.get(import_path)

    def edges_for_model(
        self,
        model_label: str,
        *,
        direction: str | None = None,
    ) -> list[ModelGraphEdge]:
        edges = self.edges_by_source_label.get(model_label, ())
        if direction is None:
            return list(edges)

        return [edge for edge in edges if edge.direction == direction]

    def adjacent_model_labels(
        self,
        model_label: str,
        *,
        include_reverse: bool = True,
    ) -> list[str]:
        adjacent: list[str] = []
        seen: set[str] = set()
        for edge in self.edges_by_source_label.get(model_label, ()):
            if edge.direction == 'reverse' and not include_reverse:
                continue
            if edge.target_label in seen:
                continue
            seen.add(edge.target_label)
            adjacent.append(edge.target_label)

        return adjacent

    def bfs_labels(
        self,
        root_model_label: str,
        *,
        include_reverse: bool = True,
    ) -> list[str]:
        if root_model_label not in self.nodes_by_label:
            return []

        ordered_labels: list[str] = []
        queue: deque[str] = deque([root_model_label])
        visited = {root_model_label}

        while queue:
            current_label = queue.popleft()
            ordered_labels.append(current_label)
            for adjacent_label in self.adjacent_model_labels(
                current_label,
                include_reverse=include_reverse,
            ):
                if adjacent_label in visited:
                    continue
                visited.add(adjacent_label)
                queue.append(adjacent_label)

        return ordered_labels

    def bfs(
        self,
        root_model_label: str,
        *,
        include_reverse: bool = True,
    ) -> list[ModelGraphNode]:
        return [
            self.nodes_by_label[label]
            for label in self.bfs_labels(
                root_model_label,
                include_reverse=include_reverse,
            )
            if label in self.nodes_by_label
        ]


@dataclass(frozen=True)
class SemanticGraphSummary:
    coverage_mode: str
    module_count: int
    export_surface_count: int
    model_candidate_count: int
    runtime_model_count: int | None
    provenance_layers: list[str]

    def to_dict(self) -> dict[str, str | int | None | list[str]]:
        return {
            'coverageMode': self.coverage_mode,
            'moduleCount': self.module_count,
            'exportSurfaceCount': self.export_surface_count,
            'modelCandidateCount': self.model_candidate_count,
            'runtimeModelCount': self.runtime_model_count,
            'provenanceLayers': list(self.provenance_layers),
        }


def build_semantic_graph(
    workspace: WorkspaceProfile,
    static_index: StaticIndex,
    runtime: RuntimeInspection,
) -> SemanticGraphSummary:
    provenance_layers = ['static_source']

    if workspace.settings_module:
        provenance_layers.append('settings_discovery')

    if runtime.django_importable:
        provenance_layers.append('runtime_environment')

    if runtime.bootstrap_status == 'ready':
        provenance_layers.append('django_runtime_meta')

    return SemanticGraphSummary(
        coverage_mode='hybrid_scaffold'
        if runtime.bootstrap_status == 'ready'
        else 'static_only_scaffold',
        module_count=static_index.python_file_count,
        export_surface_count=static_index.reexport_module_count,
        model_candidate_count=static_index.model_candidate_count,
        runtime_model_count=runtime.model_count,
        provenance_layers=provenance_layers,
    )


def build_model_graph(
    static_index: StaticIndex,
    runtime: RuntimeInspection,
) -> ModelGraph:
    (
        runtime_model_by_label,
        runtime_label_by_static_label,
        static_label_by_runtime_label,
    ) = _runtime_graph_maps(static_index, runtime)

    model_labels = set(runtime_model_by_label)
    model_labels.update(
        runtime_label_by_static_label.get(candidate.label, candidate.label)
        for candidate in static_index.concrete_model_candidates
    )

    fields_by_model_label: dict[str, dict[str, FieldCandidate]] = {}
    static_source_labels: dict[str, str] = {}
    for model_label in model_labels:
        static_source_label = _resolve_static_source_label(
            model_label=model_label,
            static_index=static_index,
            static_label_by_runtime_label=static_label_by_runtime_label,
        )
        static_source_labels[model_label] = static_source_label

        fields_by_name = _build_fields_by_name(
            static_index=static_index,
            runtime=runtime,
            model_label=model_label,
            static_source_label=static_source_label,
            runtime_model_by_label=runtime_model_by_label,
            runtime_label_by_static_label=runtime_label_by_static_label,
        )

        if fields_by_name:
            fields_by_model_label[model_label] = fields_by_name

    nodes_by_label = {
        model_label: _build_model_graph_node(
            model_label=model_label,
            static_source_label=static_source_labels.get(model_label, model_label),
            fields_by_name=fields_by_model_label.get(model_label, {}),
            static_index=static_index,
            runtime_model=runtime_model_by_label.get(model_label),
        )
        for model_label in sorted(model_labels)
    }
    nodes_by_object_name = _index_nodes_by_object_name(nodes_by_label)
    node_by_import_path = {
        node.import_path: node
        for node in nodes_by_label.values()
        if node.import_path
    }
    edges_by_source_label = _build_edges_by_source_label(fields_by_model_label)

    return ModelGraph(
        fields_by_model_label=fields_by_model_label,
        nodes_by_label=nodes_by_label,
        nodes_by_object_name=nodes_by_object_name,
        node_by_import_path=node_by_import_path,
        edges_by_source_label=edges_by_source_label,
    )


def rebuild_model_graph_for_labels(
    current_graph: ModelGraph,
    *,
    old_static_index: StaticIndex,
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    affected_labels: set[str],
) -> ModelGraph:
    (
        runtime_model_by_label,
        runtime_label_by_static_label,
        static_label_by_runtime_label,
    ) = _runtime_graph_maps(static_index, runtime)
    (
        _old_runtime_model_by_label,
        old_runtime_label_by_static_label,
        _old_static_label_by_runtime_label,
    ) = _runtime_graph_maps(old_static_index, runtime)

    affected_graph_labels: set[str] = set()
    for label in affected_labels:
        affected_graph_labels.add(label)
        affected_graph_labels.add(runtime_label_by_static_label.get(label, label))
        affected_graph_labels.add(old_runtime_label_by_static_label.get(label, label))

    fields_by_model_label = dict(current_graph.fields_by_model_label)
    nodes_by_label = dict(current_graph.nodes_by_label)
    edges_by_source_label = dict(current_graph.edges_by_source_label)

    for model_label in affected_graph_labels:
        fields_by_model_label.pop(model_label, None)
        nodes_by_label.pop(model_label, None)
        edges_by_source_label.pop(model_label, None)

    for model_label in sorted(affected_graph_labels):
        static_source_label = _resolve_static_source_label(
            model_label=model_label,
            static_index=static_index,
            static_label_by_runtime_label=static_label_by_runtime_label,
        )
        runtime_model = runtime_model_by_label.get(model_label)
        if runtime_model is None and static_index.find_model_candidate(static_source_label) is None:
            continue

        fields_by_name = _build_fields_by_name(
            static_index=static_index,
            runtime=runtime,
            model_label=model_label,
            static_source_label=static_source_label,
            runtime_model_by_label=runtime_model_by_label,
            runtime_label_by_static_label=runtime_label_by_static_label,
        )
        if fields_by_name:
            fields_by_model_label[model_label] = fields_by_name

        nodes_by_label[model_label] = _build_model_graph_node(
            model_label=model_label,
            static_source_label=static_source_label,
            fields_by_name=fields_by_name,
            static_index=static_index,
            runtime_model=runtime_model,
        )

        rebuilt_edges = _build_edges_by_source_label({model_label: fields_by_name})
        if model_label in rebuilt_edges:
            edges_by_source_label[model_label] = rebuilt_edges[model_label]

    nodes_by_object_name = _index_nodes_by_object_name(nodes_by_label)
    node_by_import_path = {
        node.import_path: node
        for node in nodes_by_label.values()
        if node.import_path
    }

    return ModelGraph(
        fields_by_model_label=fields_by_model_label,
        nodes_by_label=nodes_by_label,
        nodes_by_object_name=nodes_by_object_name,
        node_by_import_path=node_by_import_path,
        edges_by_source_label=edges_by_source_label,
    )


def _build_model_graph_node(
    *,
    model_label: str,
    static_source_label: str,
    fields_by_name: dict[str, FieldCandidate],
    static_index: StaticIndex,
    runtime_model: RuntimeModelSummary | None,
) -> ModelGraphNode:
    model_candidate = static_index.find_model_candidate(model_label)
    if model_candidate is None and static_source_label != model_label:
        model_candidate = static_index.find_model_candidate(static_source_label)

    app_label = (
        model_candidate.app_label
        if model_candidate is not None
        else model_label.split('.', 1)[0]
    )
    object_name = (
        model_candidate.object_name
        if model_candidate is not None
        else _model_object_name(model_label)
    )
    module = (
        runtime_model.module
        if runtime_model is not None
        else model_candidate.module
        if model_candidate is not None
        else ''
    )
    import_path = f'{module}.{object_name}' if module else object_name

    derived_relation_names = [
        field.name
        for field in fields_by_name.values()
        if field.is_relation and field.relation_direction != 'reverse'
    ]
    derived_reverse_relation_names = [
        field.name
        for field in fields_by_name.values()
        if field.relation_direction == 'reverse'
    ]

    return ModelGraphNode(
        label=model_label,
        app_label=app_label,
        object_name=object_name,
        module=module,
        import_path=import_path,
        file_path=model_candidate.file_path if model_candidate is not None else None,
        line=model_candidate.line if model_candidate is not None else None,
        column=model_candidate.column if model_candidate is not None else None,
        field_names=tuple(fields_by_name.keys()),
        relation_names=_dedupe_names(
            runtime_model.relation_names if runtime_model is not None else (),
            derived_relation_names,
        ),
        reverse_relation_names=_dedupe_names(
            runtime_model.reverse_relation_names if runtime_model is not None else (),
            derived_reverse_relation_names,
        ),
        manager_names=tuple(runtime_model.manager_names) if runtime_model is not None else (),
        model_candidate=model_candidate,
        runtime_model=runtime_model,
    )


def _runtime_graph_maps(
    static_index: StaticIndex,
    runtime: RuntimeInspection,
) -> tuple[
    dict[str, RuntimeModelSummary],
    dict[str, str],
    dict[str, str],
]:
    runtime_model_by_label = {
        model.label: model
        for model in runtime.model_catalog
    }
    runtime_label_by_module_and_name = {
        (model.module, _model_object_name(model.label)): model.label
        for model in runtime.model_catalog
    }
    runtime_label_by_static_label = {
        candidate.label: runtime_label
        for candidate in static_index.concrete_model_candidates
        if (
            runtime_label := runtime_label_by_module_and_name.get(
                (candidate.module, candidate.object_name)
            )
        )
    }
    static_label_by_runtime_label = {
        runtime_label: static_label
        for static_label, runtime_label in runtime_label_by_static_label.items()
    }
    return (
        runtime_model_by_label,
        runtime_label_by_static_label,
        static_label_by_runtime_label,
    )


def _resolve_static_source_label(
    *,
    model_label: str,
    static_index: StaticIndex,
    static_label_by_runtime_label: dict[str, str],
) -> str:
    if static_index.find_model_candidate(model_label) is not None:
        return model_label
    return static_label_by_runtime_label.get(model_label, model_label)


def _build_fields_by_name(
    *,
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    model_label: str,
    static_source_label: str,
    runtime_model_by_label: dict[str, RuntimeModelSummary],
    runtime_label_by_static_label: dict[str, str],
) -> dict[str, FieldCandidate]:
    fields_by_name = {
        field.name: _remap_field_candidate_labels(
            field,
            target_model_label=model_label,
            runtime_label_by_static_label=runtime_label_by_static_label,
        )
        for field in static_index.fields_for_model(static_source_label)
    }
    runtime_model = runtime_model_by_label.get(model_label)
    if runtime_model is not None:
        model_candidate = static_index.find_model_candidate(model_label)
        if model_candidate is None and static_source_label != model_label:
            model_candidate = static_index.find_model_candidate(static_source_label)
        fallback_file_path = model_candidate.file_path if model_candidate else ''
        fallback_line = model_candidate.line if model_candidate else 1
        fallback_column = model_candidate.column if model_candidate else 1

        for runtime_field in runtime_model.fields:
            existing = fields_by_name.get(runtime_field.name)
            if (
                existing is not None
                and existing.is_relation == runtime_field.is_relation
                and existing.related_model_label == runtime_field.related_model_label
                and existing.field_kind == runtime_field.field_kind
            ):
                continue

            fields_by_name[runtime_field.name] = FieldCandidate(
                model_label=model_label,
                name=runtime_field.name,
                file_path=existing.file_path if existing is not None else fallback_file_path,
                line=existing.line if existing is not None else fallback_line,
                column=existing.column if existing is not None else fallback_column,
                field_kind=runtime_field.field_kind,
                is_relation=runtime_field.is_relation,
                relation_direction=runtime_field.direction,
                related_model_label=runtime_field.related_model_label,
                declared_model_label=existing.declared_model_label if existing is not None else model_label,
                related_name=existing.related_name if existing is not None else None,
                related_query_name=existing.related_query_name if existing is not None else None,
                source='runtime',
            )

    _add_related_query_alias_fields(fields_by_name=fields_by_name)
    if runtime.bootstrap_status == 'ready':
        _add_primary_key_alias_field(
            runtime=runtime,
            model_label=model_label,
            fields_by_name=fields_by_name,
        )
        _add_relation_attname_alias_fields(
            runtime=runtime,
            model_label=model_label,
            fields_by_name=fields_by_name,
        )
    return fields_by_name


def _index_nodes_by_object_name(
    nodes_by_label: dict[str, ModelGraphNode],
) -> dict[str, tuple[ModelGraphNode, ...]]:
    nodes_by_object_name: dict[str, list[ModelGraphNode]] = {}
    for node in nodes_by_label.values():
        nodes_by_object_name.setdefault(node.object_name, []).append(node)

    return {
        object_name: tuple(
            sorted(nodes, key=lambda node: node.label)
        )
        for object_name, nodes in nodes_by_object_name.items()
    }


def _build_edges_by_source_label(
    fields_by_model_label: dict[str, dict[str, FieldCandidate]],
) -> dict[str, tuple[ModelGraphEdge, ...]]:
    aggregated_edges: dict[
        str,
        dict[tuple[str, str], dict[str, set[str]]],
    ] = {}

    for source_label, fields_by_name in fields_by_model_label.items():
        for field in fields_by_name.values():
            if not field.is_relation or not field.related_model_label:
                continue

            direction = field.relation_direction or 'forward'
            target_label = field.related_model_label
            payload = aggregated_edges.setdefault(source_label, {}).setdefault(
                (target_label, direction),
                {
                    'field_names': set(),
                    'field_kinds': set(),
                },
            )
            payload['field_names'].add(field.name)
            payload['field_kinds'].add(field.field_kind)

    edges_by_source_label: dict[str, tuple[ModelGraphEdge, ...]] = {}
    for source_label, edge_map in aggregated_edges.items():
        edges = [
            ModelGraphEdge(
                source_label=source_label,
                target_label=target_label,
                direction=direction,
                field_names=tuple(sorted(payload['field_names'])),
                field_kinds=tuple(sorted(payload['field_kinds'])),
            )
            for (target_label, direction), payload in edge_map.items()
        ]
        edges.sort(
            key=lambda edge: (
                0 if edge.direction == 'forward' else 1,
                edge.target_label,
                edge.field_names[0] if edge.field_names else '',
            )
        )
        edges_by_source_label[source_label] = tuple(edges)

    return edges_by_source_label


def _dedupe_names(*name_groups: list[str] | tuple[str, ...]) -> tuple[str, ...]:
    seen: set[str] = set()
    ordered_names: list[str] = []
    for name_group in name_groups:
        for name in name_group:
            if name in seen:
                continue
            seen.add(name)
            ordered_names.append(name)

    return tuple(ordered_names)


def _remap_field_candidate_labels(
    field: FieldCandidate,
    *,
    target_model_label: str,
    runtime_label_by_static_label: dict[str, str],
) -> FieldCandidate:
    return FieldCandidate(
        model_label=target_model_label,
        name=field.name,
        file_path=field.file_path,
        line=field.line,
        column=field.column,
        field_kind=field.field_kind,
        is_relation=field.is_relation,
        relation_direction=field.relation_direction,
        related_model_label=(
            runtime_label_by_static_label.get(field.related_model_label, field.related_model_label)
            if field.related_model_label is not None
            else None
        ),
        declared_model_label=(
            runtime_label_by_static_label.get(field.declared_model_label, field.declared_model_label)
            if field.declared_model_label is not None
            else None
        ),
        related_name=field.related_name,
        related_query_name=field.related_query_name,
        source=field.source,
    )


def _model_object_name(model_label: str) -> str:
    return model_label.split('.', 1)[1]


def _add_primary_key_alias_field(
    *,
    runtime: RuntimeInspection,
    model_label: str,
    fields_by_name: dict[str, FieldCandidate],
) -> None:
    if 'pk' in fields_by_name:
        return

    runtime_pk_field = get_runtime_field(
        runtime.settings_module,
        model_label=model_label,
        field_name='pk',
    )
    if runtime_pk_field is None:
        return

    runtime_pk_field_name = getattr(runtime_pk_field, 'name', None)
    if not runtime_pk_field_name:
        return

    source_field = fields_by_name.get(str(runtime_pk_field_name))
    if source_field is None:
        return

    fields_by_name['pk'] = FieldCandidate(
        model_label=source_field.model_label,
        name='pk',
        file_path=source_field.file_path,
        line=source_field.line,
        column=source_field.column,
        field_kind=source_field.field_kind,
        is_relation=source_field.is_relation,
        relation_direction=source_field.relation_direction,
        related_model_label=source_field.related_model_label,
        declared_model_label=source_field.declared_model_label,
        related_name=source_field.related_name,
        related_query_name=source_field.related_query_name,
        source='runtime',
    )


def _add_relation_attname_alias_fields(
    *,
    runtime: RuntimeInspection,
    model_label: str,
    fields_by_name: dict[str, FieldCandidate],
) -> None:
    for field in list(fields_by_name.values()):
        if not _supports_relation_attname_alias(field):
            continue

        runtime_relation_field = get_runtime_field(
            runtime.settings_module,
            model_label=model_label,
            field_name=field.name,
        )
        alias_name = _relation_attname_alias_name(field, runtime_relation_field)
        if not alias_name or alias_name in fields_by_name:
            continue

        runtime_attname_field = get_runtime_field(
            runtime.settings_module,
            model_label=model_label,
            field_name=alias_name,
        )
        alias_field_kind = _runtime_attname_field_kind(runtime_attname_field) or field.field_kind
        fields_by_name[alias_name] = FieldCandidate(
            model_label=field.model_label,
            name=alias_name,
            file_path=field.file_path,
            line=field.line,
            column=field.column,
            field_kind=alias_field_kind,
            is_relation=False,
            relation_direction=None,
            related_model_label=None,
            declared_model_label=field.declared_model_label,
            related_name=field.related_name,
            related_query_name=field.related_query_name,
            source='runtime' if runtime_attname_field is not None else field.source,
        )


def _add_related_query_alias_fields(
    *,
    fields_by_name: dict[str, FieldCandidate],
) -> None:
    for field in list(fields_by_name.values()):
        if field.relation_direction != 'reverse':
            continue

        query_name = field.related_query_name
        if not query_name or query_name == field.name or query_name in fields_by_name:
            continue

        fields_by_name[query_name] = FieldCandidate(
            model_label=field.model_label,
            name=query_name,
            file_path=field.file_path,
            line=field.line,
            column=field.column,
            field_kind=field.field_kind,
            is_relation=field.is_relation,
            relation_direction=field.relation_direction,
            related_model_label=field.related_model_label,
            declared_model_label=field.declared_model_label,
            related_name=field.related_name,
            related_query_name=field.related_query_name,
            source='related_query_alias',
        )


def _supports_relation_attname_alias(field: FieldCandidate) -> bool:
    return (
        field.is_relation
        and field.relation_direction == 'forward'
        and field.field_kind in {'ForeignKey', 'OneToOneField', 'ParentalKey'}
    )


def _relation_attname_alias_name(
    field: FieldCandidate,
    runtime_relation_field: object | None,
) -> str | None:
    attname = getattr(runtime_relation_field, 'attname', None)
    if isinstance(attname, str) and attname and attname != field.name:
        return attname

    return f'{field.name}_id'


def _runtime_attname_field_kind(runtime_attname_field: object | None) -> str | None:
    if runtime_attname_field is None:
        return None

    return runtime_attname_field.__class__.__name__
