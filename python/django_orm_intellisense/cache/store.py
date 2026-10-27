from __future__ import annotations

import importlib
import json
import os
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path, PurePosixPath
from typing import Callable, Iterable

from .json_stream import decode_json_stream, decode_metadata_stream, decode_static_modules_stream, decode_graph_fields_stream
from .static_records import module_to_row, module_from_row, pool_static_row_strings, expand_static_rows
from .surface_records import model_to_row as surface_model_to_row, restore_surface_rows, SurfaceRecordStreamReader, surface_metadata_hint

from ..discovery.workspace import PythonSourceSnapshot
from ..launch_environment import launch_environment_fingerprint
from ..runtime.inspector import RuntimeInspection
from ..runtime.lookup_catalog import lookup_catalog_json_default
from ..runtime.inspector import RuntimeModelSummary
from ..semantic.graph import ModelGraph, ModelGraphEdge, ModelGraphNode
from ..static_index.indexer import ModuleIndex, StaticIndex, build_static_index
from ..static_index.indexer import FieldCandidate, ModelCandidate
from ..static_index.source_coordinates import SOURCE_COORDINATES_VERSION

# Version 34 retires surfaces produced by unsafe member-cache owner handoffs.
CACHE_SCHEMA_VERSION = 34
SOURCE_SNAPSHOT_CACHE_NAME = 'source-snapshot.json'
STATIC_INDEX_CACHE_NAME = 'static-index.json'
STATIC_INDEX_FULL_CACHE_NAME = 'static-index-full.json'
RUNTIME_CACHE_NAME = 'runtime-inspection.json'
MODEL_GRAPH_CACHE_NAME = 'model-graph.json'
SURFACE_INDEX_CACHE_NAME = 'surface-index.json'
# Format 4 stores repeated immutable members once per model. Format 3 remains
# readable; global schema and source/runtime/fingerprint bindings are unchanged.
SURFACE_INDEX_CACHE_VERSION = 4
# Format 2 removes repeated field property names. Format 1 remains readable;
# the global schema and all source/runtime bindings are unchanged.
MODEL_GRAPH_CACHE_VERSION = 2
# Missing staticIndexVersion denotes the original dictionary format. Both
# full and incremental caches use format 2 without changing source bindings.
STATIC_INDEX_CACHE_VERSION = 2
# Small records benefit from the C decoder's single shared key memo. Large
# indexes avoid retaining all raw module dictionaries alongside owned data.
_STATIC_MODULE_STREAM_MIN_BYTES = 4 * 1024 * 1024
_GRAPH_FIELDS_STREAM_MIN_BYTES = 4 * 1024 * 1024


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
    *,
    import_roots: tuple[str, ...] = (),
) -> tuple[StaticIndex | None, str]:
    """Load a cached StaticIndex.

    Returns ``(static_index, hit_kind)`` where *hit_kind* is one of:
    ``'full'`` (exact fingerprint match, StaticIndex restored directly),
    ``'partial'`` (per-module reuse with incremental rebuild),
    or ``'miss'`` (no usable cache, static_index is None).
    """
    # --- Fast path: full StaticIndex restoration --------------------------
    full_result = _try_load_full_static_index(workspace_root, source_snapshot, import_roots=import_roots)
    if full_result is not None:
        return full_result, 'full'

    # --- Slow path: per-module reuse + incremental rebuild ----------------
    payload = _read_cache_payload(
        _workspace_cache_dir(workspace_root) / STATIC_INDEX_CACHE_NAME,
        static_raw_rows=True,
    )
    if payload is None:
        return None, 'miss'

    metadata = payload.get('metadata')
    if not isinstance(metadata, dict):
        return None, 'miss'

    if (
        metadata.get('schemaVersion') != CACHE_SCHEMA_VERSION
        or metadata.get('workspaceRoot') != str(workspace_root)
        or metadata.get('staticIndexVersion', 1) not in (1, STATIC_INDEX_CACHE_VERSION)
        or metadata.get('sourceCoordinatesVersion') != SOURCE_COORDINATES_VERSION
        or metadata.get('sourceImportRoots', []) != list(import_roots)
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
            _module_rows=metadata.get('staticIndexVersion') == 2,
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
        import_roots=import_roots,
    )
    return result, 'partial'


def _try_load_full_static_index(
    workspace_root: Path,
    source_snapshot: PythonSourceSnapshot,
    *,
    import_roots: tuple[str, ...] = (),
) -> StaticIndex | None:
    def metadata_matches(value):
        return (isinstance(value, dict)
                and value.get('schemaVersion') == CACHE_SCHEMA_VERSION
                and value.get('workspaceRoot') == str(workspace_root)
                and value.get('rootTreeFingerprint') == source_snapshot.fingerprint
                and value.get('staticIndexVersion', 1) in (1, STATIC_INDEX_CACHE_VERSION)
                and value.get('sourceCoordinatesVersion') == SOURCE_COORDINATES_VERSION
                and value.get('sourceImportRoots', []) == list(import_roots))

    payload = _read_cache_payload(
        _workspace_cache_dir(workspace_root) / STATIC_INDEX_FULL_CACHE_NAME,
        restore_static_modules=True,
        static_metadata_matches=metadata_matches,
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
        or metadata.get('staticIndexVersion', 1) not in (1, STATIC_INDEX_CACHE_VERSION)
        or metadata.get('sourceCoordinatesVersion') != SOURCE_COORDINATES_VERSION
        or metadata.get('sourceImportRoots', []) != list(import_roots)
    ):
        return None

    cached_payload = payload.get('payload')
    if not isinstance(cached_payload, dict):
        return None

    try:
        cached_static_index = StaticIndex.from_cache_dict(dict(cached_payload), _restored_modules=True,
            _module_row_loader=(lambda value: module_from_row(value, None))
            if metadata.get('staticIndexVersion') == 2 else None)
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

    if import_roots:
        cached_static_index._source_import_roots = tuple(import_roots)
    return cached_static_index


def save_static_index(
    workspace_root: Path,
    source_snapshot: PythonSourceSnapshot,
    static_index: StaticIndex,
) -> None:
    # Both formats need each module in a different sorted order. Serialize it
    # once into an owned temporary spool, retaining offsets instead of the
    # complete nested module dictionaries until both cache writes finish.
    try:
        with tempfile.TemporaryFile(mode='w+b') as spool:
            _save_static_index_spooled(workspace_root, source_snapshot, static_index, spool)
    except OSError:
        return


def _save_static_index_spooled(workspace_root, source_snapshot, static_index, spool):
    entry_by_path = source_snapshot.entries_by_path
    encoder = json.JSONEncoder(sort_keys=True, default=lookup_catalog_json_default)
    module_offsets = {}
    module_entries = {}
    for module_name, module_index in static_index.modules.items():
        encoded = encoder.encode(module_to_row(module_index)).encode('utf-8')
        offset = spool.tell()
        if spool.write(encoded) != len(encoded):
            raise OSError('Incomplete static module spool write')
        module_offsets[module_name] = (offset, len(encoded))
        try:
            relative_path = Path(module_index.file_path).relative_to(
                workspace_root
            ).as_posix()
        except ValueError:
            relative_path = module_index.file_path

        entry = entry_by_path.get(relative_path)
        if entry is None:
            continue

        module_entries[relative_path] = (module_name, entry.fingerprint)

    spool.flush()

    def module_json(module_name):
        offset, size = module_offsets[module_name]
        spool.seek(offset)
        encoded = spool.read(size)
        if len(encoded) != size:
            raise OSError('Incomplete serialized static module spool')
        return encoded.decode('utf-8')

    def module_entry_json(relative_path):
        module_name, fingerprint = module_entries[relative_path]
        return ('{"fileFingerprint": ' + encoder.encode(fingerprint)
                + ', "moduleRow": ' + module_json(module_name) + '}')

    # Capture the remaining full-index values before either cache can commit.
    full_payload = {
        'pythonFileCount': static_index.python_file_count,
        'packageInitCount': static_index.package_init_count,
        'reexportModuleCount': static_index.reexport_module_count,
        'starImportCount': static_index.star_import_count,
        'explicitAllCount': static_index.explicit_all_count,
        'moduleRows': _CacheJsonRecords(module_offsets, module_json),
        'modelCandidates': [candidate.to_dict() for candidate in static_index.model_candidates],
        'unparseableFiles': dict(static_index.unparseable_files),
        'shadowedFiles': dict(static_index.shadowed_files),
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
                'staticIndexVersion': STATIC_INDEX_CACHE_VERSION,
                'sourceCoordinatesVersion': SOURCE_COORDINATES_VERSION,
                **({'sourceImportRoots': list(static_index._source_import_roots)}
                   if getattr(static_index, '_source_import_roots', ()) else {}),
                'createdAt': datetime.now(timezone.utc).isoformat(),
            },
            'payload': {
                'directoryFingerprints': source_snapshot.directory_fingerprints,
                'moduleEntries': _CacheJsonRecords(module_entries, module_entry_json),
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
                'staticIndexVersion': STATIC_INDEX_CACHE_VERSION,
                'sourceCoordinatesVersion': SOURCE_COORDINATES_VERSION,
                **({'sourceImportRoots': list(static_index._source_import_roots)}
                   if getattr(static_index, '_source_import_roots', ()) else {}),
                'createdAt': datetime.now(timezone.utc).isoformat(),
            },
            'payload': full_payload,
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
    *,
    static_index: StaticIndex | None = None,
    runtime_inspection: RuntimeInspection | None = None,
) -> ModelGraph | None:
    def metadata_matches(value):
        return (isinstance(value, dict)
            and value.get('schemaVersion') == CACHE_SCHEMA_VERSION
            and value.get('modelGraphVersion') in (1, MODEL_GRAPH_CACHE_VERSION)
            and value.get('sourceCoordinatesVersion') == SOURCE_COORDINATES_VERSION
            and value.get('workspaceRoot') == str(workspace_root)
            and value.get('sourceFingerprint') == source_fingerprint
            and value.get('runtimeFingerprint') == runtime_fingerprint)

    payload = _read_cache_payload(
        _workspace_cache_dir(workspace_root) / MODEL_GRAPH_CACHE_NAME,
        restore_graph_fields=True, graph_static_index=static_index,
        graph_metadata_matches=metadata_matches,
    )
    if payload is None:
        return None

    metadata = payload.get('metadata')
    if not isinstance(metadata, dict):
        return None

    if not metadata_matches(metadata):
        return None

    cached_payload = payload.get('payload')
    if not isinstance(cached_payload, dict):
        return None

    try:
        return _model_graph_from_cache_dict(cached_payload, static_index=static_index,
            runtime_inspection=runtime_inspection, _restored_fields=True,
            _field_rows=metadata.get('modelGraphVersion') == 2)
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
                'modelGraphVersion': MODEL_GRAPH_CACHE_VERSION,
                'sourceCoordinatesVersion': SOURCE_COORDINATES_VERSION,
                'createdAt': datetime.now(timezone.utc).isoformat(),
            },
            'payload': _model_graph_to_cache_dict(model_graph, _field_rows=True),
        },
    )


def load_cached_surface_index(
    workspace_root: Path,
    source_fingerprint: str,
    runtime_fingerprint: str,
    *,
    static_index: StaticIndex | None = None,
    model_graph: ModelGraph | None = None,
    with_fingerprints: bool = False,
    with_runtime_members: bool = False,
    runtime_inspection: RuntimeInspection | None = None,
) -> dict[str, object] | tuple | None:
    compacted_models = set()
    payload = _read_cache_payload(
        _workspace_cache_dir(workspace_root) / SURFACE_INDEX_CACHE_NAME,
        compact_surface_models=True,
        compacted_surface_models=compacted_models,
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
        or metadata.get('surfaceIndexVersion') not in (3, SURFACE_INDEX_CACHE_VERSION)
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

    # Complete models already compacted by this read need no second pass.
    # Partial/future entries and injected plain decoders retain the original
    # per-model fallback; the identity hint owns no models and is read-local.
    for model_entry in surface_index.values():
        if not isinstance(model_entry, dict) or id(model_entry) in compacted_models:
            continue
        _compact_surface_model(model_entry)
    runtime_members = None
    if with_runtime_members and 'runtimeMembersVersion' in metadata:
        if metadata.get('sourceCoordinatesVersion') != SOURCE_COORDINATES_VERSION:
            return None
        from .runtime_member_records import VERSION, restore_snapshot
        if (type(metadata['runtimeMembersVersion']) is not int or metadata['runtimeMembersVersion'] != VERSION
                or runtime_inspection is None or runtime_inspection.bootstrap_status != 'ready'
                or static_index is None or model_graph is None):
            return None
        identity = (runtime_inspection.python_executable, runtime_inspection.settings_module,
            runtime_inspection.django_version)
        try:
            runtime_members = restore_snapshot(payload.get('runtimeMembers'),
                metadata.get('runtimeMembersIdentity'), expected_identity=identity,
                expected_fingerprint=metadata.get('runtimeMembersFingerprint'))
            if runtime_members.invalidated_labels:
                return None
            if static_index is not None:
                from ..features.orm_members import _workspace_files, runtime_member_snapshot_is_complete
                if not runtime_member_snapshot_is_complete(static_index, runtime_inspection, model_graph, runtime_members):
                    return None
                paths = _workspace_files(static_index)
                if any(item.file_path is not None and item.file_path not in paths
                        for records in runtime_members.items.values() for item in records):
                    return None
        except (ValueError, TypeError, KeyError):
            return None
    if with_fingerprints or with_runtime_members:
        fingerprints = metadata.get('surfaceFingerprints')
        if (not isinstance(fingerprints, dict)
                or set(fingerprints) != set(surface_index)
                or any(not isinstance(value, str) or len(value) != 32
                       or any(character not in '0123456789abcdef' for character in value)
                       for value in fingerprints.values())):
            fingerprints = None
        return (surface_index, fingerprints, runtime_members) if with_runtime_members else (surface_index, fingerprints)
    return surface_index


def save_surface_index(
    workspace_root: Path,
    source_fingerprint: str,
    runtime_fingerprint: str,
    surface_index: dict[str, object],
    *,
    surface_fingerprints: dict[str, str] | None = None,
    runtime_members=None,
) -> None:
    metadata: dict[str, object] = {
        'schemaVersion': CACHE_SCHEMA_VERSION,
        'surfaceIndexVersion': SURFACE_INDEX_CACHE_VERSION,
        'sourceCoordinatesVersion': SOURCE_COORDINATES_VERSION,
        'workspaceRoot': str(workspace_root),
        'sourceFingerprint': source_fingerprint,
        'runtimeFingerprint': runtime_fingerprint,
        'createdAt': datetime.now(timezone.utc).isoformat(),
    }
    if surface_fingerprints is not None:
        metadata['surfaceFingerprints'] = surface_fingerprints
    encoder = json.JSONEncoder(sort_keys=True, default=lookup_catalog_json_default)
    rows = _CacheJsonRecords(surface_index.keys(),
        lambda label: encoder.encode(surface_model_to_row(surface_index[label])))
    payload = {'metadata': metadata, 'payload': rows}
    if runtime_members is not None:
        from .runtime_member_records import VERSION, snapshot_rows, row_digest, fingerprint_digests
        labels, member_row = snapshot_rows(runtime_members)
        metadata['runtimeMembersVersion'] = VERSION
        metadata['runtimeMembersIdentity'] = list(runtime_members.runtime_identity)
        metadata['runtimeMembersFingerprint'] = fingerprint_digests({label: row_digest(member_row(label)) for label in labels})
        payload['runtimeMembers'] = _CacheJsonRecords(labels, lambda label: encoder.encode(member_row(label)), 1)
    _write_cache_payload(
        _workspace_cache_dir(workspace_root) / SURFACE_INDEX_CACHE_NAME,
        payload,
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
    import importlib.metadata

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
            launch_environment_fingerprint(),
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


_CACHE_STRING_FIELDS = frozenset((
    'filePath', 'modelLabel', 'modelModule', 'moduleName', 'appLabel', 'name',
    'source', 'fieldCallRef', 'fieldKind', 'declarationModule',
    'declaredModelLabel', 'relatedModelLabel', 'relatedModelRefKind',
    'relatedModelRefValue', 'constructorFingerprint',
))


def _decode_cache_payload(raw_payload: str, *, _static_rows=False):
    # A cached module repeats these immutable values in every declaration.
    # Keep sharing scoped to this read; mutable metadata and later reads own
    # their containers, and unrelated/large literal data passes through.
    strings: dict[str, str] = {}
    share = strings.setdefault

    def metadata_strings(value):
        if 'filePath' in value:
            for key, item in value.items():
                if key in _CACHE_STRING_FIELDS and type(item) is str:
                    value[key] = share(item, item)
        if _static_rows and ('moduleRows' in value or 'moduleRow' in value):
            pool_static_row_strings(value, share)
        return value

    return (json.loads(raw_payload, object_hook=metadata_strings)
            if isinstance(raw_payload, (str, bytes, bytearray))
            else decode_metadata_stream(raw_payload, _CACHE_STRING_FIELDS))


def _decode_static_cache_payload(stream, metadata_matches=None):
    strings, keys = {}, {}
    share, key = strings.setdefault, keys.setdefault
    row_format = False

    def matches(value):
        nonlocal row_format
        allowed = metadata_matches(value)
        row_format = allowed and isinstance(value, dict) and value.get('staticIndexVersion') == 2
        return allowed

    def metadata_strings(value):
        if 'filePath' in value:
            for name, item in value.items():
                if name in _CACHE_STRING_FIELDS and type(item) is str:
                    value[name] = share(item, item)
        if 'moduleRows' in value or 'moduleRow' in value:
            pool_static_row_strings(value, share)
        return value

    def restore_module(value):
        # Wire property keys disappear during hydration. Share only keys of
        # dictionaries retained by ModuleIndex rather than copying every
        # decoded child just to share keys that will immediately be dropped.
        for name in ('symbolDefinitions', 'classBaseRefs', 'fieldAliases'):
            mapping = value.get(name)
            if isinstance(mapping, dict):
                value[name] = {key(name, name): item for name, item in mapping.items()}
        try:
            return ModuleIndex.from_dict(dict(value))
        except Exception:
            # A later duplicate may replace this record or its whole payload.
            # Preserve metadata/count validation and normal error precedence
            # by retrying invalid records only after the complete JSON read.
            return value

    def restore_module_row(value):
        if not row_format:
            return value
        try:
            if isinstance(value, dict):
                return restore_module(value)
            for position in (4, 9, 11):
                mapping = value[position] if len(value) > position else None
                if isinstance(mapping, dict):
                    value[position] = {key(name, name): item for name, item in mapping.items()}
            return module_from_row(value, share)
        except Exception:
            return value

    try:
        return decode_static_modules_stream(stream, metadata_strings, restore_module,
            metadata_matches=matches if metadata_matches is not None else None,
            restore_module_row=restore_module_row)
    finally:
        strings.clear()
        keys.clear()


def _decode_graph_cache_payload(stream, static_index=None, metadata_matches=None):
    strings, keys = {}, {}
    share, key = strings.setdefault, keys.setdefault
    row_format = False

    def matches(value):
        nonlocal row_format
        allowed = metadata_matches(value)
        row_format = allowed and isinstance(value, dict) and value.get('modelGraphVersion') == 2
        return allowed

    def metadata_strings(value):
        if 'filePath' in value:
            return {key(name, name): share(item, item)
                    if name in _CACHE_STRING_FIELDS and type(item) is str else item
                    for name, item in value.items()}
        return {key(name, name): item for name, item in value.items()}

    def record_strings(value):
        # These freshly decoded node/edge dictionaries are discarded when
        # constructing the graph. Share retained string values in place.
        if 'filePath' in value:
            for name, item in value.items():
                if name in _CACHE_STRING_FIELDS and type(item) is str:
                    value[name] = share(item, item)
        return value

    def restore_model_fields(value):
        try:
            return {name: _restore_graph_field(dict(field), static_index)
                    if isinstance(field, dict) else field for name, field in value.items()}
        except Exception:
            # A duplicate model/payload or later metadata may replace this
            # record. Retry invalid fields only after full JSON validation.
            return value

    def restore_model_rows(value):
        if not row_format:
            return value
        try:
            return {name: _restore_graph_field_row(field, static_index, share)
                    if isinstance(field, list) else _restore_graph_field(dict(field), static_index)
                    if isinstance(field, dict) else field for name, field in value.items()}
        except Exception:
            # As for dictionary fields, later duplicate keys can replace an
            # invalid record. Validate only the final selected payload.
            return value

    try:
        return decode_graph_fields_stream(stream, metadata_strings, restore_model_fields,
            metadata_matches=matches if metadata_matches is not None else None,
            restore_model_rows=restore_model_rows,
            record_hook=record_strings if metadata_matches is not None else None)
    finally:
        strings.clear()
        keys.clear()


def _compact_surface_model(model_entry):
    values = {}
    for receiver_entry in model_entry.values():
        if not isinstance(receiver_entry, dict):
            continue
        for name, value in receiver_entry.items():
            if not isinstance(value, list) or len(value) != 4:
                continue
            compact = tuple(value)
            try:
                shared = values.get(compact)
            except TypeError:
                # Unknown metadata can contain mutable lists/dicts. Keep its
                # original arrays and independently owned children intact.
                continue
            if shared is not None:
                receiver_entry[name] = shared
            elif all(part is None or isinstance(part, str) for part in compact):
                # Repeated members across receivers need validation only once
                # per model. Only validated string/None tuples enter this pool.
                values[compact] = compact
                receiver_entry[name] = compact
    return model_entry


def _decode_legacy_surface_cache_payload(raw_payload: str, *, compacted_models=None):
    compacted = []

    def compact_model(value):
        # Release each complete model's temporary arrays/duplicate strings
        # before the JSON decoder retains the next model. The standard four
        # receiver maps distinguish model entries from member/metadata dicts.
        # Partial/future shapes still undergo the existing post-load pass.
        if 'model_class' in value and all(isinstance(value.get(receiver), dict)
               for receiver in ('model_class', 'manager', 'queryset', 'instance')):
            _compact_surface_model(value)
            compacted.append(value)
        return value

    result = (json.loads(raw_payload, object_hook=compact_model)
              if isinstance(raw_payload, (str, bytes, bytearray))
              else decode_json_stream(raw_payload, compact_model, compacted))
    payload = result.get('payload') if isinstance(result, dict) else None
    model_ids = {id(model) for model in payload.values()} if isinstance(payload, dict) else set()
    if compacted_models is not None:
        compacted_models.update(id(value) for value in compacted if id(value) in model_ids)
    # Object hooks run bottom-up, before they know the parent key. A future
    # nested payload can resemble a model's receiver maps; keep that unknown
    # data mutable exactly as JSON supplied it. Only actual model entries
    # keep the compact representation (the existing post-load contract).
    for value in compacted:
        if id(value) not in model_ids:
            for receiver in value.values():
                if isinstance(receiver, dict):
                    for name, item in receiver.items():
                        if isinstance(item, tuple):
                            receiver[name] = list(item)
    return result


def _decode_surface_cache_payload(raw_payload: str, *, compacted_models=None):
    # Ordinary format-4 files have metadata first and can release each model's
    # raw table immediately. Unusual key order and non-seekable injected streams
    # retain the normal decoder and restore only the final selected payload.
    hint = surface_metadata_hint(raw_payload) if not isinstance(raw_payload, (str, bytes, bytearray)) else None
    streamed_rows = type(hint) is dict and hint.get('surfaceIndexVersion') == 4
    streamed_members = streamed_rows and hint.get('runtimeMembersVersion') == 1
    if streamed_rows:
        position = raw_payload.tell()
        result = SurfaceRecordStreamReader(raw_payload, runtime_members=streamed_members).read()
    else:
        result = _decode_legacy_surface_cache_payload(raw_payload, compacted_models=compacted_models)
    metadata = result.get('metadata') if isinstance(result, dict) else None
    if streamed_members and (not isinstance(metadata, dict) or metadata.get('runtimeMembersVersion') != 1):
        del result
        raw_payload.seek(position)
        result = _decode_legacy_surface_cache_payload(raw_payload, compacted_models=compacted_models)
        metadata = result.get('metadata') if isinstance(result, dict) else None
    if isinstance(metadata, dict) and metadata.get('surfaceIndexVersion') == 4:
        result['payload'] = restore_surface_rows(result.get('payload'))
        if compacted_models is not None:
            compacted_models.update(id(value) for value in result['payload'].values())
        return result
    if streamed_rows:
        # Leading metadata is only a decoding hint. A later duplicate can
        # select the legacy version, whose arrays must keep legacy semantics.
        del result
        raw_payload.seek(position)
        return _decode_legacy_surface_cache_payload(raw_payload, compacted_models=compacted_models)
    return result


def _read_cache_payload(cache_path: Path, *, compact_surface_models: bool = False,
                        restore_static_modules: bool = False,
                        static_raw_rows: bool = False,
                        static_metadata_matches=None, restore_graph_fields: bool = False,
                        graph_static_index=None, graph_metadata_matches=None,
                        compacted_surface_models=None) -> dict[str, object] | None:
    try:
        if compact_surface_models:
            with cache_path.open('r', encoding='utf-8') as stream:
                payload = (_decode_surface_cache_payload(stream, compacted_models=compacted_surface_models)
                    if compacted_surface_models is not None else _decode_surface_cache_payload(stream))
        elif restore_static_modules:
            try:
                streamed = cache_path.stat().st_size >= _STATIC_MODULE_STREAM_MIN_BYTES
            except OSError:
                # This size hint affects allocation only. A failed extra stat
                # must not turn a readable cache into a new miss.
                streamed = False
            if streamed:
                with cache_path.open('r', encoding='utf-8') as stream:
                    payload = _decode_static_cache_payload(stream, static_metadata_matches)
            else:
                payload = _decode_cache_payload(cache_path.read_text(encoding='utf-8'), _static_rows=True)
        elif restore_graph_fields or cache_path.name == MODEL_GRAPH_CACHE_NAME:
            try:
                streamed = restore_graph_fields and cache_path.stat().st_size >= _GRAPH_FIELDS_STREAM_MIN_BYTES
            except OSError:
                streamed = False
            with cache_path.open('r', encoding='utf-8') as stream:
                payload = (_decode_graph_cache_payload(stream, graph_static_index, graph_metadata_matches)
                           if streamed else _decode_cache_payload(stream))
        else:
            payload = _decode_cache_payload(cache_path.read_text(encoding='utf-8'),
                _static_rows=static_raw_rows or cache_path.name in (STATIC_INDEX_CACHE_NAME, STATIC_INDEX_FULL_CACHE_NAME))
    except OSError:
        return None
    except (ValueError, RecursionError):
        # JSON/Unicode errors and the decoder's nesting/integer limits all
        # reject derived data. Rebuild from source rather than abort startup.
        _unlink_quietly(cache_path)
        return None

    if (not restore_graph_fields and cache_path.name == MODEL_GRAPH_CACHE_NAME
            and isinstance(payload, dict)):
        _expand_graph_field_rows(payload)
    elif (not restore_static_modules and not static_raw_rows and isinstance(payload, dict)
            and cache_path.name in (STATIC_INDEX_CACHE_NAME, STATIC_INDEX_FULL_CACHE_NAME)):
        expand_static_rows(payload, full=cache_path.name == STATIC_INDEX_FULL_CACHE_NAME)
    return payload if isinstance(payload, dict) else None


@dataclass(frozen=True, slots=True)
class _CacheJsonRecords:
    keys: Iterable[str]
    record: Callable[[str], str]
    batch_size: int = 64


def _write_cache_json_value(stream, value, encoder, depth):
    if type(value) is _CacheJsonRecords:
        keys = sorted(value.keys)
        stream.write('{')
        for offset in range(0, len(keys), value.batch_size):
            if offset:
                stream.write(', ')
            stream.write(', '.join(encoder.encode(key) + ': ' + value.record(key)
                                  for key in keys[offset:offset + value.batch_size]))
        stream.write('}')
        return
    if type(value) is dict and all(type(key) is str for key in value):
        keys = sorted(value)
        if len(keys) > 128:
            stream.write('{')
            for offset in range(0, len(keys), 64):
                if offset:
                    stream.write(', ')
                shard = {key: value[key] for key in keys[offset:offset + 64]}
                stream.write(encoder.encode(shard)[1:-1])
            stream.write('}')
            return
        if depth < 3:
            stream.write('{')
            for number, key in enumerate(keys):
                if number:
                    stream.write(', ')
                stream.write(encoder.encode(key))
                stream.write(': ')
                _write_cache_json_value(stream, value[key], encoder, depth + 1)
            stream.write('}')
            return
    if type(value) is list and len(value) > 128:
        stream.write('[')
        for offset in range(0, len(value), 128):
            if offset:
                stream.write(', ')
            stream.write(encoder.encode(value[offset:offset + 128])[1:-1])
        stream.write(']')
    else:
        stream.write(encoder.encode(value))


def _write_cache_payload(cache_path: Path, payload: dict[str, object]) -> None:
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = None

    try:
        # Bound intermediate JSON strings by groups of records, retaining the
        # exact sorted/default encoder bytes. A unique temporary file keeps
        # overlapping cache writers from truncating or moving each other's
        # work; readers only observe a complete file after replacement.
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8',
                prefix=f'.{cache_path.name}.', suffix='.tmp', dir=cache_path.parent,
                delete=False) as stream:
            temporary_path = Path(stream.name)
            encoder = json.JSONEncoder(sort_keys=True, default=lookup_catalog_json_default)
            _write_cache_json_value(stream, payload, encoder, 0)
        temporary_path.replace(cache_path)
    except OSError:
        if temporary_path is not None:
            _unlink_quietly(temporary_path)
    except BaseException:
        if temporary_path is not None:
            _unlink_quietly(temporary_path)
        raise


def _unlink_quietly(cache_path: Path) -> None:
    try:
        cache_path.unlink(missing_ok=True)
    except OSError:
        return


def _field_candidate_to_cache_dict(field: FieldCandidate) -> dict[str, object]:
    payload = field.to_dict()
    payload['importedConstants'] = [list(value) for value in field.imported_constants]
    payload['declarationModule'] = field.declaration_module
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
        constructor_fingerprint=_string_or_none(payload.get('constructorFingerprint')),
        imported_constants=tuple((str(value[0]), str(value[1])) for value in payload.get('importedConstants', [])
                                 if isinstance(value, list) and len(value) == 2),
        declaration_module=_string_or_none(payload.get('declarationModule')),
    )


# Fixed positions belong to graph format 2. A separate map keeps later or
# duplicate format-1 metadata from selecting already-restored format-2 rows.
# Changing the order or dropping a value requires a new graph format version.
_GRAPH_FIELD_ROW_KEYS = (
    'modelLabel', 'name', 'filePath', 'line', 'column', 'fieldKind', 'isRelation',
    'relationDirection', 'relatedModelLabel', 'declaredModelLabel', 'relatedName',
    'relatedQueryName', 'source', 'constructorFingerprint', 'importedConstants',
    'declarationModule',
)


def _field_candidate_to_cache_row(field: FieldCandidate) -> list[object]:
    return [field.model_label, field.name, field.file_path, field.line, field.column,
        field.field_kind, field.is_relation, field.relation_direction, field.related_model_label,
        field.declared_model_label, field.related_name, field.related_query_name, field.source,
        field.constructor_fingerprint, [list(value) for value in field.imported_constants],
        field.declaration_module]


def _graph_field_row_to_dict(row, share=None):
    if len(row) != len(_GRAPH_FIELD_ROW_KEYS):
        raise ValueError('invalid model graph field row')
    result = dict(zip(_GRAPH_FIELD_ROW_KEYS, row))
    if share is not None:
        for name in _CACHE_STRING_FIELDS:
            item = result.get(name)
            if type(item) is str:
                result[name] = share(item, item)
    return result


def _expand_graph_field_rows(payload):
    # The raw cache reader and public graph dictionary factory retain their
    # dictionary contract. Only a known graph format's exact field map expands.
    metadata, graph = payload.get('metadata'), payload.get('payload')
    if not (isinstance(metadata, dict) and metadata.get('modelGraphVersion') == 2
            and isinstance(graph, dict) and isinstance(graph.get('fieldRowsByModelLabel'), dict)):
        return
    strings = {}
    try:
        graph['fieldsByModelLabel'] = {
            label: {name: _graph_field_row_to_dict(row, strings.setdefault)
                if isinstance(row, list) and len(row) == len(_GRAPH_FIELD_ROW_KEYS) else row
                for name, row in fields.items()} if isinstance(fields, dict) else fields
            for label, fields in graph.pop('fieldRowsByModelLabel').items()}
    finally:
        strings.clear()


def _model_graph_to_cache_dict(model_graph: ModelGraph, *, _field_rows=False) -> dict[str, object]:
    return {
        'fieldRowsByModelLabel' if _field_rows else 'fieldsByModelLabel': {
            model_label: {
                field_name: _field_candidate_to_cache_row(field) if _field_rows else _field_candidate_to_cache_dict(field)
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


def _graph_field_is_shareable(field: FieldCandidate) -> bool:
    # A caller can construct a frozen dataclass with mutable or coercible
    # values. Reuse only the primitive types produced by the static index.
    return (type(field) is FieldCandidate
        and type(field.model_label) is str and type(field.name) is str
        and type(field.file_path) is str and type(field.field_kind) is str
        and type(field.source) is str
        and type(field.line) is int and type(field.column) is int
        and type(field.is_relation) is bool
        and (field.relation_direction is None or type(field.relation_direction) is str and field.relation_direction != '')
        and (field.related_model_label is None or type(field.related_model_label) is str and field.related_model_label != '')
        and (field.declared_model_label is None or type(field.declared_model_label) is str and field.declared_model_label != '')
        and (field.related_name is None or type(field.related_name) is str and field.related_name != '')
        and (field.related_query_name is None or type(field.related_query_name) is str and field.related_query_name != '')
        and (field.constructor_fingerprint is None or type(field.constructor_fingerprint) is str and field.constructor_fingerprint != '')
        and (field.declaration_module is None or type(field.declaration_module) is str and field.declaration_module != '')
        and type(field.imported_constants) is tuple
        and all(type(value) is tuple and len(value) == 2
                and all(type(part) is str for part in value)
                for value in field.imported_constants))


def _restore_graph_field(payload: dict[str, object], static_index: StaticIndex | None) -> FieldCandidate:
    # Static fields are frozen, including their nested tuple values. Share
    # only an exact complete match from this caller's already-restored owner;
    # mutable graph containers and runtime/future/differing fields stay local.
    if static_index is not None:
        label = payload.get('modelLabel')
        name = payload.get('name')
        if type(label) is str and type(name) is str:
            existing = static_index.find_field(label, name)
            if (existing is not None and _graph_field_is_shareable(existing)
                    and _field_candidate_to_cache_dict(existing) == payload):
                return existing
    return _field_candidate_from_cache_dict(payload)


def _restore_graph_field_row(row, static_index, share):
    if len(row) != len(_GRAPH_FIELD_ROW_KEYS):
        raise ValueError('invalid model graph field row')
    # Keep the same complete-value comparison and immutable-owner guard as
    # format 1; compact storage must not broaden which values are shared.
    if static_index is not None and type(row[0]) is str and type(row[1]) is str:
        existing = static_index.find_field(row[0], row[1])
        if (existing is not None and _graph_field_is_shareable(existing)
                and _field_candidate_to_cache_row(existing) == row):
            return existing
    return _field_candidate_from_cache_dict(_graph_field_row_to_dict(row, share))


def _model_graph_from_cache_dict(payload: dict[str, object], *,
        static_index: StaticIndex | None = None, runtime_inspection: RuntimeInspection | None = None,
        _restored_fields: bool = False, _field_rows: bool = False) -> ModelGraph:
    rows = _field_rows and 'fieldRowsByModelLabel' in payload
    raw_fields = payload.get('fieldRowsByModelLabel' if rows else 'fieldsByModelLabel')
    raw_nodes = payload.get('nodesByLabel')
    raw_edges = payload.get('edgesBySourceLabel')
    if not isinstance(raw_fields, dict) or not isinstance(raw_nodes, dict) or not isinstance(raw_edges, dict):
        raise ValueError('invalid model graph cache payload')

    fields_by_model_label: dict[str, dict[str, FieldCandidate]] = {}
    strings = {}
    try:
        for model_label, field_payload in raw_fields.items():
            if not isinstance(field_payload, dict):
                continue
            fields_by_model_label[str(model_label)] = {
                str(field_name): field if _restored_fields and type(field) is FieldCandidate
                else _restore_graph_field_row(field, static_index, strings.setdefault)
                if rows and isinstance(field, list) else _restore_graph_field(dict(field), static_index)
                for field_name, field in field_payload.items()
                if (_restored_fields and type(field) is FieldCandidate) or isinstance(field, dict)
                    or rows and isinstance(field, list)
            }
    finally:
        strings.clear()

    # Read-local lookup only: the returned graph shares primitive frozen value
    # records, never the runtime owner, summary objects or their mutable lists.
    runtime_models = ({model.label: model for model in runtime_inspection.model_catalog
        if type(model) is RuntimeModelSummary and type(model.label) is str}
        if type(runtime_inspection) is RuntimeInspection and type(runtime_inspection.model_catalog) is tuple else {})
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
                RuntimeModelSummary.from_dict(dict(runtime_model_payload), _reuse_from=(
                    runtime_models.get(runtime_model_payload.get('label'))
                    if type(runtime_model_payload.get('label')) is str else None))
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
    _module_rows: bool = False,
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
        if cached_file_fingerprint != entry.fingerprint and not _is_under_unchanged_tree(
            entry.directory_path, unchanged_directories,
        ):
            continue

        module_payload = cached_entry.get('moduleRow' if _module_rows and 'moduleRow' in cached_entry else 'moduleIndex')
        if not isinstance(module_payload, dict) and not (_module_rows and isinstance(module_payload, list)):
            continue

        reusable_modules[entry.relative_path] = (module_from_row(module_payload, None)
            if _module_rows and isinstance(module_payload, list)
            else ModuleIndex.from_dict(dict(module_payload)))

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
        if cached_file_fingerprint != entry.fingerprint and not _is_under_unchanged_tree(
            entry.directory_path, unchanged_directories,
        ):
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
    if PurePosixPath(directory_path).is_absolute():
        # External editable modules have their own absolute file fingerprints;
        # workspace subtree hashes cannot justify reusing them.
        return False
    current_directory = directory_path
    while True:
        if current_directory in unchanged_directories:
            return True
        if current_directory == '':
            return False
        current_directory = _parent_directory(current_directory)


def _parent_directory(directory_path: str) -> str:
    parent = PurePosixPath(directory_path).parent.as_posix()
    return '' if parent == '.' or parent == directory_path else parent
