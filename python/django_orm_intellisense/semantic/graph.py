from __future__ import annotations

from dataclasses import dataclass

from ..discovery.workspace import WorkspaceProfile
from ..runtime.inspector import RuntimeInspection
from ..static_index.indexer import StaticIndex


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
