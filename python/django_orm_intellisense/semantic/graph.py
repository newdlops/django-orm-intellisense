from __future__ import annotations

from dataclasses import dataclass

from ..discovery.workspace import WorkspaceProfile
from ..runtime.inspector import RuntimeInspection, get_runtime_field
from ..static_index.indexer import FieldCandidate
from ..static_index.indexer import StaticIndex


@dataclass(frozen=True)
class ModelGraph:
    fields_by_model_label: dict[str, dict[str, FieldCandidate]]

    def fields_for_model(self, model_label: str) -> list[FieldCandidate]:
        return list(self.fields_by_model_label.get(model_label, {}).values())

    def find_field(
        self,
        model_label: str,
        field_name: str,
    ) -> FieldCandidate | None:
        return self.fields_by_model_label.get(model_label, {}).get(field_name)


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

    model_labels = set(runtime_model_by_label)
    model_labels.update(
        runtime_label_by_static_label.get(candidate.label, candidate.label)
        for candidate in static_index.concrete_model_candidates
    )

    fields_by_model_label: dict[str, dict[str, FieldCandidate]] = {}
    for model_label in model_labels:
        static_source_label = model_label
        if static_index.find_model_candidate(static_source_label) is None:
            static_source_label = static_label_by_runtime_label.get(
                model_label,
                model_label,
            )

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

        if fields_by_name:
            fields_by_model_label[model_label] = fields_by_name

    return ModelGraph(fields_by_model_label=fields_by_model_label)


def _runtime_model_summary(
    runtime: RuntimeInspection,
    model_label: str,
):
    for model in runtime.model_catalog:
        if model.label == model_label:
            return model

    return None


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
