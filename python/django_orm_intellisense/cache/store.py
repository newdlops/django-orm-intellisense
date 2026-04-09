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
from ..static_index.indexer import ModuleIndex, StaticIndex, build_static_index

CACHE_SCHEMA_VERSION = 8
STATIC_INDEX_CACHE_NAME = 'static-index.json'
STATIC_INDEX_FULL_CACHE_NAME = 'static-index-full.json'
RUNTIME_CACHE_NAME = 'runtime-inspection.json'
SURFACE_INDEX_CACHE_NAME = 'surface-index.json'


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
    if not isinstance(cached_directory_fingerprints, dict) or not isinstance(
        cached_module_entries, dict
    ):
        return None, 'miss'

    try:
        reusable_module_indices = _load_reusable_module_indices(
            cached_module_entries=cached_module_entries,
            cached_directory_fingerprints=cached_directory_fingerprints,
            source_snapshot=source_snapshot,
        )
    except (KeyError, TypeError, ValueError):
        _unlink_quietly(
            _workspace_cache_dir(workspace_root) / STATIC_INDEX_CACHE_NAME
        )
        return None, 'miss'

    if not reusable_module_indices:
        return None, 'miss'

    result = build_static_index(
        workspace_root,
        python_files=source_snapshot.files,
        cached_module_indices=reusable_module_indices,
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
        return StaticIndex.from_cache_dict(dict(cached_payload))
    except (KeyError, TypeError, ValueError):
        _unlink_quietly(
            _workspace_cache_dir(workspace_root) / STATIC_INDEX_FULL_CACHE_NAME
        )
        return None


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
        return RuntimeInspection.from_cache_dict(dict(cached_payload))
    except (KeyError, TypeError, ValueError):
        _unlink_quietly(
            _workspace_cache_dir(workspace_root) / RUNTIME_CACHE_NAME
        )
        return None


def save_runtime_inspection(
    workspace_root: Path,
    source_fingerprint: str,
    settings_module: str | None,
    runtime: RuntimeInspection,
) -> None:
    _write_cache_payload(
        _workspace_cache_dir(workspace_root) / RUNTIME_CACHE_NAME,
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


def load_cached_surface_index(
    workspace_root: Path,
    source_fingerprint: str,
    runtime_fingerprint: str,
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

    return dict(cached_payload)


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
