from __future__ import annotations

from datetime import datetime

from ..discovery.workspace import WorkspaceProfile
from ..runtime.inspector import RuntimeInspection
from ..semantic.graph import SemanticGraphSummary
from ..static_index.indexer import StaticIndexSummary


def build_health_snapshot(
    *,
    workspace: WorkspaceProfile,
    static_index: StaticIndexSummary,
    runtime: RuntimeInspection,
    semantic_graph: SemanticGraphSummary,
    initialized_at: datetime,
) -> dict[str, object]:
    phase = _compute_phase(static_index, runtime)
    detail = _compute_detail(phase, static_index, runtime)
    capabilities = [
        'workspace.discovery',
        'static.index',
        'semantic.graph',
        'string.reference.placeholder',
        'reexport.origin.placeholder',
    ]

    if runtime.django_importable:
        capabilities.append('runtime.environment')

    return {
        'phase': phase,
        'detail': detail,
        'capabilities': capabilities,
        'workspaceRoot': workspace.root,
        'managePyPath': workspace.manage_py_path,
        'pythonPath': runtime.python_executable,
        'settingsModule': workspace.settings_module,
        'startedAt': initialized_at.isoformat(),
        'staticIndex': static_index.to_dict(),
        'runtime': {
            'djangoImportable': runtime.django_importable,
            'djangoVersion': runtime.django_version,
            'bootstrapStatus': runtime.bootstrap_status,
            'settingsModule': runtime.settings_module,
        },
        'semanticGraph': semantic_graph.to_dict(),
    }


def _compute_phase(
    static_index: StaticIndexSummary,
    runtime: RuntimeInspection,
) -> str:
    if static_index.python_file_count == 0:
        return 'degraded'

    if runtime.django_importable:
        return 'ready'

    return 'degraded'


def _compute_detail(
    phase: str,
    static_index: StaticIndexSummary,
    runtime: RuntimeInspection,
) -> str:
    if static_index.python_file_count == 0:
        return 'No Python files were discovered in the current workspace.'

    if phase == 'ready':
        return (
            'Architecture scaffold is active. Static indexing, re-export discovery, '
            'and runtime environment probing are wired, but full Django ORM semantics '
            'have not been implemented yet.'
        )

    return (
        'Architecture scaffold is active, but Django is not importable from the '
        f'selected interpreter ({runtime.python_executable}). Static-only analysis is available.'
    )
