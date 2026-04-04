from __future__ import annotations

from datetime import datetime

from ..discovery.workspace import WorkspaceProfile
from ..pylance import PylanceStubGenerationSummary
from ..runtime.inspector import RuntimeInspection
from ..semantic.graph import SemanticGraphSummary
from ..static_index.indexer import StaticIndex


def build_health_snapshot(
    *,
    workspace: WorkspaceProfile,
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    semantic_graph: SemanticGraphSummary,
    pylance_stubs: PylanceStubGenerationSummary | None,
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

    if pylance_stubs is not None:
        capabilities.append('pylance.stubs')

    if runtime.bootstrap_status == 'ready':
        capabilities.extend(
            [
                'runtime.django_setup',
                'runtime.orm_metadata',
            ]
        )

    snapshot: dict[str, object] = {
        'phase': phase,
        'detail': detail,
        'capabilities': capabilities,
        'workspaceRoot': workspace.root,
        'managePyPath': workspace.manage_py_path,
        'pythonPath': runtime.python_executable,
        'settingsModule': workspace.settings_module,
        'settingsCandidates': list(workspace.settings_candidates),
        'startedAt': initialized_at.isoformat(),
        'staticIndex': static_index.to_dict(),
        'runtime': {
            'djangoImportable': runtime.django_importable,
            'djangoVersion': runtime.django_version,
            'bootstrapStatus': runtime.bootstrap_status,
            'settingsModule': runtime.settings_module,
            'bootstrapError': runtime.bootstrap_error,
            'appCount': runtime.app_count,
            'modelCount': runtime.model_count,
            'fieldCount': runtime.field_count,
            'relationCount': runtime.relation_count,
            'reverseRelationCount': runtime.reverse_relation_count,
            'managerCount': runtime.manager_count,
            'modelPreview': [model.to_dict() for model in runtime.model_preview],
        },
        'semanticGraph': semantic_graph.to_dict(),
    }

    if pylance_stubs is not None:
        snapshot['pylanceStubs'] = pylance_stubs.to_dict()

    return snapshot


def _compute_phase(
    static_index: StaticIndex,
    runtime: RuntimeInspection,
) -> str:
    if static_index.python_file_count == 0:
        return 'degraded'

    if runtime.bootstrap_status == 'ready':
        return 'ready'

    return 'degraded'


def _compute_detail(
    phase: str,
    static_index: StaticIndex,
    runtime: RuntimeInspection,
) -> str:
    if static_index.python_file_count == 0:
        return 'No Python files were discovered in the current workspace.'

    if runtime.bootstrap_status == 'ready':
        return (
            'Architecture scaffold is active. Static indexing, re-export discovery, '
            'and Django runtime metadata inspection are wired. The semantic layers are '
            'still summaries rather than full completion or navigation features.'
        )

    if runtime.bootstrap_status == 'setup_failed':
        return (
            'Django is importable, but `django.setup()` failed for the selected settings '
            f'module. {runtime.bootstrap_error or "No additional error details were captured."}'
        )

    if runtime.bootstrap_status == 'skipped_missing_settings':
        return (
            'Django is importable, but no unambiguous settings module was selected. '
            'Set `djangoOrmIntellisense.settingsModule` or use the settings-module picker '
            'to enable runtime ORM inspection.'
        )

    return (
        'Architecture scaffold is active, but Django is not importable from the '
        f'selected interpreter ({runtime.python_executable}). Static-only analysis is available.'
    )
