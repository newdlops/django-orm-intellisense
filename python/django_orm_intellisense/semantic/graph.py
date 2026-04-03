from __future__ import annotations

from dataclasses import dataclass

from ..discovery.workspace import WorkspaceProfile
from ..runtime.inspector import RuntimeInspection
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
    model_labels = {
        model.label
        for model in runtime.model_catalog
    }
    model_labels.update(
        candidate.label
        for candidate in static_index.concrete_model_candidates
    )

    fields_by_model_label: dict[str, dict[str, FieldCandidate]] = {}
    for model_label in model_labels:
        fields_by_name = {
            field.name: field
            for field in static_index.fields_for_model(model_label)
        }
        runtime_model = _runtime_model_summary(runtime, model_label)
        if runtime_model is not None:
            model_candidate = static_index.find_model_candidate(model_label)
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
                    source='runtime',
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
