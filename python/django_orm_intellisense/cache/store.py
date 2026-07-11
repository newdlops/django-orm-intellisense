from __future__ import annotations

import importlib.metadata
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path, PurePosixPath

from ..discovery.workspace import PythonSourceSnapshot
from ..runtime.inspector import RuntimeInspection
from ..runtime.inspector import RuntimeModelSummary
from ..semantic.graph import ModelGraph, ModelGraphEdge, ModelGraphNode
from ..static_index.indexer import ModuleIndex, StaticIndex, build_static_index
from ..static_index.indexer import FieldCandidate, ModelCandidate

# Bumped to 17: reverse relations are now registered under their query name
# (related_query_name) in addition to the instance accessor, so cached runtime
# inspections built before this change must be rebuilt to pick up the new names.
CACHE_SCHEMA_VERSION = 17
SOURCE_SNAPSHOT_CACHE_NAME = 'source-snapshot.json'
STATIC_INDEX_CACHE_NAME = 'static-index.json'
STATIC_INDEX_FULL_CACHE_NAME = 'static-index-full.json'
RUNTIME_CACHE_NAME = 'runtime-inspection.json'
MODEL_GRAPH_CACHE_NAME = 'model-graph.json'
SURFACE_INDEX_CACHE_NAME = 'surface-index.json'


def load_cached_source_snapshot(
    workspace_root: Path,
    *,
    extra_roots: list[Path] | None = None,
) -> PythonSourceSnapshot | None:
    payload = _read_cache_payload(
        _workspace_cache_dir(workspace_root) / SOURCE_SNAPSHOT_CACHE_NAME
    )
    if payload is None:
        return None

    metadata = payload.get('metadata')
    if not isinstance(metadata, dict):
        return None

    normalized_extra_roots = sorted(str(root) for root in (extra_roots or []))
    if (
        metadata.get('schemaVersion') != CACHE_SCHEMA_VERSION
        or metadata.get('workspaceRoot') != str(workspace_root)
        or metadata.get('extraRoots') != normalized_extra_roots
    ):
        return None

    cached_payload = payload.get('payload')
    if not isinstance(cached_payload, dict):
        return None

    try:
        return PythonSourceSnapshot.from_cache_dict(dict(cached_payload))
    except (KeyError, TypeError, ValueError):
        _unlink_quietly(
            _workspace_cache_dir(workspace_root) / SOURCE_SNAPSHOT_CACHE_NAME
        )
        return None


def save_source_snapshot(
    workspace_root: Path,
    source_snapshot: PythonSourceSnapshot,
    *,
    extra_roots: list[Path] | None = None,
) -> None:
    _write_cache_payload(
        _workspace_cache_dir(workspace_root) / SOURCE_SNAPSHOT_CACHE_NAME,
        {
            'metadata': {
                'schemaVersion': CACHE_SCHEMA_VERSION,
                'workspaceRoot': str(workspace_root),
                'rootTreeFingerprint': source_snapshot.fingerprint,
                'extraRoots': sorted(str(root) for root in (extra_roots or [])),
                'createdAt': datetime.now(timezone.utc).isoformat(),
            },
            'payload': source_snapshot.to_cache_dict(),
        },
    )


def load_cached_static_index(
    workspace_root: Path,
    source_snapshot: PythonSourceSnapshot,
) -> tuple[StaticIndex | None, str]:
    """Load a cached StaticIndex.

    Returns ``(static_index, hit_kind)`` where *hit_kind* is one of:
    ``'full'`` (exact fingerprint match, StaticIndex restored directly),
    ``'partial'`` (per-module reuse with incremental rebuild),
    or ``'miss'`` (no usable cache, static_index is None).
    """
    # --- Fast path: full StaticIndex restoration --------------------------
    full_result = _try_load_full_static_index(workspace_root, source_snapshot)
    if full_result is not None:
        return full_result, 'full'

    # --- Slow path: per-module reuse + incremental rebuild ----------------
    payload = _read_cache_payload(
        _workspace_cache_dir(workspace_root) / STATIC_INDEX_CACHE_NAME
    )
    if payload is None:
        return None, 'miss'

    metadata = payload.get('metadata')
    if not isinstance(metadata, dict):
        return None, 'miss'

    if (
        metadata.get('schemaVersion') != CACHE_SCHEMA_VERSION
        or metadata.get('workspaceRoot') != str(workspace_root)
    ):
        return None, 'miss'

    cached_payload = payload.get('payload')
    if not isinstance(cached_payload, dict):
        return None, 'miss'

    cached_directory_fingerprints = cached_payload.get('directoryFingerprints')
    cached_module_entries = cached_payload.get('moduleEntries')
    cached_unparseable_entries = cached_payload.get('unparseableEntries') or {}
    if not isinstance(cached_directory_fingerprints, dict) or not isinstance(
        cached_module_entries, dict
    ):
        return None, 'miss'
    if not isinstance(cached_unparseable_entries, dict):
        cached_unparseable_entries = {}

    try:
        reusable_module_indices = _load_reusable_module_indices(
            cached_module_entries=cached_module_entries,
            cached_directory_fingerprints=cached_directory_fingerprints,
            source_snapshot=source_snapshot,
        )
        reusable_unparseable_files = _load_reusable_unparseable_entries(
            cached_unparseable_entries=cached_unparseable_entries,
            cached_directory_fingerprints=cached_directory_fingerprints,
            source_snapshot=source_snapshot,
        )
    except (KeyError, TypeError, ValueError):
        _unlink_quietly(
            _workspace_cache_dir(workspace_root) / STATIC_INDEX_CACHE_NAME
        )
        return None, 'miss'

    if not reusable_module_indices and not reusable_unparseable_files:
        return None, 'miss'

    result = build_static_index(
        workspace_root,
        python_files=source_snapshot.files,
        cached_module_indices=reusable_module_indices,
        cached_unparseable_files=reusable_unparseable_files,
    )
    return result, 'partial'


def _try_load_full_static_index(
    workspace_root: Path,
    source_snapshot: PythonSourceSnapshot,
) -> StaticIndex | None:
    payload = _read_cache_payload(
        _workspace_cache_dir(workspace_root) / STATIC_INDEX_FULL_CACHE_NAME
    )
    if payload is None:
        return None

    metadata = payload.get('metadata')
    if not isinstance(metadata, dict):
        return None

    if (
        metadata.get('schemaVersion') != CACHE_SCHEMA_VERSION
        or metadata.get('workspaceRoot') != str(workspace_root)
        or metadata.get('rootTreeFingerprint') != source_snapshot.fingerprint
    ):
        return None

    cached_payload = payload.get('payload')
    if not isinstance(cached_payload, dict):
        return None

    try:
        cached_static_index = StaticIndex.from_cache_dict(dict(cached_payload))
    except (KeyError, TypeError, ValueError):
        _unlink_quietly(
            _workspace_cache_dir(workspace_root) / STATIC_INDEX_FULL_CACHE_NAME
        )
        return None

    # Completeness check: the cache must account for every file in the
    # current source snapshot. Without this, a cache that was saved while
    # one or more files temporarily failed to AST-parse would be trusted
    # forever — the rootTreeFingerprint matches the snapshot but a model
    # like `db.Company` is silently absent. Falling through to the partial
    # path forces a re-parse of any uncovered file. See
    # `StaticIndex.unparseable_files` / `shadowed_files`.
    expected_file_count = len(source_snapshot.entries)
    represented_count = (
        len(cached_static_index.modules)
        + len(cached_static_index.unparseable_files)
        + len(cached_static_index.shadowed_files)
    )
    if (
        cached_static_index.python_file_count != expected_file_count
        or represented_count != expected_file_count
    ):
        print(
            f'[cache] reject_full_static_index workspace={workspace_root.name} '
            f'snapshot_files={expected_file_count} '
            f'cache_python_file_count={cached_static_index.python_file_count} '
            f'cache_modules={len(cached_static_index.modules)} '
            f'cache_unparseable={len(cached_static_index.unparseable_files)} '
            f'cache_shadowed={len(cached_static_index.shadowed_files)} '
            f'reason=incomplete_or_count_mismatch',
            file=__import__('sys').stderr,
        )
        _unlink_quietly(
            _workspace_cache_dir(workspace_root) / STATIC_INDEX_FULL_CACHE_NAME
        )
        return None

    return cached_static_index


def save_static_index(
    workspace_root: Path,
    source_snapshot: PythonSourceSnapshot,
    static_index: StaticIndex,
) -> None:
    entry_by_path = source_snapshot.entries_by_path
    module_entries: dict[str, object] = {}
    for module_index in static_index.modules.values():
        try:
            relative_path = Path(module_index.file_path).relative_to(
                workspace_root
            ).as_posix()
        except ValueError:
            continue

        entry = entry_by_path.get(relative_path)
        if entry is None:
            continue

        module_entries[relative_path] = {
            'fileFingerprint': entry.fingerprint,
            'moduleIndex': module_index.to_dict(),
        }

    unparseable_entries: dict[str, object] = {}
    for relative_path, error_kind in static_index.unparseable_files.items():
        entry = entry_by_path.get(relative_path)
        if entry is None:
            continue
        unparseable_entries[relative_path] = {
            'fileFingerprint': entry.fingerprint,
            'errorKind': error_kind,
        }

    _write_cache_payload(
        _workspace_cache_dir(workspace_root) / STATIC_INDEX_CACHE_NAME,
        {
            'metadata': {
                'schemaVersion': CACHE_SCHEMA_VERSION,
                'workspaceRoot': str(workspace_root),
                'rootTreeFingerprint': source_snapshot.fingerprint,
                'createdAt': datetime.now(timezone.utc).isoformat(),
            },
            'payload': {
                'directoryFingerprints': source_snapshot.directory_fingerprints,
                'moduleEntries': module_entries,
                'unparseableEntries': unparseable_entries,
            },
        },
    )

    # Also save full StaticIndex for fast restoration on exact fingerprint match
    _write_cache_payload(
        _workspace_cache_dir(workspace_root) / STATIC_INDEX_FULL_CACHE_NAME,
        {
            'metadata': {
                'schemaVersion': CACHE_SCHEMA_VERSION,
                'workspaceRoot': str(workspace_root),
                'rootTreeFingerprint': source_snapshot.fingerprint,
                'createdAt': datetime.now(timezone.utc).isoformat(),
            },
            'payload': static_index.to_cache_dict(),
        },
    )


def load_cached_runtime_inspection(
    workspace_root: Path,
    source_fingerprint: str,
    settings_module: str | None,
) -> RuntimeInspection | None:
    payload = _read_cache_payload(
        _workspace_cache_dir(workspace_root) / RUNTIME_CACHE_NAME
    )
    if payload is None:
        return None

    metadata = payload.get('metadata')
    if not isinstance(metadata, dict):
        return None

    if (
        metadata.get('schemaVersion') != CACHE_SCHEMA_VERSION
        or metadata.get('workspaceRoot') != str(workspace_root)
        or metadata.get('sourceFingerprint') != source_fingerprint
        or metadata.get('settingsModule') != settings_module
        or metadata.get('environmentFingerprint') != _runtime_environment_fingerprint()
    ):
        return None

    cached_payload = payload.get('payload')
    if not isinstance(cached_payload, dict):
        return None

    try:
        runtime = RuntimeInspection.from_cache_dict(dict(cached_payload))
    except (KeyError, TypeError, ValueError):
        _unlink_quietly(
            _workspace_cache_dir(workspace_root) / RUNTIME_CACHE_NAME
        )
        return None

    # A failed django.setup() is often transient (an import race, a temporarily
    # unavailable environment variable, or a dependency that is still being
    # installed). Persisting that result pins the daemon to an empty runtime
    # catalog even after the project is healthy again. The static fallback then
    # has little to work with for dynamic/inherited models and completion
    # collapses to the synthetic ``id``/``pk`` fields until the user clears the
    # cache manually.
    #
    # Also reject internally inconsistent ``ready`` payloads. Older/partial
    # cache files can deserialize successfully while carrying fewer models or
    # fields than their counters advertise; treating them as hits produces the
    # same permanently truncated completion surface.
    if not _runtime_inspection_is_cacheable(runtime):
        _unlink_quietly(
            _workspace_cache_dir(workspace_root) / RUNTIME_CACHE_NAME
        )
        return None

    return runtime


def save_runtime_inspection(
    workspace_root: Path,
    source_fingerprint: str,
    settings_module: str | None,
    runtime: RuntimeInspection,
) -> None:
    cache_path = _workspace_cache_dir(workspace_root) / RUNTIME_CACHE_NAME
    if not _runtime_inspection_is_cacheable(runtime):
        # Remove a previous result for the same workspace as well. Its metadata
        # may happen to match this launch, and a later restart must retry the
        # runtime inspection instead of reviving stale/incomplete state.
        _unlink_quietly(cache_path)
        return

    _write_cache_payload(
        cache_path,
        {
            'metadata': {
                'schemaVersion': CACHE_SCHEMA_VERSION,
                'workspaceRoot': str(workspace_root),
                'sourceFingerprint': source_fingerprint,
                'settingsModule': settings_module,
                'environmentFingerprint': _runtime_environment_fingerprint(),
                'createdAt': datetime.now(timezone.utc).isoformat(),
            },
            'payload': runtime.to_cache_dict(),
        },
    )


def load_cached_model_graph(
    workspace_root: Path,
    source_fingerprint: str,
    runtime_fingerprint: str,
) -> ModelGraph | None:
    payload = _read_cache_payload(
        _workspace_cache_dir(workspace_root) / MODEL_GRAPH_CACHE_NAME
    )
    if payload is None:
        return None

    metadata = payload.get('metadata')
    if not isinstance(metadata, dict):
        return None

    if (
        metadata.get('schemaVersion') != CACHE_SCHEMA_VERSION
        or metadata.get('workspaceRoot') != str(workspace_root)
        or metadata.get('sourceFingerprint') != source_fingerprint
        or metadata.get('runtimeFingerprint') != runtime_fingerprint
    ):
        return None

    cached_payload = payload.get('payload')
    if not isinstance(cached_payload, dict):
        return None

    try:
        return _model_graph_from_cache_dict(cached_payload)
    except (KeyError, TypeError, ValueError):
        _unlink_quietly(
            _workspace_cache_dir(workspace_root) / MODEL_GRAPH_CACHE_NAME
        )
        return None


def save_model_graph(
    workspace_root: Path,
    source_fingerprint: str,
    runtime_fingerprint: str,
    model_graph: ModelGraph,
) -> None:
    _write_cache_payload(
        _workspace_cache_dir(workspace_root) / MODEL_GRAPH_CACHE_NAME,
        {
            'metadata': {
                'schemaVersion': CACHE_SCHEMA_VERSION,
                'workspaceRoot': str(workspace_root),
                'sourceFingerprint': source_fingerprint,
                'runtimeFingerprint': runtime_fingerprint,
                'createdAt': datetime.now(timezone.utc).isoformat(),
            },
            'payload': _model_graph_to_cache_dict(model_graph),
        },
    )


def load_cached_surface_index(
    workspace_root: Path,
    source_fingerprint: str,
    runtime_fingerprint: str,
    *,
    static_index: StaticIndex | None = None,
    model_graph: ModelGraph | None = None,
) -> dict[str, object] | None:
    payload = _read_cache_payload(
        _workspace_cache_dir(workspace_root) / SURFACE_INDEX_CACHE_NAME
    )
    if payload is None:
        return None

    metadata = payload.get('metadata')
    if not isinstance(metadata, dict):
        return None

    if (
        metadata.get('schemaVersion') != CACHE_SCHEMA_VERSION
        or metadata.get('workspaceRoot') != str(workspace_root)
        or metadata.get('sourceFingerprint') != source_fingerprint
        or metadata.get('runtimeFingerprint') != runtime_fingerprint
    ):
        return None

    cached_payload = payload.get('payload')
    if not isinstance(cached_payload, dict):
        return None

    surface_index = dict(cached_payload)
    cache_problem = _surface_index_cache_problem(
        surface_index,
        static_index=static_index,
        model_graph=model_graph,
    )
    if cache_problem is not None:
        print(
            f'[cache] reject_surface_index workspace={workspace_root.name} '
            f'reason={cache_problem}',
            file=sys.stderr,
        )
        _unlink_quietly(
            _workspace_cache_dir(workspace_root) / SURFACE_INDEX_CACHE_NAME
        )
        return None

    return surface_index


def save_surface_index(
    workspace_root: Path,
    source_fingerprint: str,
    runtime_fingerprint: str,
    surface_index: dict[str, object],
) -> None:
    _write_cache_payload(
        _workspace_cache_dir(workspace_root) / SURFACE_INDEX_CACHE_NAME,
        {
            'metadata': {
                'schemaVersion': CACHE_SCHEMA_VERSION,
                'workspaceRoot': str(workspace_root),
                'sourceFingerprint': source_fingerprint,
                'runtimeFingerprint': runtime_fingerprint,
                'createdAt': datetime.now(timezone.utc).isoformat(),
            },
            'payload': surface_index,
        },
    )


def _cache_root() -> Path:
    override = os.environ.get('DJANGO_ORM_INTELLISENSE_CACHE_DIR')
    if override:
        return Path(override).expanduser()

    return Path(tempfile.gettempdir()) / 'django-orm-intellisense'


def _workspace_cache_dir(workspace_root: Path) -> Path:
    workspace_hash = sha256(str(workspace_root).encode('utf-8')).hexdigest()[:16]
    workspace_name = workspace_root.name or 'workspace'
    safe_name = ''.join(
        character if character.isalnum() or character in {'-', '_'} else '-'
        for character in workspace_name
    ).strip('-') or 'workspace'
    return _cache_root() / f'{safe_name}-{workspace_hash}'


def _runtime_environment_fingerprint() -> str:
    django_version = 'missing'
    try:
        django_version = importlib.metadata.version('django')
    except importlib.metadata.PackageNotFoundError:
        django_version = 'missing'

    fingerprint_source = '\0'.join(
        [
            os.path.realpath(sys.executable),
            sys.version,
            sys.prefix,
            django_version,
        ]
    )
    return sha256(fingerprint_source.encode('utf-8')).hexdigest()


def _runtime_inspection_is_cacheable(runtime: RuntimeInspection) -> bool:
    """Return whether *runtime* is safe to reuse across daemon launches.

    ``setup_failed`` and ``warming_up`` are session states, not durable project
    facts. For a ready inspection, the summary counters form a cheap integrity
    check that catches successfully decoded but truncated catalogs.
    """
    if runtime.bootstrap_status in {'setup_failed', 'warming_up'}:
        return False
    if runtime.bootstrap_status != 'ready':
        return True

    if len(runtime.model_catalog) != runtime.model_count:
        return False
    if len({model.label for model in runtime.model_catalog}) != runtime.model_count:
        return False

    field_count = sum(len(model.field_names) for model in runtime.model_catalog)
    relation_count = sum(
        len(model.relation_names) for model in runtime.model_catalog
    )
    reverse_relation_count = sum(
        len(model.reverse_relation_names) for model in runtime.model_catalog
    )
    manager_count = sum(
        len(model.manager_names) for model in runtime.model_catalog
    )
    if (
        field_count != runtime.field_count
        or relation_count != runtime.relation_count
        or reverse_relation_count != runtime.reverse_relation_count
        or manager_count != runtime.manager_count
    ):
        return False

    for model in runtime.model_catalog:
        serialized_field_names = {field.name for field in model.fields}
        expected_field_names = {
            *model.field_names,
            *model.reverse_relation_names,
        }
        if not expected_field_names.issubset(serialized_field_names):
            return False

    return True


def _surface_index_cache_problem(
    surface_index: dict[str, object],
    *,
    static_index: StaticIndex | None,
    model_graph: ModelGraph | None,
) -> str | None:
    """Describe why a cached completion surface is incomplete, if known.

    Fingerprints protect against source changes, but they cannot identify a
    cache written by an older buggy/incomplete prebuild with the same metadata.
    Validate the cheap, user-visible contract: every concrete static model must
    have a surface entry, and every field known by the current graph/static
    index must appear in that entry's instance members.
    """
    if static_index is None:
        return None

    graph_node_by_module_and_name: dict[tuple[str, str], ModelGraphNode] = {}
    if model_graph is not None:
        for node in model_graph.nodes_by_label.values():
            if not node.module:
                continue
            # Mirror orm_members._build_static_to_graph_label_map: the first
            # graph node for a module/object pair is the canonical surface key.
            graph_node_by_module_and_name.setdefault(
                (node.module, node.object_name),
                node,
            )

    missing_models: list[str] = []
    missing_fields: list[str] = []
    for candidate in static_index.concrete_model_candidates:
        graph_node = graph_node_by_module_and_name.get(
            (candidate.module, candidate.object_name)
        )
        surface_label = graph_node.label if graph_node is not None else candidate.label
        model_entry = surface_index.get(surface_label)
        if not isinstance(model_entry, dict):
            missing_models.append(surface_label)
            continue

        expected_field_names = {
            field.name for field in static_index.fields_for_model(candidate.label)
        }
        if graph_node is not None:
            expected_field_names.update(graph_node.field_names)
        if not expected_field_names:
            continue

        instance_entry = model_entry.get('instance')
        cached_field_names = (
            set(instance_entry.keys())
            if isinstance(instance_entry, dict)
            else set()
        )
        absent = sorted(expected_field_names - cached_field_names)
        if absent:
            missing_fields.append(
                f'{surface_label}:[{",".join(absent[:8])}]'
            )

    if missing_models:
        sample = ','.join(sorted(set(missing_models))[:8])
        return f'missing_models count={len(set(missing_models))} sample={sample}'
    if missing_fields:
        sample = ','.join(missing_fields[:8])
        return f'missing_fields count={len(missing_fields)} sample={sample}'
    return None


def _read_cache_payload(cache_path: Path) -> dict[str, object] | None:
    try:
        raw_payload = cache_path.read_text(encoding='utf-8')
    except OSError:
        return None

    try:
        payload = json.loads(raw_payload)
    except json.JSONDecodeError:
        _unlink_quietly(cache_path)
        return None

    return payload if isinstance(payload, dict) else None


def _write_cache_payload(cache_path: Path, payload: dict[str, object]) -> None:
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = cache_path.with_suffix(f'{cache_path.suffix}.tmp')

    try:
        temporary_path.write_text(
            json.dumps(payload, sort_keys=True),
            encoding='utf-8',
        )
        temporary_path.replace(cache_path)
    except OSError:
        _unlink_quietly(temporary_path)


def _unlink_quietly(cache_path: Path) -> None:
    try:
        cache_path.unlink(missing_ok=True)
    except OSError:
        return


def _field_candidate_to_cache_dict(field: FieldCandidate) -> dict[str, object]:
    payload = field.to_dict()
    payload['declaredModelLabel'] = field.declared_model_label
    payload['relatedName'] = field.related_name
    payload['relatedQueryName'] = field.related_query_name
    return payload


def _field_candidate_from_cache_dict(payload: dict[str, object]) -> FieldCandidate:
    return FieldCandidate(
        model_label=str(payload['modelLabel']),
        name=str(payload['name']),
        file_path=str(payload['filePath']),
        line=int(payload['line']),
        column=int(payload['column']),
        field_kind=str(payload['fieldKind']),
        is_relation=bool(payload['isRelation']),
        relation_direction=_string_or_none(payload.get('relationDirection')),
        related_model_label=_string_or_none(payload.get('relatedModelLabel')),
        declared_model_label=_string_or_none(payload.get('declaredModelLabel')),
        related_name=_string_or_none(payload.get('relatedName')),
        related_query_name=_string_or_none(payload.get('relatedQueryName')),
        source=str(payload.get('source', 'static')),
    )


def _model_graph_to_cache_dict(model_graph: ModelGraph) -> dict[str, object]:
    return {
        'fieldsByModelLabel': {
            model_label: {
                field_name: _field_candidate_to_cache_dict(field)
                for field_name, field in fields_by_name.items()
            }
            for model_label, fields_by_name in model_graph.fields_by_model_label.items()
        },
        'nodesByLabel': {
            label: {
                'label': node.label,
                'appLabel': node.app_label,
                'objectName': node.object_name,
                'module': node.module,
                'importPath': node.import_path,
                'filePath': node.file_path,
                'line': node.line,
                'column': node.column,
                'fieldNames': list(node.field_names),
                'relationNames': list(node.relation_names),
                'reverseRelationNames': list(node.reverse_relation_names),
                'managerNames': list(node.manager_names),
                'modelCandidate': (
                    node.model_candidate.to_dict()
                    if node.model_candidate is not None
                    else None
                ),
                'runtimeModel': (
                    node.runtime_model.to_dict()
                    if node.runtime_model is not None
                    else None
                ),
            }
            for label, node in model_graph.nodes_by_label.items()
        },
        'edgesBySourceLabel': {
            source_label: [
                {
                    'sourceLabel': edge.source_label,
                    'targetLabel': edge.target_label,
                    'direction': edge.direction,
                    'fieldNames': list(edge.field_names),
                    'fieldKinds': list(edge.field_kinds),
                }
                for edge in edges
            ]
            for source_label, edges in model_graph.edges_by_source_label.items()
        },
    }


def _model_graph_from_cache_dict(payload: dict[str, object]) -> ModelGraph:
    raw_fields = payload.get('fieldsByModelLabel')
    raw_nodes = payload.get('nodesByLabel')
    raw_edges = payload.get('edgesBySourceLabel')
    if not isinstance(raw_fields, dict) or not isinstance(raw_nodes, dict) or not isinstance(raw_edges, dict):
        raise ValueError('invalid model graph cache payload')

    fields_by_model_label: dict[str, dict[str, FieldCandidate]] = {}
    for model_label, field_payload in raw_fields.items():
        if not isinstance(field_payload, dict):
            continue
        fields_by_model_label[str(model_label)] = {
            str(field_name): _field_candidate_from_cache_dict(dict(field))
            for field_name, field in field_payload.items()
            if isinstance(field, dict)
        }

    nodes_by_label: dict[str, ModelGraphNode] = {}
    for label, node_payload in raw_nodes.items():
        if not isinstance(node_payload, dict):
            continue
        model_candidate_payload = node_payload.get('modelCandidate')
        runtime_model_payload = node_payload.get('runtimeModel')
        node = ModelGraphNode(
            label=str(node_payload['label']),
            app_label=str(node_payload['appLabel']),
            object_name=str(node_payload['objectName']),
            module=str(node_payload['module']),
            import_path=str(node_payload['importPath']),
            file_path=_string_or_none(node_payload.get('filePath')),
            line=_int_or_none(node_payload.get('line')),
            column=_int_or_none(node_payload.get('column')),
            field_names=tuple(str(name) for name in node_payload.get('fieldNames', [])),
            relation_names=tuple(str(name) for name in node_payload.get('relationNames', [])),
            reverse_relation_names=tuple(
                str(name) for name in node_payload.get('reverseRelationNames', [])
            ),
            manager_names=tuple(str(name) for name in node_payload.get('managerNames', [])),
            model_candidate=(
                ModelCandidate.from_dict(dict(model_candidate_payload))
                if isinstance(model_candidate_payload, dict)
                else None
            ),
            runtime_model=(
                RuntimeModelSummary.from_dict(dict(runtime_model_payload))
                if isinstance(runtime_model_payload, dict)
                else None
            ),
        )
        nodes_by_label[str(label)] = node

    edges_by_source_label: dict[str, tuple[ModelGraphEdge, ...]] = {}
    for source_label, edges_payload in raw_edges.items():
        if not isinstance(edges_payload, list):
            continue
        edges: list[ModelGraphEdge] = []
        for edge_payload in edges_payload:
            if not isinstance(edge_payload, dict):
                continue
            edges.append(
                ModelGraphEdge(
                    source_label=str(edge_payload['sourceLabel']),
                    target_label=str(edge_payload['targetLabel']),
                    direction=str(edge_payload['direction']),
                    field_names=tuple(str(name) for name in edge_payload.get('fieldNames', [])),
                    field_kinds=tuple(str(name) for name in edge_payload.get('fieldKinds', [])),
                )
            )
        edges_by_source_label[str(source_label)] = tuple(edges)

    nodes_by_object_name: dict[str, tuple[ModelGraphNode, ...]] = {}
    for node in nodes_by_label.values():
        nodes_by_object_name[node.object_name] = (
            *nodes_by_object_name.get(node.object_name, ()),
            node,
        )

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


def _int_or_none(value: object) -> int | None:
    if value is None:
        return None
    return int(value)


def _string_or_none(value: object) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if text else None


def _load_reusable_module_indices(
    *,
    cached_module_entries: dict[str, object],
    cached_directory_fingerprints: dict[str, object],
    source_snapshot: PythonSourceSnapshot,
) -> dict[str, ModuleIndex]:
    reusable_modules: dict[str, ModuleIndex] = {}
    unchanged_directories = {
        directory_path
        for directory_path, fingerprint in source_snapshot.directory_fingerprints.items()
        if cached_directory_fingerprints.get(directory_path) == fingerprint
    }

    for entry in source_snapshot.entries:
        cached_entry = cached_module_entries.get(entry.relative_path)
        if not isinstance(cached_entry, dict):
            continue

        cached_file_fingerprint = cached_entry.get('fileFingerprint')
        file_is_unchanged = cached_file_fingerprint == entry.fingerprint
        tree_is_unchanged = _is_under_unchanged_tree(
            entry.directory_path,
            unchanged_directories,
        )
        if not file_is_unchanged and not tree_is_unchanged:
            continue

        module_payload = cached_entry.get('moduleIndex')
        if not isinstance(module_payload, dict):
            continue

        reusable_modules[entry.relative_path] = ModuleIndex.from_dict(
            dict(module_payload)
        )

    return reusable_modules


def _load_reusable_unparseable_entries(
    *,
    cached_unparseable_entries: dict[str, object],
    cached_directory_fingerprints: dict[str, object],
    source_snapshot: PythonSourceSnapshot,
) -> dict[str, str]:
    """Reuse cached parse-failure tombstones for files whose contents have
    not changed. Files with changed fingerprints are dropped so the partial
    rebuild re-parses them — they may have been fixed since the last save.
    """
    reusable: dict[str, str] = {}
    unchanged_directories = {
        directory_path
        for directory_path, fingerprint in source_snapshot.directory_fingerprints.items()
        if cached_directory_fingerprints.get(directory_path) == fingerprint
    }

    for entry in source_snapshot.entries:
        cached_entry = cached_unparseable_entries.get(entry.relative_path)
        if not isinstance(cached_entry, dict):
            continue

        cached_file_fingerprint = cached_entry.get('fileFingerprint')
        file_is_unchanged = cached_file_fingerprint == entry.fingerprint
        tree_is_unchanged = _is_under_unchanged_tree(
            entry.directory_path,
            unchanged_directories,
        )
        if not file_is_unchanged and not tree_is_unchanged:
            continue

        error_kind = cached_entry.get('errorKind')
        if not isinstance(error_kind, str) or not error_kind:
            error_kind = 'UnknownError'

        reusable[entry.relative_path] = error_kind

    return reusable


def _is_under_unchanged_tree(
    directory_path: str,
    unchanged_directories: set[str],
) -> bool:
    current_directory = directory_path
    while True:
        if current_directory in unchanged_directories:
            return True
        if current_directory == '':
            return False
        current_directory = _parent_directory(current_directory)


def _parent_directory(directory_path: str) -> str:
    parent = PurePosixPath(directory_path).parent.as_posix()
    return '' if parent == '.' else parent
