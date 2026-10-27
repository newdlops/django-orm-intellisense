from __future__ import annotations

import base64
import contextlib
import copy
import dataclasses
import gzip
import hashlib
import json
import multiprocessing
import os
import stat
import sys
import threading
import time
import traceback
import weakref
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .ipc_encoding import encode_ipc_message
from .worker_lifetime import (
    DrainingProcessPool, surface_pool_state_path, watch_parent_lifetime, watch_surface_pool_lifetime,
)
from .worker_state import (
    persistent_worker_state_file, surface_worker_state_file, load_surface_worker_state,
    runtime_member_state_file, load_runtime_member_state,
)
from ..runtime.source_imports import current_workspace_source_imports
from .._native_spawn import guarded_spawn_context

from ..cache import (
    load_cached_model_graph,
    load_cached_runtime_inspection,
    load_cached_static_index,
    load_cached_surface_index,
    save_model_graph,
    save_source_snapshot,
    save_runtime_inspection,
    save_static_index,
    save_surface_index,
)
from ..discovery.workspace import (
    SKIP_DIRS,
    PythonSourceSnapshot,
    VenvInfo,
    WorkspaceProfile,
    discover_workspace,
    resolve_venv_info,
    source_membership_fingerprint,
    snapshot_python_sources,
)
from ..features.health import build_health_snapshot, refresh_health_snapshot
from ..discovery.source_observation import source_observation_context
from .reindex_profile import current_profile, profile_reindex
from ..features.lookup_paths import (
    resolve_lookup_path,
    list_lookup_path_completions,
)
from ..features.orm_members import (
    _build_static_to_graph_label_map,
    capture_runtime_member_surface,
    capture_current_runtime_members,
    runtime_member_snapshot_is_complete,
    invalidate_runtime_members,
    install_runtime_members,
    fingerprint_json_payload,
    fingerprint_surface_index,
    prebuild_member_surface_cache,
    prebuild_runtime_workspace_paths,
    runtime_workspace_paths_are_current,
    rebuild_surface_for_models,
    rebind_member_surface_cache_runtime,
    reuse_member_surface_cache_for_unchanged_index,
    rebase_runtime_member_source_paths,
    resolve_orm_member,
    resolve_orm_member_chain,
)
from ..features.reexports import resolve_export_origin
from ..features.relation_targets import (
    list_relation_targets,
    resolve_relation_target,
)
from ..runtime.inspector import (
    RuntimeInspection,
    can_defer_runtime_inspection,
    create_pending_runtime_inspection,
    inspect_runtime,
)
from ..semantic.graph import (
    ModelGraph,
    ModelGraphNode,
    SemanticGraphSummary,
    build_model_graph,
    build_semantic_graph,
    rebuild_model_graph_for_labels,
)
from ..static_index.indexer import StaticIndex, build_static_index, reindex_single_file, _module_name_for_reindex
from .runtime_members import RuntimeSourceEpoch, source_identity, refresh_in_process
from .source_provenance import capture_source_provenance
from ..launch_environment import launch_environment_fingerprint
from .surface_transport import SurfaceSnapshotEncoder, PreparedSurfaceSnapshot


INITIAL_SYNC_SURFACE_INDEX_MODEL_LIMIT = 200
SURFACE_INDEX_ON_DEMAND_METHODS = {
    'ormMemberCompletions',
    'resolveOrmMember',
    'resolveOrmMemberBatch',
    'resolveOrmMemberChain',
}


def _inheritance_dependent_labels(
    static_index: StaticIndex,
    seed_labels: set[str],
) -> set[str]:
    return static_index.inheritance_dependents(seed_labels) if seed_labels else set()


def _source_dependent_labels(static_index: StaticIndex, seed_modules: set[str]) -> set[str]:
    """Follow imports to models whose managers, methods or aliases may change."""
    return static_index.source_dependents(seed_modules) if seed_modules else set()


_SURFACE_FIELD_MEMBER_KINDS = frozenset({'field', 'relation', 'reverse_relation'})
# Names the client synthesizes for every model; their presence alone does not
# mean the surface entry knows the model's fields.
_SYNTHETIC_PRIMARY_KEY_NAMES = frozenset({'id', 'pk'})


def _surface_labels_with_instance_fields(
    surface_index: dict[str, object],
    *,
    labels: set[str] | None = None,
) -> set[str]:
    """Labels whose surface entry lists at least one real instance field.

    Concrete models stay registered in the surface index even when their
    ``instance`` receiver came back empty (inheritance-only models, or a slice
    rebuilt against a static-only graph during runtime warm-up). Such an entry
    must not suppress the model's static fallback: the client would then only
    see the ``id`` / ``pk`` it synthesizes for every model.
    """
    found: set[str] = set()
    entries = surface_index.items() if labels is None else (
        (label, surface_index.get(label)) for label in labels)
    for label, entry in entries:
        if not isinstance(entry, dict):
            continue
        instance_members = entry.get('instance')
        if not isinstance(instance_members, dict):
            continue
        for name, member in instance_members.items():
            if name in _SYNTHETIC_PRIMARY_KEY_NAMES:
                continue
            member_kind = (
                member[2]
                if isinstance(member, (list, tuple)) and len(member) > 2
                else None
            )
            if member_kind in _SURFACE_FIELD_MEMBER_KINDS:
                found.add(label)
                break
    return found


def _affected_graph_nodes(model_graph: ModelGraph, static_index: StaticIndex,
                          labels: set[str]) -> list[ModelGraphNode]:
    """Find direct and runtime-remapped nodes through the existing name index."""
    selected = {}
    for label in labels:
        direct = model_graph.node_for_model(label)
        if direct is not None:
            selected[label] = direct
        candidate = static_index.find_model_candidate(label)
        if candidate is None:
            continue
        for node in model_graph.nodes_by_object_name.get(candidate.object_name, ()):
            if node.model_candidate is not None and node.model_candidate.label in labels:
                selected[node.label] = node
    return list(selected.values())


def _static_fallback_entry(
    model_graph: ModelGraph,
    node: ModelGraphNode,
) -> dict[str, object] | None:
    candidate = node.model_candidate
    if candidate is not None and candidate.is_abstract:
        return None
    # Models known only from runtime inspection (installed third-party apps)
    # have no static candidate, so they never get a surface entry. Without a
    # fallback entry their lookups end in the client's generic `pk` / `id`.
    runtime_only = candidate is None
    if runtime_only and node.runtime_model is None:
        return None
    scalar_names: list[str] = []
    relation_names: list[str] = []
    reverse_relation_names: list[str] = []
    field_details: dict[str, dict[str, object]] = {}
    for field in model_graph.fields_for_model(node.label):
        field_details[field.name] = {
            'fieldKind': field.field_kind,
            'isRelation': field.is_relation,
            'relationDirection': field.relation_direction,
            'relatedModelLabel': field.related_model_label,
        }
        if field.relation_direction == 'reverse':
            reverse_relation_names.append(field.name)
        elif field.is_relation:
            relation_names.append(field.name)
        else:
            scalar_names.append(field.name)
    if not (scalar_names or relation_names or reverse_relation_names):
        return None
    entry: dict[str, object] = {
        'fields': scalar_names,
        'relations': relation_names,
        'reverseRelations': reverse_relation_names,
        'fieldDetails': field_details,
    }
    if runtime_only:
        # The client resolves these by exact label only: their short names
        # (`Result`, `Token`, `Tag`, ...) must not feed receiver inference.
        entry['runtimeOnly'] = True
    return entry


def _rebuild_surface_slice(
    *,
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    model_graph: ModelGraph,
    labels: set[str],
    surface_index: dict[str, object],
    previous_static_index: StaticIndex | None,
    previous_model_graph: ModelGraph | None,
    source_affected_labels: set[str] | None = None,
) -> tuple[dict[str, object], set[str]]:
    """Rebuild the surface entries of ``labels`` (static candidate labels).

    Returns the merged surface and every rebuilt surface key, old
    and new. Surface keys are graph labels, which differ from candidate labels
    when ``AppConfig.label`` diverges from the module (candidate ``zuzu.X`` ↔
    surface ``db.X``); keying a delta by candidate labels reports ``zuzu.X``
    removed and never ships the rebuilt ``db.X`` entry.
    """
    old_label_map = (
        _build_static_to_graph_label_map(previous_static_index, previous_model_graph)
        if previous_static_index is not None
        else {}
    )
    new_label_map = _build_static_to_graph_label_map(static_index, model_graph)
    labels = set(labels)
    if source_affected_labels is not None and previous_model_graph is not None:
        for label in labels - source_affected_labels:
            old_key = old_label_map.get(label, label)
            new_key = new_label_map.get(label, label)
            old_node = previous_model_graph.node_for_model(old_key)
            # Relation invalidation also visits neighbours whose actual
            # surface did not change. Keep their existing entries when both
            # node metadata and complete fields are identical. Source/import
            # dependents always rebuild, even when their fields are unchanged.
            if (old_key == new_key and new_key in surface_index and old_node is not None
                    and old_node == model_graph.node_for_model(new_key)
                    and previous_model_graph.fields_by_model_label.get(old_key)
                        == model_graph.fields_by_model_label.get(new_key)):
                labels.discard(label)
    surface_keys = {old_label_map.get(label, label) for label in labels}
    surface_keys |= {new_label_map.get(label, label) for label in labels}

    merged = rebuild_surface_for_models(
        static_index, runtime, model_graph, labels, surface_index,
        previous_static_index=previous_static_index, previous_model_graph=previous_model_graph,
    )
    # `rebuild_surface_for_models` only drops keys under the new label map;
    # a deleted model's entry may still sit under its old graph label.
    current_keys = {
        new_label_map.get(candidate.label, candidate.label)
        for candidate in static_index.model_candidates
        if not candidate.is_abstract
    }
    for key in surface_keys - current_keys:
        merged.pop(key, None)
    return merged, surface_keys


_REINDEX_COMMIT_ATTEMPTS = 3
_WARMUP_APPLY_ATTEMPTS = 3
_SURFACE_PUBLISH_ATTEMPTS = 3
_SURFACE_PUBLISH_IDLE_SECONDS = 0.2


@dataclass(frozen=True, slots=True)
class _RecentReindexSource:
    path: Path
    identity: object
    fingerprint: bytes
    generation: int
    serial: int
    static: weakref.ReferenceType[StaticIndex]
    runtime: weakref.ReferenceType[RuntimeInspection]
    graph: weakref.ReferenceType[ModelGraph]

    def matches_owner(self, server: DaemonServer) -> bool:
        return (self is server._last_reindex_source
            and self.generation == server._state_generation and self.serial == server._reindex_serial
            and server.static_index is not None and server.runtime_inspection is not None and server.model_graph is not None
            and self.static() is server.static_index and self.runtime() is server.runtime_inspection
            and self.graph() is server.model_graph)


@dataclass
class _ReindexOutcome:
    new_static_index: StaticIndex
    # None when the file touched no model (only the static index changes).
    affected_labels: set[str] | None = None
    model_graph: ModelGraph | None = None
    surface_index: dict[str, object] | None = None
    surface_index_delta: dict[str, object] = dataclasses.field(default_factory=dict)
    surface_fingerprints: dict[str, str] = dataclasses.field(default_factory=dict)
    removed_labels: list[str] = dataclasses.field(default_factory=list)
    added_labels: list[str] = dataclasses.field(default_factory=list)
    changed_labels: list[str] = dataclasses.field(default_factory=list)
    static_fallback: dict[str, dict[str, object]] | None = None
    static_fallback_delta: dict[str, dict[str, object]] = dataclasses.field(default_factory=dict)
    removed_static_fallback_labels: list[str] = dataclasses.field(default_factory=list)
    model_names: list[str] = dataclasses.field(default_factory=list)
    lookup_catalog_delta: dict[str, dict[str, object] | None] = dataclasses.field(default_factory=dict)

    @property
    def affected_count(self) -> int:
        return len(self.affected_labels or ())


# ---------------------------------------------------------------------------
# Background worker process — runs in a separate OS process (no GIL sharing)
# ---------------------------------------------------------------------------

_worker_static_index: StaticIndex | None = None
_worker_runtime: RuntimeInspection | None = None
_worker_model_graph: ModelGraph | None = None


@dataclass(frozen=True)
class _PreparedMessage:
    line: str
    encoding: str | None
    raw_size_kb: float
    profile_started: float
    json_ms: float
    compression_ms: float
    surface_snapshot: PreparedSurfaceSnapshot | None = None


@dataclass(frozen=True)
class _InitializedState:
    initialized_at: datetime
    source_snapshot: PythonSourceSnapshot
    workspace_profile: WorkspaceProfile
    static_index: StaticIndex
    model_graph: ModelGraph
    effective_settings_module: str | None
    runtime_source_fingerprint: str
    runtime_deferred: bool
    health_snapshot: dict[str, Any]
    model_names: list[str]
    surface_index: dict[str, object]
    surface_fingerprints: dict[str, str]
    custom_lookups: dict[str, list[str]]
    lookup_catalog: dict[str, object]
    custom_lookups_fingerprint: str
    static_fallback: dict[str, dict[str, object]] | None
    static_fallback_fingerprint: str | None
    source_membership_fingerprint: str | None = None
    source_provenance: dict[str, Any] | None = None


def _init_bg_worker(
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    model_graph: ModelGraph,
) -> None:
    """Called once per worker process to set up shared-nothing state."""
    global _worker_static_index, _worker_runtime, _worker_model_graph
    watch_parent_lifetime()
    _worker_static_index = static_index
    _worker_runtime = runtime
    _worker_model_graph = model_graph


def _init_bg_worker_from_file(path: str) -> None:
    watch_surface_pool_lifetime(path)
    static_index, runtime, model_graph = load_surface_worker_state(path)
    _init_bg_worker(static_index, runtime, model_graph)


def _bg_dispatch(method: str, params: dict[str, Any]) -> dict[str, Any]:
    """Execute a read-only IPC request inside a worker process.

    Returns a plain dict (must be picklable) that the main process
    will write to stdout.
    """
    si = _worker_static_index
    rt = _worker_runtime
    mg = _worker_model_graph
    if si is None or rt is None or mg is None:
        raise RuntimeError('Background worker not initialized')

    if method == 'resolveLookupPath':
        base = _clean_optional_string(params.get('baseModelLabel'))
        val = _clean_optional_string(params.get('value'))
        mth = _clean_optional_string(params.get('method'))
        if base is None or val is None or mth is None:
            raise ValueError('missing params for resolveLookupPath')
        return resolve_lookup_path(model_graph=mg, runtime=rt, base_model_label=base, path=val, method=mth)

    if method == 'resolveRelationTarget':
        val = _clean_optional_string(params.get('value'))
        if val is None:
            raise ValueError('missing value for resolveRelationTarget')
        return resolve_relation_target(model_graph=mg, value=val)

    if method == 'resolveExportOrigin':
        mod = _clean_optional_string(params.get('module'))
        sym = _clean_optional_string(params.get('symbol'))
        if mod is None or sym is None:
            raise ValueError('missing params for resolveExportOrigin')
        return resolve_export_origin(static_index=si, module_name=mod, symbol=sym)

    if method == 'resolveModule':
        mod = _clean_optional_string(params.get('module'))
        if mod is None:
            raise ValueError('missing module for resolveModule')
        return si.resolve_module(mod).to_dict()

    if method == 'resolveOrmMember':
        ml = _clean_optional_string(params.get('modelLabel'))
        rk = _clean_optional_string(params.get('receiverKind'))
        nm = _clean_optional_string(params.get('name'))
        mn = _clean_optional_string(params.get('managerName'))
        if ml is None or rk is None or nm is None:
            raise ValueError('missing params for resolveOrmMember')
        return resolve_orm_member(
            static_index=si,
            runtime=rt,
            model_graph=mg,
            model_label=ml,
            receiver_kind=rk,
            name=nm,
            manager_name=mn,
        )

    if method == 'resolveOrmMemberBatch':
        items = params.get('items', [])
        results = []
        for item in items:
            try:
                ml = _clean_optional_string(item.get('modelLabel'))
                rk = _clean_optional_string(item.get('receiverKind'))
                nm = _clean_optional_string(item.get('name'))
                mn = _clean_optional_string(item.get('managerName'))
                if ml is None or rk is None or nm is None:
                    results.append({'resolved': False, 'reason': 'missing_params'})
                    continue
                results.append(
                    resolve_orm_member(
                        static_index=si,
                        runtime=rt,
                        model_graph=mg,
                        model_label=ml,
                        receiver_kind=rk,
                        name=nm,
                        manager_name=mn,
                    )
                )
            except Exception:
                results.append({'resolved': False, 'reason': 'error'})
        return {'results': results, '_batch_size': len(items)}

    if method == 'resolveLookupPathBatch':
        items = params.get('items', [])
        results = []
        for item in items:
            try:
                base = _clean_optional_string(item.get('baseModelLabel'))
                val = _clean_optional_string(item.get('value'))
                mth = _clean_optional_string(item.get('method'))
                if base is None or val is None or mth is None:
                    results.append({'resolved': False, 'reason': 'missing_params'})
                    continue
                results.append(resolve_lookup_path(model_graph=mg, runtime=rt, base_model_label=base, path=val, method=mth))
            except Exception:
                results.append({'resolved': False, 'reason': 'error'})
        return {'results': results, '_batch_size': len(items)}

    if method == 'resolveOrmMemberChain':
        ml = _clean_optional_string(params.get('modelLabel'))
        rk = _clean_optional_string(params.get('receiverKind'))
        chain = params.get('chain')
        mn = _clean_optional_string(params.get('managerName'))
        if ml is None or rk is None or not isinstance(chain, list):
            raise ValueError('missing params for resolveOrmMemberChain')
        return resolve_orm_member_chain(
            static_index=si,
            runtime=rt,
            model_graph=mg,
            model_label=ml,
            receiver_kind=rk,
            chain=[str(n) for n in chain],
            manager_name=mn,
        )

    # lookupPathCompletions / ormMemberCompletions are now served by the
    # Rust fast-path + TS local fallback. The Python daemon no longer
    # generates bulk completion lists. Any IPC that reaches here means
    # neither local nor native path could answer — return an empty,
    # non-resolved result so the caller falls through to a no-op.
    if method == 'lookupPathCompletions':
        return {'items': [], 'resolved': False, 'reason': 'handled_by_native'}

    if method == 'ormMemberCompletions':
        ml = _clean_optional_string(params.get('modelLabel')) or ''
        rk = _clean_optional_string(params.get('receiverKind')) or ''
        mn = _clean_optional_string(params.get('managerName'))
        return {
            'items': [],
            'resolved': False,
            'reason': 'handled_by_native',
            'modelLabel': ml,
            'receiverKind': rk,
            'managerName': mn,
        }

    if method == 'relationTargets':
        prefix = _clean_optional_string(params.get('prefix'))
        return {'items': list_relation_targets(model_graph=mg, prefix=prefix)}

    raise ValueError(f'Unsupported background method: {method}')


def _bg_prebuild_surface_index(runtime_members_path: str | None = None) -> dict[str, object]:
    """Build the full surface index inside a background worker process."""
    si = _worker_static_index
    rt = _worker_runtime
    mg = _worker_model_graph
    if si is None or rt is None:
        raise RuntimeError('Background worker not initialized')
    if runtime_members_path is None:
        return prebuild_member_surface_cache(si, rt, mg)
    members = load_runtime_member_state(runtime_members_path)
    return prebuild_member_surface_cache(si, rt, mg, runtime_members=members)


def _bg_noop() -> None:
    """Warm a worker process so the first real BG request avoids spawn cost."""
    return None


class DaemonServer:
    def __init__(self, workspace_root: Path):
        self.workspace_root = workspace_root
        self.initialized_at = datetime.now(timezone.utc)
        self.health_snapshot: dict[str, Any] | None = None
        self.workspace_profile: WorkspaceProfile | None = None
        self.source_snapshot: PythonSourceSnapshot | None = None
        self.static_index: StaticIndex | None = None
        self.runtime_inspection: RuntimeInspection | None = None
        self.model_graph: ModelGraph | None = None
        self.semantic_graph: SemanticGraphSummary | None = None
        self._state_generation = 0
        self._state_lock = threading.RLock()
        self._write_lock = threading.Lock()
        self._init_lock = threading.Lock()
        # Save real stdout before any redirect so background process
        # callbacks always write to the correct fd.
        self._real_stdout = sys.stdout
        sys.stdout = sys.stderr
        self._bg_pool: DrainingProcessPool | None = None
        self._owned_bg_pools: weakref.WeakSet[DrainingProcessPool] = weakref.WeakSet()
        self._bg_pool_state_key: tuple[int, int, int] | None = None
        self._bg_pool_prewarm_token = 0
        self._bg_pool_capacity = 0
        self._fallback_bg_pool: ThreadPoolExecutor | None = None
        self._bg_metrics_lock = threading.Lock()
        self._bg_metrics: dict[str, dict[str, int]] = {
            'pool': {
                'submitted': 0,
                'completed': 0,
                'failed': 0,
                'inflight': 0,
                'peak': 0,
            },
            'fallback': {
                'submitted': 0,
                'completed': 0,
                'failed': 0,
                'inflight': 0,
                'peak': 0,
            },
        }
        self._last_surface_index: dict[str, object] | None = None
        self._editable_source_roots: tuple[Path, ...] = ()
        self._source_configuration_fingerprint: str | None = None
        self._fresh_configuration_runtime_generation: int | None = None
        self._source_root_aliases: tuple[tuple[str, str], ...] = ((str(workspace_root), str(workspace_root)),)
        self._last_surface_fingerprints: dict[str, str] | None = None
        self._surface_transport_enabled = False
        self._surface_transport = SurfaceSnapshotEncoder()
        self._last_model_names: list[str] | None = None
        self._last_static_fallback: dict[str, dict[str, object]] | None = None
        self._last_static_fallback_fingerprint: str | None = None
        self._last_custom_lookups_fingerprint: str | None = None
        self._last_lookup_fingerprint_state: tuple[object, object] | None = None
        self._surface_prebuild_future: Any | None = None
        self._surface_load_idle_timer: threading.Timer | None = None
        self._surface_publish_retry_timer: threading.Timer | None = None
        self._surface_publish_retry_generation: int | None = None
        self._surface_load_lock = threading.Lock()
        self._surface_load_attempted_generation: int | None = None
        # Source reindexes, so verification, surface prebuild or runtime warm-up
        # that started from older state can fold them in instead of
        # overwriting them. Candidate label → serial of the last reindex that
        # touched it.
        self._reindex_serial = 0
        self._last_reindex_commit_at = 0.0
        self._last_reindex_source: _RecentReindexSource | None = None
        self._reindexed_labels: dict[str, int] = {}
        # True once a model-changing reindex moved the static index away from
        # `source_snapshot`; caches keyed by that snapshot's fingerprint must
        # then not be written from the current state.
        self._source_snapshot_dirty = False
        # These keys belong to the validated initialize-time source owner.
        # Reindexes may still read its cache as a merge hint; they never stamp
        # current canonical paths onto that owner's older metadata.
        self._runtime_source_cache_fingerprint: str | None = None
        self._source_membership_fingerprint: str | None = None
        self._source_provenance: dict[str, Any] | None = None
        self._source_provenance_runtime_owned = False
        self._surface_source_complete = False
        self._stopping = threading.Event()
        self._registry_prewarm_request: tuple[int, RuntimeInspection, tuple[Path, ...], float] | None = None
        self._registry_prewarm_thread: threading.Thread | None = None
        self._registry_prewarm_start_lock = threading.Lock()
        self._runtime_member_refresh_token = 0
        self._runtime_member_ready_token = 0
        self._runtime_member_refresh_pending = False
        self._runtime_member_refresh_deadline = 0.0
        self._runtime_member_refresh_timer = None
        self._runtime_member_refresh_thread = None
        self._fresh_runtime_retry: tuple[int, threading.Timer] | None = None

    def run_stdio(self) -> None:
        threading.current_thread().name = 'main'

        with contextlib.ExitStack() as cleanup:
            try:
                for raw_line in sys.stdin:
                    line = raw_line.strip()
                    if not line:
                        continue

                    try:
                        request = json.loads(line)
                    except json.JSONDecodeError as error:
                        self._write_error(
                            request_id=None,
                            code='invalid_json',
                            message=str(error),
                            data={'raw': line},
                        )
                        continue

                    if not isinstance(request, dict):
                        self._write_error(
                            request_id=None,
                            code='invalid_request',
                            message='Request must be a JSON object.',
                        )
                        continue

                    # captain 옵션 6+ — daemon-side queue wait 측정. dispatch 진입 시점
                    # 을 박아두면 handler 가 실제 호출되기까지의 GIL/worker starvation
                    # 시간을 분리해서 노출 가능. 모든 resolveModule(typing.ClassVar)
                    # 가 정확히 2627ms 동일 시간에 끝났다는 captain 증거를 검증.
                    request['_dequeued_at'] = time.perf_counter()

                    if request.get('background'):
                        if (
                            self._bg_pool is None
                            and os.environ.get('DJLS_BG_PROCESS_POOL') == '1'
                        ):
                            self._rebuild_bg_pool()
                        if self._bg_pool is not None:
                            # Background requests → separate OS processes (no GIL).
                            self._submit_bg(request)
                        else:
                            # Keep foreground hover/completion responsive when process
                            # pools are unavailable (e.g. OS semaphore/disk limits).
                            self._submit_fallback_bg(request)
                    else:
                        # Foreground (hover, completion, initialize, reindexFile)
                        # → main thread for immediate response.
                        self._handle_request(request)
            finally:
                self._stopping.set()
                stop_deadline = time.monotonic() + 2.5
                with self._state_lock:
                    self._state_generation += 1
                    retry_timer = self._surface_publish_retry_timer
                    self._surface_publish_retry_timer = None
                    self._surface_publish_retry_generation = None
                    owned_pools = tuple(self._owned_bg_pools)
                # Register in reverse order so every cleanup is attempted even
                # if an earlier one fails; ExitStack retains exception context.
                if self._fallback_bg_pool is not None:
                    cleanup.callback(self._fallback_bg_pool.shutdown, wait=False)
                def wait_pool(pool):
                    pool.wait_closed(timeout=max(0.0, stop_deadline - time.monotonic()))
                for pool in owned_pools:
                    cleanup.callback(wait_pool, pool)
                if self._bg_pool is not None and self._bg_pool not in owned_pools:
                    cleanup.callback(self._bg_pool.shutdown, wait=False)
                def join_background(thread):
                    if thread is not threading.current_thread() and thread.is_alive():
                        thread.join(timeout=max(0.0, stop_deadline - time.monotonic()))
                for thread in (self._surface_prebuild_future, self._runtime_member_refresh_thread):
                    if thread is not None:
                        cleanup.callback(join_background, thread)
                for pool in owned_pools:
                    cleanup.callback(pool.shutdown, wait=False)
                cleanup.callback(self._cancel_runtime_member_refresh)
                cleanup.callback(self._cancel_surface_index_idle_load)
                if retry_timer is not None and retry_timer is not threading.current_thread():
                    cleanup.callback(retry_timer.cancel)

    # ------------------------------------------------------------------
    # Background process pool
    # ------------------------------------------------------------------

    def _discard_bg_pool(self) -> None:
        old = self._bg_pool
        self._bg_pool = None
        self._bg_pool_state_key = None
        self._bg_pool_prewarm_token += 1
        self._bg_pool_capacity = 0
        if old is not None:
            old.shutdown(wait=False)

    def _ensure_fallback_bg_pool(self) -> ThreadPoolExecutor:
        if self._fallback_bg_pool is None:
            self._fallback_bg_pool = ThreadPoolExecutor(
                max_workers=1,
                thread_name_prefix='fallback-bg',
            )
        return self._fallback_bg_pool

    def _rebuild_bg_pool(self) -> None:
        """Opt-in process pool for non-interactive background IPC.

        The default path deliberately avoids process workers: spawning Django
        state snapshots dominates cold start and can keep hundreds of MB alive.
        """
        if self._stopping.is_set() or os.environ.get('DJLS_BG_PROCESS_POOL') != '1':
            self._discard_bg_pool()
            return

        with self._state_lock:
            si = self.static_index
            rt = self.runtime_inspection
            mg = self.model_graph

        if si is None or rt is None or mg is None:
            self._discard_bg_pool()
            return

        state_key = (id(si), id(rt), id(mg))
        if self._bg_pool is not None and self._bg_pool_state_key == state_key:
            print(
                '[pool] ProcessPoolExecutor reused existing state',
                file=sys.stderr, flush=True,
            )
            return

        self._discard_bg_pool()

        worker_count = min(os.cpu_count() or 4, 8)
        state_scope = contextlib.ExitStack()
        pool = None
        try:
            path = state_scope.enter_context(persistent_worker_state_file(si, rt, mg))
            path = state_scope.enter_context(surface_pool_state_path(path, self._stopping))
            worker_context = state_scope.enter_context(guarded_spawn_context(self._stopping, path))
            executor = ProcessPoolExecutor(
                max_workers=worker_count,
                initializer=_init_bg_worker_from_file,
                initargs=(path,),
                mp_context=worker_context,
            )
            try:
                pool = DrainingProcessPool(executor, state_scope)
            except BaseException:
                executor.shutdown(wait=True)
                raise
            with self._state_lock:
                self._owned_bg_pools.add(pool)
                if (self._stopping.is_set() or state_key != (
                        id(self.static_index), id(self.runtime_inspection), id(self.model_graph))):
                    pool.shutdown(wait=False)
                    return
                self._bg_pool = pool
                self._bg_pool_state_key = state_key
                self._bg_pool_capacity = worker_count
            print(
                f'[pool] ProcessPoolExecutor created workers={worker_count}',
                file=sys.stderr, flush=True,
            )
            warm_count = min(worker_count, 2)
            if warm_count > 0 and os.environ.get('DJLS_BG_PROCESS_POOL_PREWARM') == '1':
                self._bg_pool_prewarm_token += 1
                self._start_bg_pool_prewarm(
                    pool=pool,
                    token=self._bg_pool_prewarm_token,
                    worker_count=warm_count,
                )
        except BaseException as exc:
            if pool is None:
                state_scope.close()
            elif pool is not self._bg_pool:
                pool.shutdown(wait=False)
            self._discard_bg_pool()
            if not isinstance(exc, Exception):
                raise
            print(
                f'[pool] ProcessPoolExecutor failed ({exc}), '
                f'background requests will run on fallback thread',
                file=sys.stderr, flush=True,
            )

    def _start_bg_pool_prewarm(
        self,
        *,
        pool: DrainingProcessPool,
        token: int,
        worker_count: int,
    ) -> None:
        def worker() -> None:
            started_at = time.perf_counter()
            try:
                with self._state_lock:
                    if (self._stopping.is_set() or self._bg_pool is not pool
                            or self._bg_pool_prewarm_token != token):
                        return
                # Submit all no-op tasks at once so ProcessPoolExecutor
                # spawns workers in parallel. Sequential submission
                # serialises the Python cold-start cost per worker
                # (observed ~2.7s × N on the captain workspace).
                futures = [pool.submit(_bg_noop) for _ in range(worker_count)]
                for future in futures:
                    future.result()
                print(
                    f'[pool] ProcessPoolExecutor prewarmed workers={worker_count} '
                    f'elapsed={time.perf_counter() - started_at:.2f}s',
                    file=sys.stderr,
                    flush=True,
                )
            except Exception as exc:
                print(
                    f'[pool] ProcessPoolExecutor prewarm skipped ({exc})',
                    file=sys.stderr,
                    flush=True,
                )

        threading.Thread(
            target=worker,
            name='bg-pool-prewarm',
            daemon=True,
        ).start()

    def _bg_capacity(self, worker_kind: str) -> int:
        if worker_kind == 'pool':
            return self._bg_pool_capacity
        if worker_kind == 'fallback':
            return 1
        return 0

    def _record_bg_submit(
        self,
        worker_kind: str,
        request_id: Any,
        method: Any,
        source: Any,
    ) -> None:
        with self._bg_metrics_lock:
            stats = self._bg_metrics[worker_kind]
            stats['submitted'] += 1
            stats['inflight'] += 1
            stats['peak'] = max(stats['peak'], stats['inflight'])
            inflight = stats['inflight']
            submitted = stats['submitted']
            completed = stats['completed']
            failed = stats['failed']
            peak = stats['peak']
            capacity = self._bg_capacity(worker_kind)
            total_inflight = sum(
                worker_stats['inflight']
                for worker_stats in self._bg_metrics.values()
            )
        queued_est = max(inflight - capacity, 0)
        running_est = inflight - queued_est
        _log_bg_queue(
            event='submit',
            worker=worker_kind,
            method=method,
            request_id=request_id,
            source=source,
            inflight=inflight,
            total_inflight=total_inflight,
            running_est=running_est,
            queued_est=queued_est,
            submitted=submitted,
            completed=completed,
            failed=failed,
            peak=peak,
        )

    def _record_bg_done(
        self,
        worker_kind: str,
        request_id: Any,
        method: Any,
        source: Any,
        *,
        ok: bool | None,
    ) -> None:
        with self._bg_metrics_lock:
            stats = self._bg_metrics[worker_kind]
            stats['inflight'] = max(stats['inflight'] - 1, 0)
            stats['completed'] += 1
            if ok is False:
                stats['failed'] += 1
            inflight = stats['inflight']
            submitted = stats['submitted']
            completed = stats['completed']
            failed = stats['failed']
            peak = stats['peak']
            capacity = self._bg_capacity(worker_kind)
            total_inflight = sum(
                worker_stats['inflight']
                for worker_stats in self._bg_metrics.values()
            )
        queued_est = max(inflight - capacity, 0)
        running_est = inflight - queued_est
        _log_bg_queue(
            event='done',
            worker=worker_kind,
            method=method,
            request_id=request_id,
            source=source,
            inflight=inflight,
            total_inflight=total_inflight,
            running_est=running_est,
            queued_est=queued_est,
            submitted=submitted,
            completed=completed,
            failed=failed,
            peak=peak,
            ok=ok,
        )

    def _submit_fallback_bg(self, request: dict[str, Any]) -> None:
        """Run background requests on a local thread when processes are unavailable."""
        request_id = request.get('id')
        method = request.get('method')
        source = request.get('source') or 'unknown'

        pool = self._ensure_fallback_bg_pool()
        future = pool.submit(self._handle_request, request)
        self._record_bg_submit('fallback', request_id, method, source)

        def _on_done(f: Any) -> None:
            self._record_bg_done(
                'fallback',
                request_id,
                method,
                source,
                ok=f.exception() is None,
            )

        future.add_done_callback(_on_done)

    def _submit_bg(self, request: dict[str, Any]) -> None:
        """Submit a request to the background process pool."""
        request_id = request.get('id')
        method = request.get('method')
        params = request.get('params') or {}
        source = request.get('source') or 'unknown'
        started = time.perf_counter()

        assert self._bg_pool is not None
        future = self._bg_pool.submit(_bg_dispatch, method, params)
        self._record_bg_submit('pool', request_id, method, source)

        def _on_done(f: Any) -> None:
            elapsed = time.perf_counter() - started
            ok = True
            try:
                result = f.result()
                batch_size = result.get('_batch_size') if isinstance(result, dict) else None
                item_count = None
                if isinstance(result, dict):
                    items = result.get('items')
                    if isinstance(items, list):
                        item_count = len(items)
                _log_ipc('bg', method, request_id, elapsed, True, source=source, batch_size=batch_size, item_count=item_count)
                if batch_size is not None:
                    result.pop('_batch_size', None)
                self._write_response(request_id, result)
            except Exception as exc:
                _log_ipc('bg', method, request_id, elapsed, True, source=source, error=True)
                self._write_error(
                    request_id=request_id,
                    code='internal_error',
                    message=str(exc),
                    data={'traceback': traceback.format_exc(limit=8)},
                )
                ok = False
            finally:
                self._record_bg_done('pool', request_id, method, source, ok=ok)

        future.add_done_callback(_on_done)

    def _handle_request(self, request: dict[str, Any]) -> None:
        request_id = request.get('id')
        method = request.get('method')
        params = request.get('params') or {}
        background = request.get('background', False)
        source = request.get('source') or 'unknown'
        # captain 옵션 6+ — queue wait + handler 본체 시간 분리.
        # _dequeued_at 은 read loop 에서 박힘 (background submit 직전).
        # handler entry 까지의 시간이 GIL/worker starvation 의 지표.
        dequeued_at = request.get('_dequeued_at')
        started = time.perf_counter()
        if isinstance(dequeued_at, (int, float)):
            queue_wait_ms = (started - dequeued_at) * 1000
            # 의미있는 wait (>=50ms) 만 emit — production noise 방지.
            if queue_wait_ms >= 50:
                print(
                    f'[ipc:queue-wait] {request_id} method={method} '
                    f'queue_wait={queue_wait_ms:.0f}ms background={background}',
                    file=sys.stderr, flush=True,
                )
        thread = threading.current_thread().name

        try:
            with contextlib.redirect_stdout(sys.stderr):
                if (
                    method in SURFACE_INDEX_ON_DEMAND_METHODS
                    and source != 'diagnostic'
                ):
                    self._request_surface_index_load(
                        reason=f'on_demand:{method}',
                    )
                if method == 'initialize':
                    result = self._initialize(params)
                elif method == 'health':
                    result = self._health()
                elif method == 'relationTargets':
                    result = self._relation_targets(params)
                elif method == 'resolveRelationTarget':
                    result = self._resolve_relation_target(params)
                elif method == 'resolveExportOrigin':
                    result = self._resolve_export_origin(params)
                elif method == 'resolveModule':
                    result = self._resolve_module(params)
                elif method == 'lookupPathCompletions':
                    result = self._lookup_path_completions(params)
                elif method == 'resolveLookupPath':
                    result = self._resolve_lookup_path(params)
                elif method == 'ormMemberCompletions':
                    result = self._orm_member_completions(params)
                elif method == 'resolveOrmMember':
                    result = self._resolve_orm_member(params)
                elif method == 'resolveOrmMemberBatch':
                    result = self._resolve_orm_member_batch(params)
                elif method == 'resolveLookupPathBatch':
                    result = self._resolve_lookup_path_batch(params)
                elif method == 'resolveOrmMemberChain':
                    result = self._resolve_orm_member_chain(params)
                elif method == 'reindexFile':
                    result = self._reindex_file(params)
                elif method == 'reindexSourceRoot':
                    result = self._reindex_source_root(params)
                elif method == 'reindexSourceDirectory':
                    result = self._reindex_source_directory(params)
                elif method == 'resyncSurfaceSnapshot':
                    result = self._resync_surface_snapshot()
                elif method == 'deletedSourceFiles':
                    result = self._deleted_source_files(params)
                else:
                    raise ValueError(f'Unsupported method: {method}')
        except Exception as error:  # pragma: no cover - scaffold safety net
            elapsed = time.perf_counter() - started
            _log_ipc(thread, method, request_id, elapsed, background, source=source, error=True)
            self._write_error(
                request_id=request_id,
                code='internal_error',
                message=str(error),
                data={'traceback': traceback.format_exc(limit=8)},
            )
            return

        elapsed = time.perf_counter() - started
        batch_size = result.get('_batch_size') if isinstance(result, dict) else None
        item_count = None
        if isinstance(result, dict):
            items = result.get('items')
            if isinstance(items, list):
                item_count = len(items)
        _log_ipc(thread, method, request_id, elapsed, background, source=source, batch_size=batch_size, item_count=item_count)
        if batch_size is not None:
            result.pop('_batch_size', None)
        if (method == 'initialize' and type(params.get('initializeSurfaceTransport')) is int
                and params['initializeSurfaceTransport'] == 1):
            self._write_initialize_response(request_id, result)
        else:
            self._write_response(request_id, result)

    def _initialize(self, params: dict[str, Any], *, observation_attempt: int = 0) -> dict[str, Any]:
        workspace_root = Path(
            str(params.get('workspaceRoot') or self.workspace_root)
        ).resolve()
        settings_module = _clean_optional_string(params.get('settingsModule'))
        defer_runtime = bool(params.get('deferRuntime'))
        initialized_at = datetime.now(timezone.utc)
        generation = self._reserve_state_generation(
            workspace_root=workspace_root,
            initialized_at=initialized_at,
        )
        with self._state_lock:
            self._surface_transport_enabled = params.get('surfaceSnapshotTransport') == 1
            self._surface_transport.reset()
        started_at = time.perf_counter()

        _log_initialize_step(
            'start '
            f'workspace={workspace_root} '
            f'settings={settings_module or "<unset>"} '
            f'defer_runtime={defer_runtime}'
        )
        # Resolve venv first so editable installs can be included in snapshot
        venv_info = resolve_venv_info(workspace_root)
        observation = None
        observation_fingerprint = None
        if params.get('sourceObservationTransport') == 1:
            observation, observation_fingerprint = source_observation_context(workspace_root, venv_info)
        with self._state_lock:
            if generation != self._state_generation:
                raise RuntimeError('Initialization belongs to an inactive source generation.')
            self._fresh_configuration_runtime_generation = (generation
                if observation_fingerprint is not None and self._source_configuration_fingerprint is not None else None)
            self._source_configuration_fingerprint = observation_fingerprint
        editable_roots: list[Path] = []
        if venv_info and venv_info.editable_installs:
            editable_roots = list(dict.fromkeys(Path(ei.path) for ei in venv_info.editable_installs))
            _log_initialize_step(
                f'editable_installs count={len(venv_info.editable_installs)} roots={len(editable_roots)} '
                f'paths={[str(p) for p in editable_roots]}'
            )
        # Cached source membership and timestamps are hints, not current
        # evidence. Verify before restoring static/runtime metadata so the
        # first response cannot expose fields deleted or changed while stopped.
        source_snapshot = snapshot_python_sources(
            workspace_root,
            extra_roots=editable_roots or None,
        )
        _log_initialize_step(
            f'verify_source_snapshot_before_initialize files={source_snapshot.file_count} elapsed={time.perf_counter() - started_at:.2f}s'
        )

        initialized_state = self._initialize_from_source_snapshot(
            generation=generation,
            initialized_at=initialized_at,
            workspace_root=workspace_root,
            settings_module=settings_module,
            defer_runtime=defer_runtime,
            venv_info=venv_info,
            source_snapshot=source_snapshot,
            started_at=started_at,
        )
        if initialized_state is None:
            raise RuntimeError('Initialization was superseded by a newer state.')

        if observation is not None:
            current_venv = resolve_venv_info(workspace_root)
            current_observation, current_fingerprint = source_observation_context(workspace_root, current_venv)
            if (current_fingerprint != observation_fingerprint
                    or current_venv != venv_info):
                if observation_attempt >= 2:
                    raise RuntimeError('Source configuration changed during initialization.')
                return self._initialize(params, observation_attempt=observation_attempt + 1)
            observation = current_observation

            with self._state_lock:
                if generation != self._state_generation:
                    raise RuntimeError('Initialization belongs to an inactive source generation.')

        if initialized_state.runtime_deferred:
            self._start_runtime_warmup(
                generation=generation,
                initialized_at=initialized_state.initialized_at,
                workspace_root=workspace_root,
                workspace_profile=initialized_state.workspace_profile,
                static_index=initialized_state.static_index,
                runtime_source_fingerprint=initialized_state.runtime_source_fingerprint,
                settings_module=initialized_state.effective_settings_module,
                source_snapshot=initialized_state.source_snapshot,
                source_membership=initialized_state.source_membership_fingerprint,
            )

        response = self._initialize_response(
            initialized_state,
            venv_info=venv_info,
        )
        if observation is not None:
            response['sourceObservationContext'] = observation
        return response

    def _initialize_from_source_snapshot(
        self,
        *,
        generation: int,
        initialized_at: datetime,
        workspace_root: Path,
        settings_module: str | None,
        defer_runtime: bool,
        venv_info: VenvInfo | None,
        source_snapshot: PythonSourceSnapshot,
        started_at: float,
        expected_reindex_serial: int | None = None,
        source_attempt: int = 0,
    ) -> _InitializedState | None:
        with self._state_lock:
            if (generation != self._state_generation or self._stopping.is_set()
                    or (expected_reindex_serial is not None and expected_reindex_serial != self._reindex_serial)):
                return None
            configuration_fingerprint = self._source_configuration_fingerprint
            fresh_runtime_generation = self._fresh_configuration_runtime_generation == generation
        try:
            source_membership = source_membership_fingerprint(source_snapshot)
        except (OSError, ValueError) as error:
            if source_attempt >= 2:
                raise RuntimeError('Workspace source membership kept changing during initialization.') from error
            editable_roots = list(dict.fromkeys(Path(entry.path) for entry in venv_info.editable_installs)) if venv_info else []
            current = snapshot_python_sources(workspace_root, extra_roots=editable_roots or None)
            return self._initialize_from_source_snapshot(
                generation=generation, initialized_at=initialized_at, workspace_root=workspace_root,
                settings_module=settings_module, defer_runtime=defer_runtime, venv_info=venv_info,
                source_snapshot=current, started_at=started_at,
                expected_reindex_serial=expected_reindex_serial, source_attempt=source_attempt + 1)
        verification_static_index = None
        verification_model_graph = None
        if expected_reindex_serial is not None:
            with self._state_lock:
                if generation != self._state_generation or expected_reindex_serial != self._reindex_serial:
                    return None
                verification_static_index = self.static_index
                verification_model_graph = self.model_graph
        workspace_profile = discover_workspace(
            workspace_root,
            settings_module,
            python_files=source_snapshot.files,
        )
        _log_initialize_step(
            'discover_workspace '
            f'manage_py={workspace_profile.manage_py_path or "<missing>"} '
            f'settings={workspace_profile.settings_module or "<unset>"} '
            f'candidates={len(workspace_profile.settings_candidates)} '
            f'elapsed={time.perf_counter() - started_at:.2f}s'
        )
        effective_settings_module = settings_module or workspace_profile.settings_module
        if venv_info:
            _log_initialize_step(
                f'resolve_venv_info root={venv_info.root} '
                f'python={venv_info.python_version or "<unknown>"} '
                f'site_packages={"yes" if venv_info.site_packages else "no"} '
                f'elapsed={time.perf_counter() - started_at:.2f}s'
            )
        editable_import_roots = ()
        if venv_info and venv_info.editable_installs:
            editable_source_roots = tuple(Path(entry.path) for entry in venv_info.editable_installs)
            imports = dict.fromkeys(os.path.abspath(entry) for entry in sys.path
                if type(entry) is str and entry
                and any(Path(os.path.abspath(entry)).is_relative_to(root) for root in editable_source_roots))
            editable_import_roots = tuple(imports)
        import_options = {'import_roots': editable_import_roots} if editable_import_roots else {}
        static_index, cache_hit_kind = load_cached_static_index(
            workspace_root,
            source_snapshot,
            **import_options,
        )
        if static_index is None:
            static_index = build_static_index(
                workspace_root,
                python_files=source_snapshot.files,
                **import_options,
            )
            _log_initialize_step(
                'build_static_index '
                f'files={static_index.python_file_count} '
                f'models={static_index.model_candidate_count} '
                f'reexports={static_index.reexport_module_count} '
                f'elapsed={time.perf_counter() - started_at:.2f}s'
            )
        elif cache_hit_kind == 'partial':
            _log_initialize_step(
                'load_cached_static_index(partial) '
                f'files={static_index.python_file_count} '
                f'models={static_index.model_candidate_count} '
                f'elapsed={time.perf_counter() - started_at:.2f}s'
            )
        else:
            _log_initialize_step(
                'load_cached_static_index(full) '
                f'files={static_index.python_file_count} '
                f'models={static_index.model_candidate_count} '
                f'elapsed={time.perf_counter() - started_at:.2f}s'
            )

        editable_roots = list(dict.fromkeys(Path(entry.path) for entry in venv_info.editable_installs)) if venv_info else []
        runtime_source_fingerprint = _runtime_source_fingerprint(
            source_snapshot=source_snapshot,
            static_index=static_index,
            settings_module=effective_settings_module,
            membership_fingerprint=source_membership,
            configuration_fingerprint=configuration_fingerprint,
        )
        source_provenance = capture_source_provenance(source_snapshot, source_membership,
            editable_roots, settings_module)
        runtime = load_cached_runtime_inspection(
            workspace_root,
            runtime_source_fingerprint,
            effective_settings_module,
        )
        runtime_cache_hit = runtime is not None

        # A runtime-cache miss is about to import the Django registry. Verify
        # source identity immediately before that import so loaded classes can
        # never be adopted under a newer source fingerprint. On an exact
        # runtime-cache hit this stage imports no project code; the final scan
        # below remains the freshness gate for the complete cached path.
        verified_snapshot = None
        if not runtime_cache_hit:
            verified_snapshot = snapshot_python_sources(
                workspace_root,
                extra_roots=editable_roots or None,
                previous_snapshot=source_snapshot,
            )
        with self._state_lock:
            if (generation != self._state_generation or self._stopping.is_set()
                    or (expected_reindex_serial is not None and expected_reindex_serial != self._reindex_serial)):
                return None
        if (verified_snapshot is not None
                and (verified_snapshot.fingerprint != source_snapshot.fingerprint
                    or not _source_membership_matches(verified_snapshot, source_membership))):
            if source_attempt >= 2:
                raise RuntimeError('Workspace sources kept changing during initialization; retry after edits settle.')
            _log_initialize_step(f'retry_changed_source_before_runtime attempt={source_attempt + 1}')
            return self._initialize_from_source_snapshot(
                generation=generation, initialized_at=initialized_at,
                workspace_root=workspace_root, settings_module=settings_module,
                defer_runtime=defer_runtime, venv_info=venv_info,
                source_snapshot=verified_snapshot, started_at=started_at,
                expected_reindex_serial=expected_reindex_serial, source_attempt=source_attempt + 1,
            )
        runtime_deferred = False
        should_save_runtime = False
        fresh_model_graph = None
        if runtime is None:
            if defer_runtime and can_defer_runtime_inspection(effective_settings_module):
                runtime = create_pending_runtime_inspection(
                    effective_settings_module
                )
                runtime_deferred = True
                _log_initialize_step(
                    'defer_runtime_inspection '
                    f'settings={effective_settings_module or "<unset>"} '
                    f'elapsed={time.perf_counter() - started_at:.2f}s'
                )
            else:
                if fresh_runtime_generation:
                    def current_runtime_owner():
                        with self._state_lock:
                            return (generation == self._state_generation and not self._stopping.is_set()
                                and (expected_reindex_serial is None or expected_reindex_serial == self._reindex_serial))
                    pending_runtime = create_pending_runtime_inspection(effective_settings_module)
                    fresh = refresh_in_process(static_index, pending_runtime,
                        build_model_graph(static_index, pending_runtime),
                        workspace_root, tuple(editable_roots), current_runtime_owner, self._stopping,
                        fresh_runtime=True)
                    if fresh is None or not current_runtime_owner():
                        return None
                    static_index, runtime, fresh_model_graph = fresh.static_index, fresh.runtime, fresh.model_graph
                    should_save_runtime = True
                else:
                    with current_workspace_source_imports((workspace_root, *editable_roots)):
                        runtime = inspect_runtime(effective_settings_module)
                should_save_runtime = expected_reindex_serial is None or runtime.bootstrap_status != 'ready'
                if fresh_model_graph is not None:
                    should_save_runtime = True
                _log_initialize_step(
                    'inspect_runtime '
                    f'status={runtime.bootstrap_status} '
                    f'django_importable={runtime.django_importable} '
                    f'elapsed={time.perf_counter() - started_at:.2f}s'
                )
        else:
            _log_initialize_step(
                'load_cached_runtime_inspection '
                f'status={runtime.bootstrap_status} '
                f'django_importable={runtime.django_importable} '
                f'elapsed={time.perf_counter() - started_at:.2f}s'
            )

        runtime_cache_fingerprint = _runtime_cache_fingerprint(runtime, source_fingerprint=runtime_source_fingerprint)
        should_save_model_graph = False
        if fresh_model_graph is not None:
            model_graph = fresh_model_graph
            model_graph_status = 'fresh_runtime_model_graph'
            should_save_model_graph = True
        elif verification_static_index is not None and verification_model_graph is not None:
            # A ready Django registry retains pre-save classes. Reconcile from
            # the live graph so source overrides and deletion tombstones survive
            # verification instead of restoring those stale runtime fields.
            labels = (set(verification_static_index._model_candidates_by_label)
                | set(static_index._model_candidates_by_label)
                | set(verification_model_graph.nodes_by_label)
                | {model.label for model in runtime.model_catalog})
            model_graph = rebuild_model_graph_for_labels(verification_model_graph,
                old_static_index=verification_static_index, static_index=static_index,
                runtime=runtime, affected_labels=labels)
            model_graph_status = 'reconcile_verified_model_graph'
        else:
            model_graph = load_cached_model_graph(
                workspace_root,
                source_fingerprint=source_snapshot.fingerprint,
                runtime_fingerprint=runtime_cache_fingerprint,
                static_index=static_index,
                runtime_inspection=runtime,
            )
            model_graph_status = 'load_cached_model_graph'
        if model_graph is None:
            should_save_model_graph = expected_reindex_serial is None
            if (runtime_cache_hit and runtime.bootstrap_status == 'ready' and defer_runtime
                    and can_defer_runtime_inspection(effective_settings_module)):
                from ..runtime.inspector import runtime_field_registry_is_ready
                if not runtime_field_registry_is_ready(effective_settings_module):
                    # A cached summary has no live fields for pk/attname and
                    # reverse aliases. Rebuilding a ready graph would prepare
                    # Django on this request. Use the ordinary pending state;
                    # its owned warmup rebuilds/persists the complete graph.
                    runtime = create_pending_runtime_inspection(effective_settings_module)
                    runtime_deferred = True
                    should_save_model_graph = False
                    _log_initialize_step('defer_graph_cache_miss '
                        f'settings={effective_settings_module} '
                        f'elapsed={time.perf_counter() - started_at:.2f}s')
            model_graph = build_model_graph(static_index, runtime)
            model_graph_status = 'build_model_graph'
        edge_count = sum(
            len(edges)
            for edges in model_graph.edges_by_source_label.values()
        )
        _log_initialize_step(
            f'{model_graph_status} '
            f'models={len(model_graph.nodes_by_label)} '
            f'edges={edge_count} '
            f'elapsed={time.perf_counter() - started_at:.2f}s'
        )

        semantic_graph = build_semantic_graph(workspace_profile, static_index, runtime)
        _log_initialize_step(
            'build_semantic_graph '
            f'coverage={semantic_graph.coverage_mode} '
            f'elapsed={time.perf_counter() - started_at:.2f}s'
        )
        health_snapshot = build_health_snapshot(
            workspace=workspace_profile,
            static_index=static_index,
            runtime=runtime,
            semantic_graph=semantic_graph,
            initialized_at=initialized_at,
        )

        # A complete warm cache can be sent once in the initial response,
        # avoiding an empty adoption followed by a second full publication.
        # Cold, verification and explicitly scheduled loads retain their
        # background path. The final source check below also covers this read
        # and the foreground owner's first-save preparation.
        surface_index: dict[str, object] = {}
        surface_fingerprints: dict[str, str] | None = None
        surface_index_status = 'defer_load_or_prebuild'
        surface_cache_hit = False
        cached_member_snapshot = None
        require_cached_members = runtime.bootstrap_status == 'ready' and bool(runtime.settings_module)
        if (expected_reindex_serial is None
                and cache_hit_kind == 'full'
                and runtime_cache_hit and runtime.bootstrap_status == 'ready'
                and model_graph_status == 'load_cached_model_graph'
                and self._surface_cache_load_mode() == 'idle'
                and 'DJLS_SURFACE_CACHE_IDLE_MS' not in os.environ
                and os.environ.get('DJLS_INLINE_CACHED_SURFACE') != '0'):
            cached_result = load_cached_surface_index(
                workspace_root,
                source_fingerprint=source_snapshot.fingerprint,
                runtime_fingerprint=runtime_cache_fingerprint,
                static_index=static_index,
                model_graph=model_graph,
                with_fingerprints=True,
                **({'with_runtime_members': True, 'runtime_inspection': runtime} if require_cached_members else {}),
            )
            if cached_result is not None:
                if isinstance(cached_result, tuple):
                    cached_surface, surface_fingerprints = cached_result[:2]
                    if len(cached_result) == 3:
                        cached_member_snapshot = cached_result[2]
                else:
                    # Keep compatibility with injected/older cache loaders.
                    cached_surface = cached_result
                # A legacy surface knows four-slot returns, but cannot answer
                # full runtime members before this process populates Django.
                # Rebuild it in the existing background path before publishing
                # a complete cached surface; never synthesize partial items.
                if not require_cached_members or cached_member_snapshot is not None:
                    prebuild_runtime_workspace_paths(static_index, runtime)
                    surface_index = cached_surface
                    surface_cache_hit = True
                    surface_index_status = 'load_cached_initialize'
                else:
                    # Fingerprints belong to the surface actually published,
                    # not to a legacy candidate discarded above.
                    surface_fingerprints = None
        should_schedule_surface_index_load = not runtime_deferred and not surface_cache_hit

        _log_initialize_step(
            f'{surface_index_status}_surface_index models={len(surface_index)} '
            f'elapsed={time.perf_counter() - started_at:.2f}s'
        )

        model_names = self._build_model_names(model_graph)
        if surface_fingerprints is None:
            surface_fingerprints = fingerprint_surface_index(surface_index)
        static_fallback = self._build_static_fallback(
            model_graph=model_graph,
            surface_index=surface_index,
        )
        static_fallback_fingerprint = (
            fingerprint_json_payload(static_fallback)
            if static_fallback
            else None
        )
        custom_lookups = runtime.custom_lookups if runtime else {}
        lookup_catalog = runtime.lookup_catalog if runtime else {}
        custom_lookups_fingerprint = fingerprint_json_payload([custom_lookups, lookup_catalog])

        # The final scan covers cache reads and response preparation. A fully
        # cached runtime has not imported project classes, so a source change
        # can still retry safely here; after a fresh runtime inspection starts,
        # reject changes because Django's registry may retain old classes.
        verified_snapshot = snapshot_python_sources(workspace_root, extra_roots=editable_roots or None,
            previous_snapshot=source_snapshot)
        with self._state_lock:
            if (generation != self._state_generation or self._stopping.is_set()
                    or (expected_reindex_serial is not None and expected_reindex_serial != self._reindex_serial)):
                return None
        # A symlink can switch between hardlinks with identical target stat
        # identities. Keep prepared runtime membership current as well as the
        # source bytes before adopting this owner's cached surface.
        if (verified_snapshot.fingerprint != source_snapshot.fingerprint
                or not _source_membership_matches(verified_snapshot, source_membership)
                or not runtime_workspace_paths_are_current(static_index)):
            if runtime_cache_hit:
                if source_attempt >= 2:
                    raise RuntimeError('Workspace sources kept changing during initialization; retry after edits settle.')
                _log_initialize_step(f'retry_changed_source_after_cached_runtime attempt={source_attempt + 1}')
                return self._initialize_from_source_snapshot(
                    generation=generation, initialized_at=initialized_at,
                    workspace_root=workspace_root, settings_module=settings_module,
                    defer_runtime=defer_runtime, venv_info=venv_info,
                    source_snapshot=verified_snapshot, started_at=started_at,
                    expected_reindex_serial=expected_reindex_serial, source_attempt=source_attempt + 1,
                )
            raise RuntimeError('Workspace sources changed during runtime initialization; restart to inspect current sources.')
        if fresh_runtime_generation:
            _observation, current_configuration = source_observation_context(workspace_root, resolve_venv_info(workspace_root))
            if current_configuration != configuration_fingerprint:
                return None
        # Build response metadata before publishing. A save must never observe
        # the new graph with the previous surface, or have its delta replaced
        # by response metadata built from the initialize-time graph.
        with self._state_lock:
            if not self._apply_state(
                generation=generation,
                initialized_at=initialized_at,
                source_snapshot=source_snapshot,
                workspace_profile=workspace_profile,
                static_index=static_index,
                runtime=runtime,
                model_graph=model_graph,
                semantic_graph=semantic_graph,
                health_snapshot=health_snapshot,
                expected_reindex_serial=expected_reindex_serial,
                runtime_source_fingerprint=runtime_source_fingerprint,
                source_membership=source_membership,
                source_provenance=source_provenance,
                source_extra_roots=tuple(editable_roots),
            ):
                return None
            self._last_surface_index = surface_index
            if fresh_model_graph is not None:
                self._source_provenance_runtime_owned = _runtime_can_publish_source_provenance(runtime)
            if cached_member_snapshot is not None and surface_cache_hit:
                install_runtime_members(static_index, runtime, model_graph, cached_member_snapshot)
            self._surface_source_complete = surface_cache_hit
            editable_paths = (Path(entry.path) for entry in venv_info.editable_installs) if venv_info else ()
            self._source_root_aliases = tuple((os.path.normpath(str(path)), str(path.resolve()))
                for path in dict.fromkeys((workspace_root, *editable_paths)))
            self._editable_source_roots = tuple(dict.fromkeys(Path(canonical)
                for raw, canonical in self._source_root_aliases if raw != str(workspace_root)))
            self._last_surface_fingerprints = surface_fingerprints
            self._last_model_names = model_names
            self._last_static_fallback = static_fallback
            self._last_static_fallback_fingerprint = static_fallback_fingerprint
            self._last_custom_lookups_fingerprint = custom_lookups_fingerprint
            self._last_lookup_fingerprint_state = (runtime.custom_lookups, runtime.lookup_catalog)
            if surface_cache_hit:
                with self._surface_load_lock:
                    self._surface_load_attempted_generation = generation
            self._discard_bg_pool()
        # Persist the prepared snapshots after adoption. Serialization must
        # not introduce a long gap between final verification and publication;
        # these local snapshots remain valid for their own fingerprint even
        # if a subsequent save advances the live state.
        if cache_hit_kind != 'full':
            save_static_index(workspace_root, source_snapshot, static_index)
            save_source_snapshot(workspace_root, source_snapshot, extra_roots=editable_roots or None)
        if should_save_runtime:
            save_runtime_inspection(workspace_root, runtime_source_fingerprint, effective_settings_module, runtime)
        if should_save_model_graph:
            save_model_graph(workspace_root, source_fingerprint=source_snapshot.fingerprint,
                runtime_fingerprint=runtime_cache_fingerprint, model_graph=model_graph)
        if should_schedule_surface_index_load:
            self._schedule_surface_index_idle_load(
                reason='initialize',
                expected_generation=generation,
            )
        # 옵션 A2 — runtime field registry 를 background 에서 미리 빌드.
        # captain 의 첫 resolveLookupPath IPC 2.8s 폭주가 lazy `django.setup()`
        # 때문 (옵션 6 분석 확정). initialize 응답 직전에 thread 시작 → 사용자가
        # 첫 IPC 보낼 무렵 ready. 안 ready 면 lock 에서 wait (1회만 손해).
        self._start_runtime_field_registry_prewarm(runtime, health_snapshot,
            source_roots=(workspace_root, *editable_roots), expected_generation=generation)
        if generation > 1:
            self._schedule_runtime_member_refresh()
        _log_initialize_step(
            f'complete elapsed={time.perf_counter() - started_at:.2f}s'
        )

        return _InitializedState(
            initialized_at=initialized_at,
            source_snapshot=source_snapshot,
            workspace_profile=workspace_profile,
            static_index=static_index,
            model_graph=model_graph,
            effective_settings_module=effective_settings_module,
            runtime_source_fingerprint=runtime_source_fingerprint,
            runtime_deferred=runtime_deferred,
            health_snapshot=health_snapshot,
            model_names=model_names,
            surface_index=surface_index,
            surface_fingerprints=surface_fingerprints,
            custom_lookups=custom_lookups,
            lookup_catalog=lookup_catalog,
            custom_lookups_fingerprint=custom_lookups_fingerprint,
            static_fallback=static_fallback,
            static_fallback_fingerprint=static_fallback_fingerprint,
            source_membership_fingerprint=source_membership,
            source_provenance=(source_provenance if surface_cache_hit
                and expected_reindex_serial is None and runtime.bootstrap_status == 'ready' else None),
        )

    def _initialize_response(
        self,
        initialized_state: _InitializedState,
        *,
        venv_info: VenvInfo | None,
    ) -> dict[str, Any]:
        return {
            'serverName': 'django-orm-intellisense',
            'protocolVersion': '0.1',
            'sourceProvenance': initialized_state.source_provenance,
            'health': initialized_state.health_snapshot,
            'modelNames': initialized_state.model_names,
            'surfaceIndex': initialized_state.surface_index,
            'surfaceFingerprints': initialized_state.surface_fingerprints,
            'customLookups': initialized_state.custom_lookups,
            'lookupCatalog': initialized_state.lookup_catalog,
            'customLookupsFingerprint': initialized_state.custom_lookups_fingerprint,
            'venvInfo': venv_info.to_dict() if venv_info else None,
            'staticFallback': initialized_state.static_fallback,
            'staticFallbackFingerprint': initialized_state.static_fallback_fingerprint,
        }

    def _surface_index_notification(
        self,
    ) -> dict[str, Any]:
        """Snapshot current metadata while the caller holds ``_state_lock``."""
        runtime = self.runtime_inspection
        return {
            'health': self.health_snapshot,
            'modelNames': self._last_model_names,
            'surfaceIndex': self._last_surface_index or {},
            'surfaceFingerprints': self._last_surface_fingerprints or {},
            'customLookups': runtime.custom_lookups if runtime else {},
            'lookupCatalog': runtime.lookup_catalog if runtime else {},
            'customLookupsFingerprint': self._last_custom_lookups_fingerprint,
            'staticFallback': self._last_static_fallback,
            'staticFallbackFingerprint': self._last_static_fallback_fingerprint,
            'runtimeMembersPending': self._runtime_members_pending(),
            'sourceProvenance': self._published_source_provenance(),
        }

    def _build_static_fallback(
        self,
        *,
        model_graph: ModelGraph,
        surface_index: dict[str, object],
    ) -> dict[str, dict[str, object]] | None:
        static_fallback: dict[str, dict[str, object]] = {}
        surface_labels = _surface_labels_with_instance_fields(surface_index)
        for node in model_graph.nodes_by_label.values():
            if node.label in surface_labels:
                continue
            entry = _static_fallback_entry(model_graph, node)
            if entry is not None:
                static_fallback[node.label] = entry
        return static_fallback if static_fallback else None

    def _build_model_names(self, model_graph: ModelGraph) -> list[str]:
        return sorted(model_graph.nodes_by_object_name.keys())

    def _surface_cache_load_mode(self) -> str:
        return (
            os.environ.get('DJLS_SURFACE_CACHE_LOAD_MODE')
            or 'idle'
        ).strip().lower()

    def _surface_cache_idle_delay_seconds(self) -> float:
        raw_ms = os.environ.get('DJLS_SURFACE_CACHE_IDLE_MS', '2000')
        try:
            return max(0.0, float(raw_ms) / 1000.0)
        except ValueError:
            return 2.0

    def _cancel_surface_index_idle_load(self) -> None:
        with self._surface_load_lock:
            timer = self._surface_load_idle_timer
            self._surface_load_idle_timer = None
        if timer is not None and timer is not threading.current_thread():
            timer.cancel()

    def _schedule_surface_index_idle_load(
        self,
        *,
        reason: str,
        expected_generation: int,
        idle_since: float | None = None,
    ) -> None:
        with self._state_lock:
            if expected_generation != self._state_generation or self._stopping.is_set():
                return
        mode = self._surface_cache_load_mode()
        if mode in {'0', 'off', 'false', 'disabled', 'none'}:
            _log_initialize_step(
                f'defer_surface_index_load reason={reason} mode=disabled'
            )
            return
        if mode in {'ondemand', 'on_demand', 'on-demand'}:
            _log_initialize_step(
                f'defer_surface_index_load reason={reason} mode=on_demand'
            )
            return
        if mode in {'eager', 'immediate'}:
            self._request_surface_index_load(
                reason=f'eager:{reason}',
                expected_generation=expected_generation,
            )
            return

        delay_seconds = self._surface_cache_idle_delay_seconds()
        with self._state_lock:
            if expected_generation != self._state_generation or self._stopping.is_set():
                return
            # A clean startup can spend the existing idle window doing the
            # runtime warmup. Edits retain a full interval from this trigger.
            if idle_since is not None and not self._source_snapshot_dirty:
                elapsed = max(0.0, time.perf_counter() - idle_since)
                delay_seconds = max(0.0, delay_seconds - elapsed)
            if delay_seconds > 0:
                with self._surface_load_lock:
                    if self._surface_load_attempted_generation == expected_generation:
                        return
                    if self._surface_prebuild_future is not None:
                        return
                    if self._surface_load_idle_timer is not None:
                        return

                    def _idle_load() -> None:
                        try:
                            self._request_surface_index_load(
                                reason=f'idle:{reason}',
                                expected_generation=expected_generation,
                            )
                        finally:
                            with self._surface_load_lock:
                                if self._surface_load_idle_timer is threading.current_thread():
                                    self._surface_load_idle_timer = None

                    timer = threading.Timer(delay_seconds, _idle_load)
                    timer.name = 'surface-index-idle-load-timer'
                    timer.daemon = True
                    self._surface_load_idle_timer = timer
                    timer.start()

        if delay_seconds <= 0:
            self._request_surface_index_load(
                reason=f'idle:{reason}',
                expected_generation=expected_generation,
            )
            return
        _log_initialize_step(
            f'defer_surface_index_load reason={reason} '
            f'mode=idle delay_ms={delay_seconds * 1000:.0f}'
        )

    def _request_surface_index_load(
        self,
        *,
        reason: str,
        expected_generation: int | None = None,
    ) -> None:
        with self._state_lock:
            generation = self._state_generation
            if expected_generation is not None and generation != expected_generation:
                return

        self._cancel_surface_index_idle_load()
        self._start_surface_index_prebuild_for_current_state(
            reason=reason,
            expected_generation=expected_generation,
        )

    def _start_surface_index_prebuild_for_current_state(
        self,
        *,
        reason: str,
        expected_generation: int | None = None,
    ) -> None:
        with self._state_lock:
            generation = self._state_generation
            if expected_generation is not None and generation != expected_generation:
                return
            workspace_root = self.workspace_root
            source_snapshot = self.source_snapshot
            static_index = self.static_index
            runtime = self.runtime_inspection
            health_snapshot = self.health_snapshot
            model_graph = self.model_graph
            reindex_serial = self._reindex_serial
            source_dirty = self._source_snapshot_dirty
            runtime_source_fingerprint = self._runtime_source_cache_fingerprint
            source_membership = self._source_membership_fingerprint

        if (
            source_snapshot is None
            or static_index is None
            or runtime is None
            or health_snapshot is None
            or model_graph is None
        ):
            return
        if runtime.bootstrap_status == 'warming_up':
            _log_initialize_step(
                f'skip_surface_index_load reason={reason} runtime=warming_up'
            )
            return

        self._start_surface_index_prebuild(
            generation=generation,
            workspace_root=workspace_root,
            source_snapshot=source_snapshot,
            static_index=static_index,
            runtime=runtime,
            model_graph=model_graph,
            reason=reason,
            reindex_serial=reindex_serial,
            source_dirty=source_dirty,
            runtime_source_fingerprint=runtime_source_fingerprint,
            source_membership=source_membership,
        )

    def _start_surface_index_prebuild(
        self,
        *,
        generation: int,
        workspace_root: Path,
        source_snapshot: PythonSourceSnapshot,
        static_index: StaticIndex,
        runtime: RuntimeInspection,
        model_graph: ModelGraph,
        reason: str,
        reindex_serial: int = 0,
        source_dirty: bool = False,
        runtime_source_fingerprint: str | None = None,
        source_membership: str | None = None,
    ) -> None:
        started_at = time.perf_counter()
        with self._state_lock:
            if self._stopping.is_set():
                return
            # Source fingerprints retain the spelling captured by this index,
            # independently of canonical watcher/reindex authorization roots.
            source_epoch = static_index._runtime_source_epoch
            editable_roots = (tuple(Path(root) for root in source_epoch.roots[1:])
                if source_epoch is not None else tuple(self._editable_source_roots))

        def _apply_surface_index(
            surface_index: dict[str, object],
            *,
            built_from_index: StaticIndex,
            expected_sources: PythonSourceSnapshot | None = None,
            from_cache: bool = False,
            surface_fingerprints: dict[str, str] | None = None,
            member_snapshot=None,
        ) -> bool:
            if surface_fingerprints is None:
                surface_fingerprints = fingerprint_surface_index(surface_index)
            # Derivation can be expensive, and can overlap an alias switch.
            # Reject stale membership before persistence as well as adoption.
            static_fallback = self._build_static_fallback(
                model_graph=model_graph,
                surface_index=surface_index,
            )
            if expected_sources is not None:
                current_sources = snapshot_python_sources(workspace_root,list(editable_roots),
                    previous_snapshot=expected_sources)
                if current_sources.fingerprint != expected_sources.fingerprint:
                    return False
            if not runtime_workspace_paths_are_current(built_from_index):
                return False
            if member_snapshot is not None:
                paths = built_from_index._workspace_source_paths or ()
                if any(item.file_path is not None and item.file_path not in paths
                        for values in member_snapshot.items.values() for item in values):
                    return False

            def superseded() -> bool:
                return (generation != self._state_generation or self._stopping.is_set()
                    or ((built_from_index is not static_index or member_snapshot is not None) and (
                        self.static_index is not static_index or self.runtime_inspection is not runtime
                        or self.model_graph is not model_graph or self._reindex_serial != reindex_serial)))

            with self._state_lock:
                if superseded():
                    return True
            # 옵션 D — cache 에서 로드한 경우 디스크 재기록 불필요. The prebuilt
            # surface only matches `source_snapshot` (the cache key) when no
            # model edit had been reindexed before the prebuild started.
            # Canonical aliases can change while the v2 stat hash stays equal.
            # Preserve the captured key; never recompute a new key for an old
            # runtime/surface at this delayed persistence boundary.
            sources_owned = False
            if not source_dirty and runtime_source_fingerprint is not None:
                try:
                    verified = snapshot_python_sources(workspace_root, list(editable_roots),
                        previous_snapshot=source_snapshot)
                    sources_owned = (verified.fingerprint == source_snapshot.fingerprint
                        and _source_membership_matches(verified, source_membership))
                except (OSError, ValueError):
                    pass
            if member_snapshot is not None and not sources_owned and expected_sources is None:
                return False
            if not from_cache and sources_owned:
                save_surface_index(
                    workspace_root,
                    source_fingerprint=source_snapshot.fingerprint,
                    runtime_fingerprint=_runtime_cache_fingerprint(runtime, source_fingerprint=runtime_source_fingerprint),
                    surface_index=surface_index,
                    surface_fingerprints=surface_fingerprints,
                    **({'runtime_members': member_snapshot} if member_snapshot is not None else {}),
                )
            if not runtime_workspace_paths_are_current(built_from_index):
                return False
            with self._state_lock:
                if superseded():
                    return True
                if built_from_index is not static_index:
                    # Only the unchanged state may adopt the repaired owner.
                    # Old requests retain their original immutable membership;
                    # new requests and process workers bind to the fresh one.
                    self.static_index = built_from_index
                    self._reindex_serial += 1
                    self._discard_bg_pool()
                    self._source_provenance_runtime_owned = False
                if member_snapshot is not None:
                    install_runtime_members(built_from_index, runtime, model_graph, member_snapshot)
                self._commit_loaded_surface_index(surface_index,
                    surface_fingerprints=surface_fingerprints, static_fallback=static_fallback,
                    built_from_static_index=built_from_index, built_from_model_graph=model_graph,
                    built_at_serial=reindex_serial)
                self._surface_source_complete = (sources_owned and built_from_index is static_index
                    and self.static_index is static_index and self.runtime_inspection is runtime
                    and self.model_graph is model_graph and self._reindex_serial == reindex_serial)
                with self._surface_load_lock:
                    self._surface_load_attempted_generation = generation
                model_count = len(self._last_surface_index or {})
            stage = 'load_cached' if from_cache else 'prebuild'
            _log_initialize_step(f'{stage}_surface_index(background) reason={reason} '
                f'models={model_count} elapsed={time.perf_counter() - started_at:.2f}s')
            self._publish_current_surface_snapshot(generation)
            return True

        def _log_failure() -> None:
            print(
                '[initialize] prebuild_surface_index(background) failed '
                f'{traceback.format_exc(limit=6)}',
                file=sys.stderr,
                flush=True,
            )

        def _background_worker() -> None:
            # 옵션 D — cache hit 시도가 main thread 의 1.68s 비용. background
            # thread 에서 시도하고 hit 면 즉시 apply (prebuild 안 함). miss 면
            # 기존 prebuild 경로(process pool 또는 inline) 로 fallback.
            try:
                if self._stopping.is_set():
                    return
                require_cached_members = runtime.bootstrap_status == 'ready' and bool(runtime.settings_module)
                member_snapshot = None
                pending_members = static_index._runtime_member_snapshot
                skip_catalog_cache = require_cached_members and (source_dirty
                    or pending_members is not None and pending_members.runtime_identity == (
                        runtime.python_executable, runtime.settings_module, runtime.django_version))
                cached_result = load_cached_surface_index(
                    workspace_root,
                    source_fingerprint=source_snapshot.fingerprint,
                    runtime_fingerprint=_runtime_cache_fingerprint(runtime, source_fingerprint=runtime_source_fingerprint),
                    static_index=static_index,
                    model_graph=model_graph,
                    with_fingerprints=True,
                    **({'with_runtime_members': True, 'runtime_inspection': runtime} if require_cached_members else {}),
                ) if runtime_source_fingerprint is not None and not skip_catalog_cache else None
                if isinstance(cached_result, tuple):
                    cached, cached_fingerprints = cached_result[:2]
                    if len(cached_result) == 3:
                        member_snapshot = cached_result[2]
                else:
                    cached, cached_fingerprints = cached_result, None
                if require_cached_members and member_snapshot is None:
                    cached, cached_fingerprints = None, None
                # cache miss — build the surface index off the main daemon
                # process so bulk lookup/member completions recover after a
                # restart WITHOUT a manual "Clear Cache & Reindex". Otherwise a
                # cache miss (e.g. after editing source, which invalidates the
                # source fingerprint) leaves surfaceIndex empty and workspace
                # models collapse to id/pk-only completions until the next
                # manual reindex. Set DJLS_SURFACE_PREBUILD_ON_MISS=0 to restore
                # the old lightweight skip-on-miss cold start.
                if cached is None and os.environ.get('DJLS_SURFACE_PREBUILD_ON_MISS') == '0':
                    with self._surface_load_lock:
                        self._surface_load_attempted_generation = generation
                    _log_initialize_step(
                        'skip_prebuild_surface_index(background) '
                        f'reason=cache_miss_optout trigger={reason} '
                        f'elapsed={time.perf_counter() - started_at:.2f}s'
                    )
                    return

                build_index = static_index
                for attempt in range(3):
                    owned_sources = None
                    if attempt:
                        # Give canonical membership a fresh owner. Preserve
                        # static records and rebase verified runtime records
                        # below without changing the previous owner.
                        previous_index = build_index
                        build_index = copy.copy(previous_index)
                        build_index._workspace_source_paths = None
                        build_index._workspace_source_paths_by_module = None
                        build_index._workspace_source_path_counts = None
                    prebuild_runtime_workspace_paths(build_index, runtime)
                    if runtime_workspace_paths_are_current(build_index):
                        previous_members = member_snapshot if member_snapshot is not None else (
                            previous_index._runtime_member_snapshot if attempt else None)
                        if attempt and previous_members is not None:
                            owned_sources = snapshot_python_sources(workspace_root,list(editable_roots))
                            epoch = previous_index._runtime_source_epoch
                            sources_match = (epoch.matches(owned_sources) if epoch is not None
                                else owned_sources.fingerprint == source_snapshot.fingerprint)
                            if not sources_match:
                                raise RuntimeError('Source changed since owned runtime members were captured.')
                            captured_owner = copy.copy(previous_index)
                            captured_owner._runtime_member_snapshot = previous_members
                            rebased = rebase_runtime_member_source_paths(captured_owner, build_index, runtime)
                            if member_snapshot is not None:
                                member_snapshot = rebased
                            else:
                                build_index._runtime_member_snapshot = rebased
                        if cached is not None:
                            from django_orm_intellisense.features.orm_members import log_surface_index_gap
                            log_surface_index_gap(build_index, model_graph, cached)
                            applied = _apply_surface_index(cached,built_from_index=build_index,
                                expected_sources=owned_sources,from_cache=True,surface_fingerprints=cached_fingerprints,
                                member_snapshot=member_snapshot)
                        else:
                            _log_initialize_step(
                                'prebuild_surface_index(background) start '
                                f'reason=cache_miss trigger={reason} '
                                f'elapsed={time.perf_counter() - started_at:.2f}s'
                            )
                            import_roots = (workspace_root, *(path.parent for path in source_snapshot.files
                                if not path.is_relative_to(workspace_root)))
                            with current_workspace_source_imports(import_roots):
                                owned = build_index._runtime_member_snapshot
                                if (require_cached_members and not source_dirty
                                        and not (owned is not None and owned.invalidated_labels)):
                                    if member_snapshot is None:
                                        if runtime_member_snapshot_is_complete(build_index, runtime, model_graph, owned):
                                            member_snapshot = owned
                                        else:
                                            member_snapshot = capture_current_runtime_members(build_index, runtime, model_graph,
                                                cancelled=lambda: (self._stopping.is_set() or generation != self._state_generation
                                                    or self.static_index is not static_index or self.runtime_inspection is not runtime
                                                    or self.model_graph is not model_graph or self._reindex_serial != reindex_serial))
                                            if member_snapshot is None:
                                                return
                                    runtime_members = member_snapshot.items
                                else:
                                    runtime_members = capture_runtime_member_surface(build_index,runtime,model_graph)
                            with runtime_member_state_file(runtime_members) as members_path:
                                with self._state_lock:
                                    pool = (self._bg_pool if self._bg_pool_state_key ==
                                        (id(build_index),id(runtime),id(model_graph)) else None)
                                if pool is not None:
                                    surface_index = pool.submit(_bg_prebuild_surface_index,members_path).result()
                                else:
                                    with surface_worker_state_file(build_index,runtime,model_graph) as state_path:
                                        with surface_pool_state_path(state_path, self._stopping) as owned_path:
                                            with guarded_spawn_context(self._stopping, owned_path) as worker_context:
                                                with ProcessPoolExecutor(max_workers=1,initializer=_init_bg_worker_from_file,
                                                        initargs=(owned_path,), mp_context=worker_context) as pool:
                                                    surface_index = pool.submit(_bg_prebuild_surface_index,members_path).result()
                            applied = _apply_surface_index(surface_index,built_from_index=build_index,
                                expected_sources=owned_sources, member_snapshot=member_snapshot)
                        if applied:
                            return
                    _log_initialize_step('retry_changed_runtime_workspace_paths(background) '
                        f'attempt={attempt + 1} trigger={reason}')
                raise RuntimeError('Runtime workspace paths kept changing during background surface preparation.')
            except Exception:
                if not self._stopping.is_set():
                    _log_failure()
            finally:
                with self._surface_load_lock:
                    if self._surface_prebuild_future is threading.current_thread():
                        self._surface_prebuild_future = None

        thread = threading.Thread(
            target=_background_worker,
            name='surface-index-load-or-prebuild',
            daemon=True,
        )
        with self._surface_load_lock:
            if self._surface_load_attempted_generation == generation:
                return
            if self._surface_prebuild_future is not None:
                return
            self._surface_prebuild_future = thread
        thread.start()

    def _publish_current_surface_snapshot(self, generation: int) -> None:
        for attempt in range(_SURFACE_PUBLISH_ATTEMPTS):
            with self._state_lock:
                if generation != self._state_generation or self._stopping.is_set():
                    return
                quiet_remaining = _SURFACE_PUBLISH_IDLE_SECONDS - (
                    time.perf_counter() - self._last_reindex_commit_at)
                if quiet_remaining > 0:
                    self._schedule_surface_snapshot_retry(generation, delay_seconds=quiet_remaining)
                    return
                serial = self._reindex_serial
                payload = self._surface_index_changed_payload()
                transport = self._surface_transport.prepare(payload) if self._surface_transport_enabled else None
            # Coalesce full snapshots during saves. Preparation/compression
            # hold neither the state nor the write lock; the final revision
            # check still rejects a save that lands during preparation.
            prepared = self._prepare_message({'event': 'surfaceIndexChanged',
                'params': transport.payload if transport is not None else payload})
            if transport is not None:
                prepared = dataclasses.replace(prepared, surface_snapshot=transport)
            with self._state_lock:
                if generation != self._state_generation or self._stopping.is_set():
                    return
                if serial != self._reindex_serial:
                    continue
                if transport is not None and not self._surface_transport.is_current(transport):
                    continue
                # Match existing state -> write lock ordering. Only the final
                # prepared line is written here; a save cannot commit between
                # this revision check and publication.
                self._write_notification('surfaceIndexChanged', payload, prepared_message=prepared)
                if serial == self._reindex_serial:
                    return
        self._schedule_surface_snapshot_retry(generation)

    def _schedule_surface_snapshot_retry(self, generation: int, *, delay_seconds: float = 0.05) -> None:
        with self._state_lock:
            if generation != self._state_generation or self._stopping.is_set():
                return
            timer = self._surface_publish_retry_timer
            if timer is not None and timer is not threading.current_thread():
                if self._surface_publish_retry_generation == generation:
                    return
                timer.cancel()
            def retry():
                try:
                    self._publish_current_surface_snapshot(generation)
                except Exception:
                    print('[surface:publish] retry failed ' + traceback.format_exc(limit=6),
                          file=sys.stderr, flush=True)
                finally:
                    with self._state_lock:
                        if self._surface_publish_retry_timer is threading.current_thread():
                            self._surface_publish_retry_timer = None
                            self._surface_publish_retry_generation = None
            timer = threading.Timer(delay_seconds, retry)
            timer.name = 'surface-snapshot-publication-retry'
            timer.daemon = True
            self._surface_publish_retry_timer = timer
            self._surface_publish_retry_generation = generation
            timer.start()

    def _commit_loaded_surface_index(
        self,
        surface_index: dict[str, object],
        *,
        surface_fingerprints: dict[str, str],
        static_fallback: dict[str, dict[str, object]] | None,
        built_from_static_index: StaticIndex,
        built_from_model_graph: ModelGraph,
        built_at_serial: int,
    ) -> None:
        """Adopt a loaded/prebuilt surface. Caller holds ``_state_lock``.

        ``surface_fingerprints`` / ``static_fallback`` were derived from the
        surface and graph the load started from. Models reindexed since then
        (a save during a long cold prebuild) are rebuilt against the current
        state first; otherwise the loaded surface would overwrite them and the
        edit would vanish from completion until the next save.
        """
        profile_adoption = os.environ.get('DJLS_PROFILE_SURFACE_ADOPTION') == '1'
        started = time.perf_counter() if profile_adoption else 0.0
        model_graph = self.model_graph or built_from_model_graph
        stale_labels = {
            label
            for label, serial in self._reindexed_labels.items()
            if serial > built_at_serial
        }
        if (
            stale_labels
            and self.static_index is not None
            and self.runtime_inspection is not None
        ):
            # Saves already published complete per-model entries against the
            # current state. Overlay those snapshots instead of resolving the
            # same methods/fields again while foreground requests wait.
            old_map = _build_static_to_graph_label_map(built_from_static_index, built_from_model_graph)
            new_map = _build_static_to_graph_label_map(self.static_index, model_graph)
            stale_keys = {mapping.get(label, label) for label in stale_labels
                          for mapping in (old_map, new_map)}
            surface_index = dict(surface_index)
            surface_fingerprints = dict(surface_fingerprints)
            for key in stale_keys:
                surface_index.pop(key, None)
                surface_fingerprints.pop(key, None)
            missing_labels = set()
            current_surface = self._last_surface_index or {}
            current_fingerprints = self._last_surface_fingerprints or {}
            for label in stale_labels:
                key = new_map.get(label, label)
                node = model_graph.node_for_model(key)
                if node is None or (node.model_candidate is not None and node.model_candidate.is_abstract):
                    continue
                if key in current_surface and key in current_fingerprints:
                    surface_index[key] = current_surface[key]
                    surface_fingerprints[key] = current_fingerprints[key]
                else:
                    # Runtime warm-up clears pending-runtime entries. Missing
                    # entries/fingerprints still use the general current-state
                    # resolver rather than trusting an older serialized row.
                    missing_labels.add(label)
            if missing_labels:
                surface_index, rebuilt_keys = _rebuild_surface_slice(
                    static_index=self.static_index,
                    runtime=self.runtime_inspection,
                    model_graph=model_graph,
                    labels=missing_labels,
                    surface_index=surface_index,
                    previous_static_index=built_from_static_index,
                    previous_model_graph=built_from_model_graph,
                )
                for key in rebuilt_keys:
                    surface_fingerprints.pop(key, None)
                surface_fingerprints.update(fingerprint_surface_index(
                    surface_index, labels=rebuilt_keys & surface_index.keys()))
        after_stale = time.perf_counter() if profile_adoption else 0.0
        if stale_labels or model_graph is not built_from_model_graph:
            static_fallback = self._build_static_fallback(
                model_graph=model_graph,
                surface_index=surface_index,
            )
        after_fallback = time.perf_counter() if profile_adoption else 0.0
        self._last_surface_index = surface_index
        self._last_surface_fingerprints = surface_fingerprints
        self._last_model_names = self._build_model_names(model_graph)
        self._last_static_fallback = static_fallback
        self._last_static_fallback_fingerprint = (
            fingerprint_json_payload(static_fallback)
            if static_fallback
            else None
        )
        if self.runtime_inspection is not None:
            self._refresh_lookup_fingerprint()
        if profile_adoption:
            finished = time.perf_counter()
            print('[surface:adopt] ' + json.dumps({
                'staleLabels': len(stale_labels),
                'staleSurfaceMs': (after_stale - started) * 1000,
                'fallbackMs': (after_fallback - after_stale) * 1000,
                'metadataMs': (finished - after_fallback) * 1000,
                'totalMs': (finished - started) * 1000,
            }), file=sys.stderr, flush=True)

    def _surface_index_changed_payload(self) -> dict[str, Any]:
        """Snapshot the published surface state. Caller holds ``_state_lock``."""
        runtime = self.runtime_inspection
        return {
            'health': self.health_snapshot,
            'modelNames': self._last_model_names or [],
            'surfaceIndex': self._last_surface_index or {},
            'surfaceFingerprints': self._last_surface_fingerprints or {},
            'customLookups': runtime.custom_lookups if runtime is not None else {},
            'lookupCatalog': runtime.lookup_catalog if runtime is not None else {},
            'customLookupsFingerprint': self._last_custom_lookups_fingerprint,
            'staticFallback': self._last_static_fallback,
            'staticFallbackFingerprint': self._last_static_fallback_fingerprint,
            'runtimeMembersPending': self._runtime_members_pending(),
            'sourceProvenance': self._published_source_provenance(),
        }

    def _published_source_provenance(self) -> dict[str, Any] | None:
        # No scanning or new stamping at publication. A delta, reconciled
        # registry or alias repair cannot inherit the initial owner's proof.
        if (self._source_snapshot_dirty or not self._source_provenance_runtime_owned
                or not self._surface_source_complete or self._runtime_members_pending()):
            return None
        return self._source_provenance

    def _refresh_lookup_fingerprint(self) -> None:
        runtime = self.runtime_inspection
        if runtime is None:
            return
        state = self._last_lookup_fingerprint_state
        # Published lookup metadata is read-only; catalogue updates replace
        # its dictionaries and advance the revision during reindex commit.
        if (self._last_custom_lookups_fingerprint is not None and state is not None
                and state[0] is runtime.custom_lookups and state[1] is runtime.lookup_catalog):
            return
        self._last_custom_lookups_fingerprint = fingerprint_json_payload(
            [runtime.custom_lookups, runtime.lookup_catalog])
        self._last_lookup_fingerprint_state = (runtime.custom_lookups, runtime.lookup_catalog)

    def _runtime_members_pending(self) -> bool:
        snapshot = getattr(self.static_index, '_runtime_member_snapshot', None)
        return (self._runtime_member_ready_token != self._runtime_member_refresh_token
            or bool(snapshot is not None and snapshot.invalidated_labels))

    def _cancel_runtime_member_refresh(self) -> None:
        with self._state_lock:
            self._runtime_member_refresh_token += 1
            self._runtime_member_ready_token = self._runtime_member_refresh_token
            self._runtime_member_refresh_pending = False
            timer = self._runtime_member_refresh_timer
            self._runtime_member_refresh_timer = None
            fresh_retry = self._fresh_runtime_retry
            self._fresh_runtime_retry = None
        if timer is not None:
            timer.cancel()
        if fresh_retry is not None:
            fresh_retry[1].cancel()

    def _schedule_runtime_member_refresh(self) -> None:
        with self._state_lock:
            runtime = self.runtime_inspection
            if (self._stopping.is_set() or self.static_index is None or self.model_graph is None
                    or runtime is None or runtime.bootstrap_status != 'ready' or not runtime.settings_module
                    or getattr(self.static_index, '_runtime_source_epoch', None) is None):
                return
            self._runtime_member_refresh_token += 1
            self._runtime_member_refresh_pending = True
            self._runtime_member_refresh_deadline = time.perf_counter() + 0.2
        self._arm_runtime_member_refresh_timer(delay_seconds=0.2)

    def _arm_runtime_member_refresh_timer(self, *, delay_seconds=None) -> None:
        with self._state_lock:
            if not self._runtime_member_refresh_pending or self._stopping.is_set():
                return
            token = self._runtime_member_refresh_token
            deadline = self._runtime_member_refresh_deadline
            old = self._runtime_member_refresh_timer
            self._runtime_member_refresh_timer = None
        if old is not None:
            old.cancel()
        delay = max(0, deadline - time.perf_counter()) if delay_seconds is None else delay_seconds
        timer = threading.Timer(delay, self._start_runtime_member_refresh, args=(token,))
        timer.daemon = True
        with self._state_lock:
            if (self._stopping.is_set() or not self._runtime_member_refresh_pending
                    or token != self._runtime_member_refresh_token
                    or self._runtime_member_refresh_timer is not None):
                timer.cancel()
                return
            self._runtime_member_refresh_timer = timer
        try:
            timer.start()
        except BaseException:
            with self._state_lock:
                if self._runtime_member_refresh_timer is timer:
                    self._runtime_member_refresh_timer = None
            timer.cancel()
            raise

    def _start_runtime_member_refresh(self, requested_token=None) -> None:
        with self._state_lock:
            if requested_token is not None and requested_token != self._runtime_member_refresh_token:
                return
            if (self._stopping.is_set() or not self._runtime_member_refresh_pending
                    or self._runtime_member_refresh_thread is not None):
                return
            self._runtime_member_refresh_timer = None
            token = self._runtime_member_refresh_token
            generation, serial = self._state_generation, self._reindex_serial
            static, runtime, graph = self.static_index, self.runtime_inspection, self.model_graph
            root = self.workspace_root
            source_epoch = getattr(static, '_runtime_source_epoch', None)
            extra_roots = (tuple(Path(path) for path in source_epoch.roots[1:])
                if source_epoch is not None else self._editable_source_roots)
            entered = threading.Event()
            def worker():
                with self._state_lock:
                    if self._runtime_member_refresh_thread is not threading.current_thread():
                        return
                    entered.set()
                self._refresh_runtime_members(token, generation, serial, static, runtime, graph, root, extra_roots)
            thread = threading.Thread(target=worker, daemon=True, name='runtime-member-refresh')
            if (self._stopping.is_set() or token != self._runtime_member_refresh_token
                    or self._runtime_member_refresh_thread is not None):
                return
            self._runtime_member_refresh_pending = False
            self._runtime_member_refresh_thread = thread
        try:
            thread.start()
        except BaseException:
            retry_latest = False
            with self._state_lock:
                if self._runtime_member_refresh_thread is thread and not entered.is_set():
                    self._runtime_member_refresh_thread = None
                    if not self._stopping.is_set():
                        if token == self._runtime_member_refresh_token:
                            self._runtime_member_refresh_pending = True
                        else:
                            retry_latest = self._runtime_member_refresh_pending
            # A newer save may have used its timer while this owner could not
            # start. Keep that save; do not spin retries for the failed token.
            if retry_latest:
                self._arm_runtime_member_refresh_timer()
            raise

    def _refresh_runtime_members(self, token, generation, serial, static, runtime, graph, root, extra_roots):
        def current():
            with self._state_lock:
                return (not self._stopping.is_set() and token == self._runtime_member_refresh_token
                    and generation == self._state_generation and serial == self._reindex_serial
                    and static is self.static_index and runtime is self.runtime_inspection
                    and graph is self.model_graph)
        started = time.perf_counter()
        try:
            if not current():
                return
            with self._state_lock:
                base_surface = self._last_surface_index or {}
                base_fingerprints = self._last_surface_fingerprints or {}
            epoch = getattr(static, '_runtime_source_epoch', None)
            before = snapshot_python_sources(root, list(extra_roots))
            sources_match = epoch is not None and epoch.matches(before)
            if not current():
                _log_initialize_step('runtime_members(background) discarded reason=superseded_before_capture')
                return
            if not sources_match:
                _log_initialize_step('runtime_members(background) rejected reason=source_changed_before_capture')
                return
            result = refresh_in_process(static, runtime, graph, root, extra_roots, current, self._stopping,
                frozenset(base_surface.keys() & base_fingerprints.keys()))
            if result is None or not current():
                return
            snapshot = result.snapshot
            after = snapshot_python_sources(root, list(extra_roots), previous_snapshot=before)
            if before.fingerprint != after.fingerprint or not epoch.matches(after) or not current():
                _log_initialize_step('runtime_members(background) rejected reason=source_changed_during_capture')
                return
            from .runtime_members import apply_runtime_graph_delta, compose_runtime_member_surface
            current_graph = apply_runtime_graph_delta(graph, getattr(result, 'graph_delta', None))
            surface, fingerprints = compose_runtime_member_surface(static, current_graph, result, base_surface, base_fingerprints)
            fallback = self._build_static_fallback(model_graph=current_graph, surface_index=surface)
            fallback_fingerprint = fingerprint_json_payload(fallback) if fallback else None
            lookup_delta = getattr(result, 'lookup_catalog_delta', None)
            current_runtime = runtime
            if lookup_delta:
                from ..runtime.lookup_catalog import apply_model_catalog_delta
                current_runtime = dataclasses.replace(runtime,
                    lookup_catalog=apply_model_catalog_delta(runtime.lookup_catalog, lookup_delta))
            with self._state_lock:
                if not current():
                    return
                recent_source = self._last_reindex_source
                if recent_source is not None and not recent_source.matches_owner(self):
                    recent_source = None
                self.model_graph = current_graph
                self.runtime_inspection = current_runtime
                install_runtime_members(static, current_runtime, current_graph, snapshot,
                    previous_runtime=runtime, previous_model_graph=graph)
                if lookup_delta:
                    self._last_custom_lookups_fingerprint = fingerprint_json_payload([
                        self._last_custom_lookups_fingerprint, lookup_delta])
                    self._last_lookup_fingerprint_state = (current_runtime.custom_lookups, current_runtime.lookup_catalog)
                self._runtime_member_ready_token = token
                static._runtime_source_epoch = RuntimeSourceEpoch.from_snapshot(after, extra_roots)
                self._last_surface_index = surface
                self._last_surface_fingerprints = fingerprints
                self._last_model_names = self._build_model_names(current_graph)
                self._last_static_fallback = fallback
                self._last_static_fallback_fingerprint = fallback_fingerprint
                self._refresh_health_snapshot(getattr(result, 'runtime_metadata', None))
                self._reindex_serial += 1
                self._last_reindex_commit_at = time.perf_counter()
                for label in static._model_candidates_by_label:
                    self._reindexed_labels[label] = self._reindex_serial
                if recent_source is not None:
                    # The verified capture changes runtime metadata, while
                    # the recent parse still owns the same static source.
                    # Keep the content/stat checks on its next duplicate.
                    self._last_reindex_source = dataclasses.replace(recent_source,
                        serial=self._reindex_serial, runtime=weakref.ref(current_runtime),
                        graph=weakref.ref(current_graph))
                self._discard_bg_pool()
            self._publish_current_surface_snapshot(generation)
            _log_initialize_step(f'runtime_members(background) ready models={len(surface)} '
                f'elapsed={time.perf_counter() - started:.2f}s')
        except Exception:
            _log_initialize_step('runtime_members(background) failed ' + traceback.format_exc(limit=6))
        finally:
            with self._state_lock:
                if self._runtime_member_refresh_thread is threading.current_thread():
                    self._runtime_member_refresh_thread = None
            self._arm_runtime_member_refresh_timer()

    def _start_runtime_field_registry_prewarm(
        self,
        runtime: RuntimeInspection,
        health_snapshot: dict[str, Any] | None = None,
        *,
        source_roots=None,
        expected_generation: int | None = None,
    ) -> None:
        """Prepare one current registry owner and publish only real availability."""
        if runtime.bootstrap_status != 'ready' or not runtime.settings_module:
            return
        if self._fresh_configuration_runtime_generation == self._state_generation:
            # This owner already carries records from the fresh worker; the
            # parent Django registry may still belong to the previous roots.
            return

        from ..runtime.inspector import _ensure_runtime_field_registry, runtime_field_registry_is_ready
        import_roots = tuple(source_roots) if source_roots is not None else (self.workspace_root,)

        def cancelled(request) -> bool:
            return (self._stopping.is_set() or request is not self._registry_prewarm_request
                or request[0] != self._state_generation)

        def _bg_prewarm() -> None:
            try:
                while True:
                    with self._state_lock:
                        request = self._registry_prewarm_request
                        if request is None or self._stopping.is_set():
                            self._registry_prewarm_request = None
                            self._registry_prewarm_thread = None
                            return
                    generation, inspection, roots, started = request
                    try:
                        if cancelled(request):
                            continue
                        with current_workspace_source_imports(roots):
                            _ensure_runtime_field_registry(inspection.settings_module,
                                cancelled=lambda: cancelled(request))
                        with self._state_lock:
                            current_runtime = self.runtime_inspection
                            if (cancelled(request) or current_runtime is None
                                    or current_runtime.bootstrap_status != 'ready'
                                    or current_runtime.python_executable != inspection.python_executable
                                    or current_runtime.settings_module != inspection.settings_module
                                    or current_runtime.django_version != inspection.django_version):
                                continue
                            if not runtime_field_registry_is_ready(inspection.settings_module):
                                _log_initialize_step('runtime_field_registry(background) unavailable')
                                continue
                            elapsed_ms = (time.perf_counter() - started) * 1000
                            _log_initialize_step('runtime_field_registry(background) ready '
                                f'elapsed={elapsed_ms:.0f}ms')
                            # Retire pre-registry client misses only after actual
                            # availability. Publish current save diagnostics in
                            # the same order as surface commits.
                            snapshot = self.health_snapshot
                            if snapshot is not None:
                                with contextlib.suppress(Exception):
                                    self._write_notification('healthChanged', {'health': snapshot})
                    except Exception:
                        if not cancelled(request):
                            with contextlib.suppress(Exception):
                                print('[initialize] runtime_field_registry(background) failed '
                                    f'{traceback.format_exc(limit=6)}',file=sys.stderr,flush=True)
                    finally:
                        with self._state_lock:
                            if self._registry_prewarm_request is request:
                                self._registry_prewarm_request = None
            finally:
                with self._state_lock:
                    if self._registry_prewarm_thread is thread:
                        self._registry_prewarm_thread = None

        # Serialize only thread creation, outside the state lock. If creation
        # fails, a concurrent request must observe the retired worker and start
        # its own rather than being cleared as part of the failed request.
        with self._registry_prewarm_start_lock:
            with self._state_lock:
                generation = self._state_generation if expected_generation is None else expected_generation
                if generation != self._state_generation or self._stopping.is_set():
                    return
                self._registry_prewarm_request = (generation,runtime,import_roots,time.perf_counter())
                if self._registry_prewarm_thread is not None:
                    return
                thread = threading.Thread(target=_bg_prewarm,
                    name='runtime-field-registry-prewarm',daemon=True)
                self._registry_prewarm_thread = thread
            try:
                thread.start()
            except BaseException:
                with self._state_lock:
                    if self._registry_prewarm_thread is thread:
                        self._registry_prewarm_thread = None
                        self._registry_prewarm_request = None
                raise

    def _start_source_snapshot_verification(
        self,
        *,
        generation: int,
        workspace_root: Path,
        settings_module: str | None,
        venv_info: VenvInfo | None,
        editable_roots: list[Path],
        initialized_state: _InitializedState,
    ) -> None:
        with self._state_lock:
            if self._stopping.is_set() or generation != self._state_generation:
                return
        verification_thread = threading.Thread(
            target=self._verify_source_snapshot_state,
            kwargs={
                'generation': generation,
                'workspace_root': workspace_root,
                'settings_module': settings_module,
                'venv_info': venv_info,
                'editable_roots': editable_roots,
                'initialized_state': initialized_state,
            },
            daemon=True,
            name='django-orm-intellisense-source-snapshot-verify',
        )
        verification_thread.start()

    def _verify_source_snapshot_state(
        self,
        *,
        generation: int,
        workspace_root: Path,
        settings_module: str | None,
        venv_info: VenvInfo | None,
        editable_roots: list[Path],
        initialized_state: _InitializedState,
    ) -> None:
        with self._state_lock:
            if generation != self._state_generation:
                return
            reindex_serial = self._reindex_serial
        verify_started_at = time.perf_counter()
        verified_snapshot = self._snapshot_sources_for_verification(workspace_root, editable_roots)
        snapshot_changed = (
            verified_snapshot.fingerprint
            != initialized_state.source_snapshot.fingerprint
        )
        with self._state_lock:
            if generation != self._state_generation:
                return
        _log_initialize_step(
            'verify_cached_source_snapshot '
            f'status={"changed" if snapshot_changed else "unchanged"} '
            f'files={verified_snapshot.file_count} '
            f'elapsed={time.perf_counter() - verify_started_at:.2f}s'
        )
        if not snapshot_changed:
            if initialized_state.runtime_deferred:
                self._start_runtime_warmup(
                    generation=generation,
                    initialized_at=initialized_state.initialized_at,
                    workspace_root=workspace_root,
                    workspace_profile=initialized_state.workspace_profile,
                    static_index=initialized_state.static_index,
                    runtime_source_fingerprint=initialized_state.runtime_source_fingerprint,
                    settings_module=initialized_state.effective_settings_module,
                    source_snapshot=initialized_state.source_snapshot,
                    source_membership=initialized_state.source_membership_fingerprint,
                )
            return

        refreshed_at = datetime.now(timezone.utc)
        refreshed_generation = self._reserve_state_generation(
            workspace_root=workspace_root,
            initialized_at=refreshed_at,
            expected_generation=generation,
            expected_reindex_serial=reindex_serial,
        )
        if refreshed_generation is None:
            self._retry_source_snapshot_verification(
                generation=generation, workspace_root=workspace_root,
                settings_module=settings_module, venv_info=venv_info,
                editable_roots=editable_roots, initialized_state=initialized_state,
            )
            return
        save_source_snapshot(
            workspace_root,
            verified_snapshot,
            extra_roots=editable_roots or None,
        )
        refreshed_state = self._initialize_from_source_snapshot(
            generation=refreshed_generation,
            initialized_at=refreshed_at,
            workspace_root=workspace_root,
            settings_module=settings_module,
            defer_runtime=False,
            venv_info=venv_info,
            source_snapshot=verified_snapshot,
            started_at=time.perf_counter(),
            expected_reindex_serial=reindex_serial,
        )
        if refreshed_state is None:
            self._retry_source_snapshot_verification(
                generation=refreshed_generation, workspace_root=workspace_root,
                settings_module=settings_module, venv_info=venv_info,
                editable_roots=editable_roots, initialized_state=initialized_state,
            )
            return

        with self._state_lock:
            if refreshed_generation != self._state_generation:
                return
            self._write_notification('surfaceIndexChanged', self._surface_index_notification())
            _log_initialize_step('refresh_cached_source_snapshot applied')

    def _snapshot_sources_for_verification(
        self, workspace_root: Path, editable_roots: list[Path],
    ) -> PythonSourceSnapshot:
        try:
            # Scanning and fingerprinting thousands of paths in a background
            # thread still competes with saves for the GIL. A short-lived,
            # single worker keeps that CPU work outside the request process.
            with guarded_spawn_context(self._stopping) as worker_context:
                with ProcessPoolExecutor(max_workers=1, mp_context=worker_context) as pool:
                    return pool.submit(snapshot_python_sources, workspace_root,
                        extra_roots=editable_roots or None, max_workers=1).result()
        except (OSError, RuntimeError) as error:
            _log_initialize_step(f'verify_source_snapshot_process unavailable={type(error).__name__} fallback=thread')
            return snapshot_python_sources(workspace_root, extra_roots=editable_roots or None, max_workers=1)

    def _retry_source_snapshot_verification(self, **kwargs: Any) -> None:
        with self._state_lock:
            if kwargs['generation'] != self._state_generation:
                return
        # Saves may land during the scan or refresh. Keep serving the newer
        # index and retry from disk after the burst instead of publishing an
        # older snapshot or abandoning verification of the remaining files.
        retry = threading.Timer(0.2, self._start_source_snapshot_verification, kwargs=kwargs)
        retry.daemon = True
        retry.start()

    def _deleted_source_files(self, params: dict[str, Any]) -> dict[str, Any]:
        value = params.get('filePath')
        if not value:
            return {'error': 'filePath is required'}
        with self._state_lock:
            index = self.static_index
            editable_roots = self._editable_source_roots
            workspace_root = self.workspace_root
            root_aliases = self._source_root_aliases
        deleted_path = _source_event_path(value, (workspace_root, *editable_roots))
        if index is None:
            return {'error': 'not initialized'}
        if not deleted_path.is_relative_to(workspace_root) and not any(
                deleted_path.is_relative_to(root) for root in editable_roots):
            return {'error': 'file outside workspace'}
        if deleted_path.exists():
            return {'filePaths': []}
        # Normal Python deletions need one module lookup, including aliases.
        if deleted_path.suffix == '.py':
            name = _module_name_for_reindex(workspace_root, deleted_path, index)
            module = index.modules.get(name)
            if module is not None and _source_event_path(module.file_path) == deleted_path:
                return {'filePaths': [str(deleted_path)]}
        # VS Code may collapse a directory deletion to one parent event.
        # Filter known paths in memory; do not recursively read the filesystem.
        prefix = str(deleted_path) + os.sep
        prefixes = {prefix}
        for raw, canonical in root_aliases:
            if str(deleted_path) == canonical or str(deleted_path).startswith(canonical + os.sep):
                prefixes.add(raw + str(deleted_path)[len(canonical):] + os.sep)
        # Only matching files need canonicalization; unrelated files must not
        # pay filesystem resolution costs when the surface cache is still cold.
        affected = {str(Path(module.file_path).resolve()) for module in index.modules.values()
            if module.file_path and any(os.path.normpath(module.file_path).startswith(value) for value in prefixes)}
        for relative in index.unparseable_files.keys() | index.shadowed_files.keys():
            file = str(workspace_root / relative)
            if file == str(deleted_path) or file.startswith(prefix):
                affected.add(file)
        return {'filePaths': sorted(file for file in affected if not Path(file).exists())}

    def _try_duplicate_reindex(self, file_path: Path) -> dict[str, Any] | None:
        with self._state_lock:
            cached = self._last_reindex_source
            if cached is None or cached.path != file_path:
                return None
            if not cached.matches_owner(self):
                return None
        before, reliable = source_identity(file_path)
        if not reliable or before != cached.identity:
            return None
        # Re-parse if a sibling module/package appeared since the original
        # parse. The parser only records a fingerprint outside collisions.
        sibling = (Path(str(file_path.parent) + '.py') if file_path.name == '__init__.py'
            else file_path.with_suffix('') / '__init__.py')
        if sibling.is_relative_to(self.workspace_root) and sibling.exists():
            return None
        try:
            fingerprint = hashlib.sha256(file_path.read_bytes()).digest()
        except OSError:
            return None
        after, reliable = source_identity(file_path)
        if not reliable or before != after or fingerprint != cached.fingerprint:
            return None
        with self._state_lock:
            if not cached.matches_owner(self):
                return None
            refresh_active = self._runtime_member_refresh_pending or self._runtime_member_refresh_thread is not None
        # An unchanged source must not cancel the current verified capture.
        # With no capture active, retain the normal refresh/recovery request.
        if not refresh_active:
            self._schedule_runtime_member_refresh()
        result = {'unchanged': True, 'sourceUnchanged': True}
        with self._state_lock:
            if self._runtime_members_pending():
                result['runtimeMembersPending'] = True
        return result

    def _reindex_source_directory(self, params: dict[str, Any]) -> dict[str, Any]:
        return self._reindex_source_root(params, allow_directory=True)

    def _reindex_source_root(self, params: dict[str, Any], *, allow_directory: bool = False) -> dict[str, Any]:
        """Reconcile a declared source root in one source-verified transaction."""
        value = params.get('filePath')
        if not value:
            return {'error': 'filePath is required'}
        with self._state_lock:
            generation, serial = self._state_generation, self._reindex_serial
            workspace_root = self.workspace_root
            aliases = self._source_root_aliases
            static_index, runtime = self.static_index, self.runtime_inspection
            graph, surface = self.model_graph, self._last_surface_index
            fallback = self._last_static_fallback
        if static_index is None:
            return {'error': 'not initialized'}
        root = _source_event_path(value, (workspace_root, *self._editable_source_roots))
        declared_roots = tuple(Path(canonical) for raw, canonical in aliases)
        if allow_directory and not any(root.is_relative_to(parent) for parent in declared_roots):
            return {'error': 'directory outside declared source roots'}
        if not allow_directory and root not in declared_roots:
            return {'error': 'not a declared source root'}

        def roots_current():
            return all(str(Path(raw).resolve()) == canonical for raw, canonical in aliases)

        if not roots_current():
            return {'error': 'source root mapping changed'}
        root_before = _source_root_identity(root)
        source_roots = tuple(Path(raw) for raw, canonical in aliases if raw != str(workspace_root))
        before = _strict_source_snapshot(workspace_root, source_roots)
        membership = source_membership_fingerprint(before)
        # All source files participate, including helper modules. A cold
        # static build preserves import order, package collisions and aliases
        # without rebuilding global structures once per restored file.
        updated = build_static_index(workspace_root, python_files=before.files,
            import_roots=getattr(static_index, '_source_import_roots', ()))
        edited_modules = set()
        for name in static_index.modules.keys() | updated.modules.keys():
            old, new = static_index.modules.get(name), updated.modules.get(name)
            # ModuleIndex equality intentionally omits source declarations.
            # Their full source hash also catches method bodies, managers and
            # helpers whose exported names and resolved fields did not change.
            if (old != new or getattr(old, 'source_member_declarations', None)
                    != getattr(new, 'source_member_declarations', None)):
                edited_modules.add(name)
        outcome = self._compute_reindex_from_static(
            static_index=static_index, new_static_index=updated, runtime=runtime,
            previous_model_graph=graph, existing_surface=surface or {},
            previous_static_fallback=fallback,
            affected_labels={candidate.label for index in (static_index, updated)
                for name in edited_modules if (module := index.modules.get(name)) is not None
                for candidate in module.model_candidates},
            edited_modules=edited_modules)
        after = _strict_source_snapshot(workspace_root, source_roots)
        if (before != after or before._file_identities != after._file_identities
                or membership != source_membership_fingerprint(after)
                or root_before != _source_root_identity(root) or not roots_current()):
            return {'error': 'source changed during root reconciliation'}
        updated._runtime_source_epoch = RuntimeSourceEpoch.from_snapshot(after, source_roots)
        with self._state_lock:
            if (self._stopping.is_set() or generation != self._state_generation or serial != self._reindex_serial
                    or self.workspace_root != workspace_root or self._source_root_aliases != aliases
                    or self.static_index is not static_index or self.runtime_inspection is not runtime
                    or self.model_graph is not graph or self._last_surface_index is not surface):
                return {'error': 'source root reconciliation was superseded'}
            result = self._commit_reindex(outcome)
            self._last_reindex_source = None
        self._schedule_runtime_member_refresh()
        if self._runtime_members_pending():
            result['runtimeMembersPending'] = True
        return result

    def _reindex_file(self, params: dict[str, Any]) -> dict[str, Any]:
        file_path_str = params.get('filePath')
        if not file_path_str:
            return {'error': 'filePath is required'}

        with self._state_lock:
            if self.static_index is None:
                return {'error': 'not initialized'}
            editable_roots = self._editable_source_roots
            workspace_root = self.workspace_root

        file_path = _source_event_path(file_path_str, (workspace_root, *editable_roots))

        # Verify file is within workspace
        try:
            file_path.relative_to(workspace_root)
        except ValueError:
            if not any(file_path.is_relative_to(root) for root in editable_roots):
                return {'error': 'file outside workspace'}

        started = time.perf_counter()
        duplicate = self._try_duplicate_reindex(file_path)
        if duplicate is not None:
            print(f'[PERF] reindexFile: source duplicate {time.perf_counter() - started:.3f}s', file=sys.stderr)
            return duplicate
        # Compute from a snapshot, then commit only if the state is still the
        # one we started from. Runtime warm-up and surface loads replace the
        # graph/runtime/surface on background threads; committing a result
        # computed from the pre-warm-up state would put the static-only graph
        # and pending-runtime surface back. The last attempt holds the lock
        # throughout so the reindex always lands.
        for attempt in range(_REINDEX_COMMIT_ATTEMPTS):
            last_attempt = attempt == _REINDEX_COMMIT_ATTEMPTS - 1
            with self._state_lock if last_attempt else contextlib.nullcontext():
                with self._state_lock:
                    generation = self._state_generation
                    static_index = self.static_index
                    runtime = self.runtime_inspection
                    previous_model_graph = self.model_graph
                    surface_ref = self._last_surface_index
                    previous_static_fallback = self._last_static_fallback
                    source_aliases = self._source_root_aliases
                if static_index is None:
                    return {'error': 'not initialized'}

                source_before, before_reliable = source_identity(file_path)
                outcome = self._compute_reindex(
                    file_path=file_path,
                    static_index=static_index,
                    runtime=runtime,
                    previous_model_graph=previous_model_graph,
                    existing_surface=surface_ref or {},
                    previous_static_fallback=previous_static_fallback,
                )
                source_after, after_reliable = source_identity(file_path)
                epoch = getattr(static_index, '_runtime_source_epoch', None)
                if epoch is not None:
                    outcome.new_static_index._runtime_source_epoch = epoch.after_reindex(
                        file_path, source_aliases, source_before, source_after,
                        before_reliable and after_reliable)
                with self._state_lock:
                    if (
                        generation == self._state_generation
                        and self.static_index is static_index
                        and self.runtime_inspection is runtime
                        and self.model_graph is previous_model_graph
                        and self._last_surface_index is surface_ref
                    ) or last_attempt:
                        result = self._commit_reindex(outcome)
                        parsed_source = getattr(outcome.new_static_index, '_reindexed_source_fingerprint', None)
                        self._last_reindex_source = None
                        if (before_reliable and after_reliable and source_before == source_after
                                and parsed_source is not None and parsed_source[0] == str(file_path)
                                and self.runtime_inspection is not None and self.model_graph is not None):
                            # One recent source only; weak owners cannot retain
                            # an obsolete workspace graph/runtime after reset.
                            self._last_reindex_source = _RecentReindexSource(file_path, source_after, parsed_source[1],
                                self._state_generation, self._reindex_serial,
                                weakref.ref(self.static_index), weakref.ref(self.runtime_inspection), weakref.ref(self.model_graph))
                        break
            print(
                f'[reindexFile] state changed while reindexing; retry '
                f'attempt={attempt + 2}',
                file=sys.stderr,
            )

        elapsed = time.perf_counter() - started
        if result.get('unchanged'):
            print(
                f'[PERF] reindexFile: no changes {elapsed:.3f}s',
                file=sys.stderr,
            )
        else:
            print(
                f'[PERF] reindexFile: {outcome.affected_count} affected '
                f'{elapsed:.3f}s',
                file=sys.stderr,
            )
        self._schedule_runtime_member_refresh()
        if self._runtime_members_pending():
            result['runtimeMembersPending'] = True
        return result

    @profile_reindex
    def _compute_reindex(
        self,
        *,
        file_path: Path,
        static_index: StaticIndex,
        runtime: RuntimeInspection | None,
        previous_model_graph: ModelGraph | None,
        existing_surface: dict[str, object],
        previous_static_fallback: dict[str, dict[str, object]] | None,
    ) -> _ReindexOutcome:
        profile = current_profile()
        if runtime is None:
            runtime = create_pending_runtime_inspection(None)
        new_static_index, old_labels, new_labels = reindex_single_file(
            root=self.workspace_root,
            file_path=file_path,
            existing_static_index=static_index,
        )
        if profile:
            profile.mark('static')

        affected_labels = old_labels | new_labels
        edited_module = _module_name_for_reindex(self.workspace_root, file_path, static_index)
        edited_modules = {
            edited_module for index in (static_index, new_static_index)
            if (module := index.modules.get(edited_module)) is not None and (
                module.file_path == str(file_path) or (
                    not file_path.is_relative_to(self.workspace_root)
                    and Path(module.file_path).resolve() == file_path))
        }
        return self._compute_reindex_from_static(
            static_index=static_index, new_static_index=new_static_index, runtime=runtime,
            previous_model_graph=previous_model_graph, existing_surface=existing_surface,
            previous_static_fallback=previous_static_fallback,
            affected_labels=affected_labels, edited_modules=edited_modules)

    def _compute_reindex_from_static(
        self, *, static_index: StaticIndex, new_static_index: StaticIndex,
        runtime: RuntimeInspection | None, previous_model_graph: ModelGraph | None,
        existing_surface: dict[str, object],
        previous_static_fallback: dict[str, dict[str, object]] | None,
        affected_labels: set[str], edited_modules: set[str],
    ) -> _ReindexOutcome:
        profile = current_profile()
        if runtime is None:
            runtime = create_pending_runtime_inspection(None)
        affected_labels |= _source_dependent_labels(static_index, edited_modules)
        affected_labels |= _source_dependent_labels(new_static_index, edited_modules)
        # A helper's import/field alias can change fields in another module.
        # Comparing resolved fields also catches removed reverse relations on
        # the old target when an FK is retargeted or deleted.
        old_fields = static_index._fields_by_model_and_name
        new_fields = new_static_index._fields_by_model_and_name
        if new_static_index._changed_field_labels is not None:
            affected_labels.update(new_static_index._changed_field_labels)
        elif old_fields is not new_fields:
            affected_labels.update(
                key[0] for key, field in new_fields.items()
                if (previous := old_fields.get(key)) is not field and previous != field
            )
            affected_labels.update(key[0] for key in old_fields.keys() - new_fields.keys())
        old_candidates = static_index._model_candidates_by_label
        new_candidates = new_static_index._model_candidates_by_label
        if old_candidates is not new_candidates:
            affected_labels.update(
                label for label, candidate in new_candidates.items()
                if old_candidates.get(label) != candidate
            )
            affected_labels.update(old_candidates.keys() - new_candidates.keys())
        if not affected_labels:
            # No model changes — static index structure may be rebuilt but
            # model surfaces are identical. Skip the expensive surface rebuild
            # and return unchanged to avoid sending the 18MB+ payload.
            if runtime.bootstrap_status == 'ready' and runtime.settings_module:
                invalidate_runtime_members(static_index, new_static_index, runtime, ())
            return _ReindexOutcome(new_static_index=new_static_index)

        # Inheritance changes propagate beyond the edited module: when an
        # abstract/base model changes, every descendant model that inherits its
        # fields must refresh lookup/hover/diagnostic surfaces as well.
        affected_labels |= _inheritance_dependent_labels(static_index, affected_labels)
        affected_labels |= _inheritance_dependent_labels(new_static_index, affected_labels)
        source_affected_labels = set(affected_labels)
        if runtime.bootstrap_status == 'ready' and runtime.settings_module:
            invalidate_runtime_members(static_index, new_static_index, runtime, source_affected_labels)

        # Also invalidate reverse-relation targets: models that reference
        # affected models may have changed reverse relations.
        reverse_affected: set[str] = set()
        for target in affected_labels:
            reverse_affected.update(new_static_index._relation_sources_by_target.get(target, ()))
        affected_labels = affected_labels | reverse_affected
        if profile:
            profile.mark('affected')

        # Refresh only the graph slices touched by this file and by
        # reverse-relation invalidation.
        model_graph = (
            rebuild_model_graph_for_labels(
                previous_model_graph,
                old_static_index=static_index,
                static_index=new_static_index,
                runtime=runtime,
                affected_labels=affected_labels,
            )
            if previous_model_graph is not None
            else build_model_graph(new_static_index, runtime)
        )
        if profile:
            profile.mark('graph')

        # Rebuild surface for affected models only
        surface_index, affected_surface_keys = _rebuild_surface_slice(
            static_index=new_static_index,
            runtime=runtime,
            model_graph=model_graph,
            labels=affected_labels,
            surface_index=existing_surface,
            previous_static_index=static_index,
            previous_model_graph=previous_model_graph,
            source_affected_labels=source_affected_labels,
        )
        surface_index_delta = {
            key: surface_index[key]
            for key in sorted(affected_surface_keys)
            if key in surface_index
        }
        removed_labels = sorted(
            key for key in affected_surface_keys
            if key in existing_surface and key not in surface_index
        )
        added_labels = sorted(
            key for key in surface_index_delta if key not in existing_surface
        )
        changed_labels = sorted(
            key for key in surface_index_delta if key in existing_surface
        )
        surface_fingerprints = fingerprint_surface_index(
            surface_index,
            labels=set(surface_index_delta),
        )
        if profile:
            profile.mark('surface')

        # Build staticFallback for affected models. Use the same entry shape
        # as a full build (fieldDetails + reverseRelations); otherwise every
        # reindexed model degrades to CharField lookups with no reverse
        # relations on the client. `affected_labels` holds static candidate
        # labels while fallback keys are graph labels.
        affected_nodes = _affected_graph_nodes(model_graph, new_static_index, affected_labels)
        static_fallback: dict[str, dict[str, object]] = dict(
            previous_static_fallback or {}
        )
        for key in affected_labels | affected_surface_keys:
            static_fallback.pop(key, None)
        surface_labels = _surface_labels_with_instance_fields(surface_index,
            labels={node.label for node in affected_nodes})
        for node in affected_nodes:
            if node.label in surface_labels:
                continue
            entry = _static_fallback_entry(model_graph, node)
            if entry is not None:
                static_fallback[node.label] = entry

        fallback_keys = affected_labels | affected_surface_keys | {node.label for node in affected_nodes}
        previous_fallback = previous_static_fallback or {}
        fallback_delta = {
            key: static_fallback[key] for key in sorted(fallback_keys)
            if key in static_fallback and previous_fallback.get(key) != static_fallback[key]
        }
        removed_fallback_labels = sorted(
            key for key in fallback_keys if key in previous_fallback and key not in static_fallback
        )
        if profile:
            profile.mark('fallback')

        lookup_catalog_delta = {}
        if runtime.bootstrap_status == 'ready':
            from ..runtime.lookup_catalog import collect_model_lookup_catalog
            for label in affected_labels | affected_surface_keys:
                node = model_graph.node_for_model(label)
                previous_fields = previous_model_graph.fields_by_model_label.get(label, {}) if previous_model_graph else {}
                current_fields = model_graph.fields_by_model_label.get(label, {})
                if node is None:
                    if label in runtime.lookup_catalog.get('fields', {}):
                        lookup_catalog_delta[label] = None
                    continue
                if node.runtime_model is None:
                    continue
                changed = any(field.source == 'static_edit' and not field.is_relation
                    and ((old := previous_fields.get(name)) is None
                        or (field.field_kind, field.constructor_fingerprint) != (old.field_kind, old.constructor_fingerprint))
                    for name, field in current_fields.items())
                if changed or previous_fields.keys() - current_fields.keys():
                    lookup_catalog_delta[label] = collect_model_lookup_catalog(model_graph, runtime, label)
        if profile:
            profile.mark('catalogue')

        return _ReindexOutcome(
            new_static_index=new_static_index,
            affected_labels=affected_labels,
            model_graph=model_graph,
            surface_index=surface_index,
            surface_index_delta=surface_index_delta,
            surface_fingerprints=surface_fingerprints,
            removed_labels=removed_labels,
            added_labels=added_labels,
            changed_labels=changed_labels,
            static_fallback=static_fallback or None,
            static_fallback_delta=fallback_delta,
            removed_static_fallback_labels=removed_fallback_labels,
            model_names=self._build_model_names(model_graph),
            lookup_catalog_delta=lookup_catalog_delta,
        )

    def _commit_reindex(self, outcome: _ReindexOutcome) -> dict[str, Any]:
        """Publish a reindex result. Caller holds ``_state_lock``."""
        if outcome.affected_labels is None:
            if self.static_index is not None and self.runtime_inspection is not None:
                reuse_member_surface_cache_for_unchanged_index(self.static_index,
                    outcome.new_static_index, self.runtime_inspection, self.model_graph)
            self.static_index = outcome.new_static_index
            self._refresh_health_snapshot()
            self._reindex_serial += 1
            self._last_reindex_commit_at = time.perf_counter()
            self._source_snapshot_dirty = True
            self._discard_bg_pool()
            return {'unchanged': True}

        assert outcome.model_graph is not None
        assert outcome.surface_index is not None
        self.static_index = outcome.new_static_index
        self.model_graph = outcome.model_graph
        self._last_surface_index = outcome.surface_index
        self._last_surface_fingerprints = {
            **(self._last_surface_fingerprints or {}),
            **outcome.surface_fingerprints,
        }
        for label in outcome.removed_labels:
            self._last_surface_fingerprints.pop(label, None)
        self._last_model_names = outcome.model_names
        self._last_static_fallback = outcome.static_fallback
        if outcome.lookup_catalog_delta and self.runtime_inspection is not None:
            from ..runtime.lookup_catalog import apply_model_catalog_delta
            previous_runtime = self.runtime_inspection
            self.runtime_inspection = dataclasses.replace(self.runtime_inspection,
                lookup_catalog=apply_model_catalog_delta(self.runtime_inspection.lookup_catalog, outcome.lookup_catalog_delta))
            rebind_member_surface_cache_runtime(self.static_index, previous_runtime,
                self.runtime_inspection, self.model_graph)
            self._last_custom_lookups_fingerprint = fingerprint_json_payload([
                self._last_custom_lookups_fingerprint, outcome.lookup_catalog_delta])
            self._last_lookup_fingerprint_state = (
                self.runtime_inspection.custom_lookups, self.runtime_inspection.lookup_catalog)
        # This is an opaque revision token, not a content-addressed cache key.
        # Hash only the changed entries: hashing the entire fallback here made
        # a one-model save proportional to every field in the workspace.
        if not outcome.static_fallback:
            self._last_static_fallback_fingerprint = None
        elif outcome.static_fallback_delta or outcome.removed_static_fallback_labels:
            self._last_static_fallback_fingerprint = fingerprint_json_payload({
                'previous': self._last_static_fallback_fingerprint,
                'delta': outcome.static_fallback_delta,
                'removed': outcome.removed_static_fallback_labels,
            })
        self._reindex_serial += 1
        self._last_reindex_commit_at = time.perf_counter()
        for label in outcome.affected_labels:
            self._reindexed_labels[label] = self._reindex_serial
        self._source_snapshot_dirty = True
        self._refresh_health_snapshot()

        # State snapshots changed; drop stale workers instead of spawning
        # fresh processes during edit-time reindex.
        self._discard_bg_pool()

        result = {
            'surfaceIndexDelta': outcome.surface_index_delta,
            'surfaceFingerprints': outcome.surface_fingerprints,
            'staticFallbackDelta': outcome.static_fallback_delta,
            'removedStaticFallbackLabels': outcome.removed_static_fallback_labels,
            'staticFallbackFingerprint': self._last_static_fallback_fingerprint,
            'addedLabels': outcome.added_labels,
            'changedLabels': outcome.changed_labels,
            'removedLabels': outcome.removed_labels,
        }
        if outcome.lookup_catalog_delta:
            result['lookupCatalogDelta'] = outcome.lookup_catalog_delta
        return result

    def _refresh_health_snapshot(self, runtime_metadata=None) -> None:
        """Caller holds ``_state_lock``; publish diagnostics with their surface."""
        if (self.health_snapshot is None or self.workspace_profile is None
                or self.static_index is None or self.runtime_inspection is None):
            return
        semantic_graph = build_semantic_graph(self.workspace_profile,
            self.static_index, self.runtime_inspection)
        metadata = runtime_metadata if runtime_metadata is not None else self.health_snapshot.get('runtime', {})
        semantic_graph = dataclasses.replace(semantic_graph,
            runtime_model_count=metadata.get('modelCount', self.runtime_inspection.model_count))
        self.health_snapshot = refresh_health_snapshot(self.health_snapshot,
            static_index=self.static_index, runtime=self.runtime_inspection,
            semantic_graph=semantic_graph, runtime_metadata=runtime_metadata)
        self.semantic_graph = semantic_graph

    def _health(self) -> dict[str, Any]:
        with self._state_lock:
            snapshot = self.health_snapshot

        if snapshot is None:
            return self._initialize({})

        return snapshot

    def _relation_targets(self, params: dict[str, Any]) -> dict[str, Any]:
        _static_index, _runtime, model_graph = self._require_graph_feature_state()
        prefix = _clean_optional_string(params.get('prefix'))
        targets = list_relation_targets(
            model_graph=model_graph,
            prefix=prefix,
        )
        return {
            'items': targets,
        }

    def _resolve_relation_target(self, params: dict[str, Any]) -> dict[str, Any]:
        _static_index, _runtime, model_graph = self._require_graph_feature_state()
        value = _clean_optional_string(params.get('value'))
        if value is None:
            raise ValueError('`value` is required for resolveRelationTarget.')

        return resolve_relation_target(
            model_graph=model_graph,
            value=value,
        )

    def _resolve_export_origin(self, params: dict[str, Any]) -> dict[str, Any]:
        static_index, _runtime = self._require_feature_state()
        module_name = _clean_optional_string(params.get('module'))
        symbol = _clean_optional_string(params.get('symbol'))
        if module_name is None or symbol is None:
            raise ValueError('`module` and `symbol` are required for resolveExportOrigin.')

        return resolve_export_origin(
            static_index=static_index,
            module_name=module_name,
            symbol=symbol,
        )

    def _resolve_module(self, params: dict[str, Any]) -> dict[str, Any]:
        static_index, _runtime = self._require_feature_state()
        module_name = _clean_optional_string(params.get('module'))
        if module_name is None:
            raise ValueError('`module` is required for resolveModule.')

        return static_index.resolve_module(module_name).to_dict()

    def _lookup_path_completions(self, params: dict[str, Any]) -> dict[str, Any]:
        _static_index, runtime, model_graph = self._require_graph_feature_state()
        return list_lookup_path_completions(
            model_graph=model_graph, runtime=runtime,
            base_model_label=str(params.get('baseModelLabel') or ''),
            prefix=str(params.get('prefix') or ''),
            method=str(params.get('method') or 'filter'),
        )

    def _resolve_lookup_path(self, params: dict[str, Any]) -> dict[str, Any]:
        static_index, runtime, model_graph = self._require_graph_feature_state()
        base_model_label = _clean_optional_string(params.get('baseModelLabel'))
        value = _clean_optional_string(params.get('value'))
        method = _clean_optional_string(params.get('method'))
        if base_model_label is None or value is None or method is None:
            raise ValueError(
                '`baseModelLabel`, `value`, and `method` are required for resolveLookupPath.'
            )

        with self._state_lock:
            # A source edit or a replaced state invalidates the initial catalog.
            # Fresh per-model catalog chunks retain their own resolution path.
            use_initial_catalog = (
                self.static_index is static_index
                and self.runtime_inspection is runtime
                and self.model_graph is model_graph
                and not self._source_snapshot_dirty
            )

        return resolve_lookup_path(
            model_graph=model_graph,
            runtime=runtime,
            base_model_label=base_model_label,
            path=value,
            method=method,
            use_initial_catalog=use_initial_catalog,
        )

    def _orm_member_completions(self, params: dict[str, Any]) -> dict[str, Any]:
        # Rust fast-path + TS local index are authoritative. This Python
        # stub returns an empty result for backward compatibility — the
        # IPC path exists so older clients don't crash, but completions
        # come from the local surfaceIndex or the native addon.
        model_label = _clean_optional_string(params.get('modelLabel')) or ''
        receiver_kind = _clean_optional_string(params.get('receiverKind')) or ''
        manager_name = _clean_optional_string(params.get('managerName'))
        return {
            'items': [],
            'resolved': False,
            'reason': 'handled_by_native',
            'modelLabel': model_label,
            'receiverKind': receiver_kind,
            'managerName': manager_name,
        }

    def _resolve_orm_member(self, params: dict[str, Any]) -> dict[str, Any]:
        static_index, runtime, model_graph = self._require_graph_feature_state()
        model_label = _clean_optional_string(params.get('modelLabel'))
        receiver_kind = _clean_optional_string(params.get('receiverKind'))
        name = _clean_optional_string(params.get('name'))
        manager_name = _clean_optional_string(params.get('managerName'))
        if model_label is None or receiver_kind is None or name is None:
            raise ValueError(
                '`modelLabel`, `receiverKind`, and `name` are required for resolveOrmMember.'
            )

        return resolve_orm_member(
            static_index=static_index,
            runtime=runtime,
            model_graph=model_graph,
            model_label=model_label,
            receiver_kind=receiver_kind,
            name=name,
            manager_name=manager_name,
        )

    def _resolve_orm_member_batch(self, params: dict[str, Any]) -> dict[str, Any]:
        """Batch resolve multiple ORM members in a single IPC call."""
        static_index, runtime, model_graph = self._require_graph_feature_state()
        items = params.get('items', [])
        started = time.perf_counter()
        results = []
        for item in items:
            model_label = _clean_optional_string(item.get('modelLabel'))
            receiver_kind = _clean_optional_string(item.get('receiverKind'))
            name = _clean_optional_string(item.get('name'))
            manager_name = _clean_optional_string(item.get('managerName'))
            if model_label is None or receiver_kind is None or name is None:
                results.append({'resolved': False, 'reason': 'missing_params'})
                continue
            try:
                result = resolve_orm_member(
                    static_index=static_index,
                    runtime=runtime,
                    model_graph=model_graph,
                    model_label=model_label,
                    receiver_kind=receiver_kind,
                    name=name,
                    manager_name=manager_name,
                )
                results.append(result)
            except Exception:
                results.append({'resolved': False, 'reason': 'error'})
        return {'results': results, '_batch_size': len(items)}

    def _resolve_lookup_path_batch(self, params: dict[str, Any]) -> dict[str, Any]:
        """Batch resolve multiple lookup paths in a single IPC call."""
        _static_index, runtime, model_graph = self._require_graph_feature_state()
        items = params.get('items', [])
        results = []
        for item in items:
            base_model_label = _clean_optional_string(item.get('baseModelLabel'))
            value = _clean_optional_string(item.get('value'))
            method = _clean_optional_string(item.get('method'))
            if base_model_label is None or value is None or method is None:
                results.append({'resolved': False, 'reason': 'missing_params'})
                continue
            try:
                result = resolve_lookup_path(
                    model_graph=model_graph,
                    runtime=runtime,
                    base_model_label=base_model_label,
                    path=value,
                    method=method,
                )
                results.append(result)
            except Exception:
                results.append({'resolved': False, 'reason': 'error'})
        return {'results': results, '_batch_size': len(items)}

    def _resolve_orm_member_chain(self, params: dict[str, Any]) -> dict[str, Any]:
        static_index, runtime, model_graph = self._require_graph_feature_state()
        model_label = _clean_optional_string(params.get('modelLabel'))
        receiver_kind = _clean_optional_string(params.get('receiverKind'))
        chain = params.get('chain')
        manager_name = _clean_optional_string(params.get('managerName'))
        if model_label is None or receiver_kind is None or not isinstance(chain, list):
            raise ValueError(
                '`modelLabel`, `receiverKind`, and `chain` are required.'
            )

        return resolve_orm_member_chain(
            static_index=static_index,
            runtime=runtime,
            model_graph=model_graph,
            model_label=model_label,
            receiver_kind=receiver_kind,
            chain=[str(name) for name in chain],
            manager_name=manager_name,
        )

    def _require_feature_state(self) -> tuple[StaticIndex, RuntimeInspection]:
        with self._state_lock:
            static_index = self.static_index
            runtime = self.runtime_inspection

        if static_index is None or runtime is None:
            with self._init_lock:
                # Double-check after acquiring lock to avoid redundant init.
                with self._state_lock:
                    static_index = self.static_index
                    runtime = self.runtime_inspection
                if static_index is None or runtime is None:
                    self._initialize({})

        with self._state_lock:
            static_index = self.static_index
            runtime = self.runtime_inspection

        if static_index is None or runtime is None:
            raise RuntimeError('Daemon state is unavailable.')

        return static_index, runtime

    def _require_graph_feature_state(
        self,
    ) -> tuple[StaticIndex, RuntimeInspection, ModelGraph]:
        with self._state_lock:
            static_index = self.static_index
            runtime = self.runtime_inspection
            model_graph = self.model_graph

        if static_index is None or runtime is None or model_graph is None:
            with self._init_lock:
                with self._state_lock:
                    static_index = self.static_index
                    runtime = self.runtime_inspection
                    model_graph = self.model_graph
                if static_index is None or runtime is None or model_graph is None:
                    self._initialize({})

        with self._state_lock:
            static_index = self.static_index
            runtime = self.runtime_inspection
            model_graph = self.model_graph

        if static_index is None or runtime is None or model_graph is None:
            raise RuntimeError('Daemon state is unavailable.')

        return static_index, runtime, model_graph

    def _reserve_state_generation(
        self,
        *,
        workspace_root: Path,
        initialized_at: datetime,
        expected_generation: int | None = None,
        expected_reindex_serial: int | None = None,
    ) -> int | None:
        with self._state_lock:
            if (expected_generation is not None and expected_generation != self._state_generation
                    or expected_reindex_serial is not None and expected_reindex_serial != self._reindex_serial):
                return None
        self._cancel_surface_index_idle_load()
        with self._surface_load_lock:
            self._surface_load_attempted_generation = None
        with self._state_lock:
            if (expected_generation is not None and expected_generation != self._state_generation
                    or expected_reindex_serial is not None and expected_reindex_serial != self._reindex_serial):
                return None
            self._cancel_runtime_member_refresh()
            fresh_runtime = self._fresh_configuration_runtime_generation == self._state_generation
            self._state_generation += 1
            self._fresh_configuration_runtime_generation = self._state_generation if fresh_runtime else None
            self._runtime_source_cache_fingerprint = None
            self._source_membership_fingerprint = None
            self._source_provenance = None
            self._source_provenance_runtime_owned = False
            self._surface_source_complete = False
            self.workspace_root = workspace_root
            self.initialized_at = initialized_at
            return self._state_generation

    def _apply_state(
        self,
        *,
        generation: int,
        initialized_at: datetime,
        source_snapshot: PythonSourceSnapshot,
        workspace_profile: WorkspaceProfile,
        static_index: StaticIndex,
        runtime: RuntimeInspection,
        model_graph: ModelGraph,
        semantic_graph: SemanticGraphSummary,
        health_snapshot: dict[str, Any],
        static_index_matches_snapshot: bool = True,
        expected_reindex_serial: int | None = None,
        runtime_source_fingerprint: str | None = None,
        source_membership: str | None = None,
        source_provenance: dict[str, Any] | None = None,
        source_extra_roots: tuple[Path, ...] = (),
    ) -> bool:
        with self._state_lock:
            if generation != self._state_generation:
                return False
            if expected_reindex_serial is not None and expected_reindex_serial != self._reindex_serial:
                return False

            if static_index_matches_snapshot:
                self._source_snapshot_dirty = False
                static_index._runtime_source_epoch = RuntimeSourceEpoch.from_snapshot(
                    source_snapshot, source_extra_roots)
                self._runtime_source_cache_fingerprint = runtime_source_fingerprint
                self._source_membership_fingerprint = source_membership
                self._source_provenance = source_provenance
                self._source_provenance_runtime_owned = (source_provenance is not None
                    and expected_reindex_serial is None and _runtime_can_publish_source_provenance(runtime))
                self._surface_source_complete = False
            self.initialized_at = initialized_at
            self.source_snapshot = source_snapshot
            self.workspace_profile = workspace_profile
            self.static_index = static_index
            self.runtime_inspection = runtime
            self.model_graph = model_graph
            self.semantic_graph = semantic_graph
            self.health_snapshot = health_snapshot
            return True

    def _start_runtime_warmup(
        self,
        *,
        generation: int,
        initialized_at: datetime,
        workspace_root: Path,
        workspace_profile: WorkspaceProfile,
        static_index: StaticIndex,
        runtime_source_fingerprint: str,
        settings_module: str | None,
        source_snapshot: PythonSourceSnapshot,
        source_membership: str | None = None,
    ) -> None:
        with self._state_lock:
            if generation != self._state_generation or self._stopping.is_set():
                return
            fresh_runtime = self._fresh_configuration_runtime_generation == generation
        warmup_thread = threading.Thread(
            target=self._warm_runtime_state,
            kwargs={
                'generation': generation,
                'initialized_at': initialized_at,
                'workspace_root': workspace_root,
                'workspace_profile': workspace_profile,
                'static_index': static_index,
                'runtime_source_fingerprint': runtime_source_fingerprint,
                'settings_module': settings_module,
                'source_snapshot': source_snapshot,
                'source_membership': source_membership,
                **({'fresh_runtime': True} if fresh_runtime else {}),
            },
            daemon=True,
            name='django-orm-intellisense-runtime-warmup',
        )
        warmup_thread.start()

    def _warm_runtime_state(
        self,
        *,
        generation: int,
        initialized_at: datetime,
        workspace_root: Path,
        workspace_profile: WorkspaceProfile,
        static_index: StaticIndex,
        runtime_source_fingerprint: str,
        settings_module: str | None,
        source_snapshot: PythonSourceSnapshot,
        source_membership: str | None = None,
        fresh_runtime: bool = False,
    ) -> None:
        if fresh_runtime:
            self._warm_fresh_configuration_runtime(generation=generation, initialized_at=initialized_at,
                workspace_root=workspace_root, settings_module=settings_module)
            return
        started_at = time.perf_counter()
        # Use the captured source owner, not editable roots from a newer
        # initialization that may have replaced this warm-up generation.
        source_roots = (workspace_root, *(path.parent for path in source_snapshot.files
            if not path.is_relative_to(workspace_root)))
        # Import-time provenance must be checked before and after project code
        # runs. Matching only a delayed save-time snapshot can certify a mixed
        # or older registry under the wrong source generation.
        try:
            before_import = snapshot_python_sources(workspace_root, list(source_roots[1:]),
                previous_snapshot=source_snapshot)
            sources_owned = (before_import.fingerprint == source_snapshot.fingerprint
                and _source_membership_matches(before_import, source_membership))
        except (OSError, ValueError):
            sources_owned = False
        with current_workspace_source_imports(source_roots):
            runtime = inspect_runtime(settings_module)
        if sources_owned:
            try:
                after_import = snapshot_python_sources(workspace_root, list(source_roots[1:]),
                    previous_snapshot=before_import)
                sources_owned = (after_import.fingerprint == source_snapshot.fingerprint
                    and _source_membership_matches(after_import, source_membership))
            except (OSError, ValueError):
                sources_owned = False
        runtime_cache_fingerprint = _runtime_cache_fingerprint(runtime, source_fingerprint=runtime_source_fingerprint)

        # Build against the *current* static index. A file saved while Django
        # was importing was reindexed into `self.static_index`; building from
        # the initialize-time copy and applying it would silently drop that
        # edit until the file is saved again. Retry when a reindex lands while
        # we build; the last attempt builds under the lock.
        for attempt in range(_WARMUP_APPLY_ATTEMPTS):
            last_attempt = attempt == _WARMUP_APPLY_ATTEMPTS - 1
            with self._state_lock if last_attempt else contextlib.nullcontext():
                with self._state_lock:
                    if generation != self._state_generation:
                        return
                    graph_static_index = self.static_index or static_index
                    previous_graph = self.model_graph
                if previous_graph is not None:
                    labels = (set(static_index._model_candidates_by_label)
                        | set(graph_static_index._model_candidates_by_label)
                        | set(previous_graph.nodes_by_label)
                        | {model.label for model in runtime.model_catalog})
                    model_graph = rebuild_model_graph_for_labels(previous_graph,
                        old_static_index=static_index, static_index=graph_static_index,
                        runtime=runtime, affected_labels=labels)
                else:
                    model_graph = build_model_graph(graph_static_index, runtime)
                semantic_graph = build_semantic_graph(
                    workspace_profile, graph_static_index, runtime,
                )
                health_snapshot = build_health_snapshot(
                    workspace=workspace_profile,
                    static_index=graph_static_index,
                    runtime=runtime,
                    semantic_graph=semantic_graph,
                    initialized_at=initialized_at,
                )
                with self._state_lock:
                    if generation != self._state_generation:
                        return
                    if (
                        self.static_index is not None
                        and self.static_index is not graph_static_index
                        and not last_attempt
                    ):
                        continue
                    if not self._apply_state(
                        generation=generation,
                        initialized_at=initialized_at,
                        source_snapshot=source_snapshot,
                        workspace_profile=workspace_profile,
                        static_index=graph_static_index,
                        runtime=runtime,
                        model_graph=model_graph,
                        semantic_graph=semantic_graph,
                        health_snapshot=health_snapshot,
                        # Warm-up keeps the snapshot; reindexed edits since
                        # initialize still diverge from it.
                        static_index_matches_snapshot=False,
                    ):
                        return
                    self._source_provenance_runtime_owned = (sources_owned
                        and not self._source_snapshot_dirty and graph_static_index is static_index
                        and _runtime_can_publish_source_provenance(runtime))
                    self._publish_warmed_runtime_state(
                        runtime=runtime,
                        model_graph=model_graph,
                        health_snapshot=health_snapshot,
                    )
                    source_dirty = self._source_snapshot_dirty
                    break

        # The graph cache is keyed by the initialize-time source fingerprint;
        # only persist it when no model edit moved the static index away.
        if not source_dirty and sources_owned and _source_membership_matches(source_snapshot, source_membership):
            save_runtime_inspection(
                workspace_root,
                runtime_source_fingerprint,
                settings_module,
                runtime,
            )
            save_model_graph(
                workspace_root,
                source_fingerprint=source_snapshot.fingerprint,
                runtime_fingerprint=runtime_cache_fingerprint,
                model_graph=model_graph,
            )
        _log_initialize_step(
            'inspect_runtime(background) '
            f'status={runtime.bootstrap_status} '
            f'django_importable={runtime.django_importable} '
            f'elapsed={time.perf_counter() - started_at:.2f}s'
        )

        # Keep the configured idle window, overlapping a clean startup's
        # runtime work instead of appending another full wait after warmup.
        # Explicit disabled/on-demand modes and edited-source delays remain.
        self._discard_bg_pool()
        self._schedule_surface_index_idle_load(
            reason='runtime_warmup',
            expected_generation=generation,
            idle_since=started_at if sources_owned and not source_dirty else None,
        )
        if source_dirty:
            self._schedule_runtime_member_refresh()

    def _warm_fresh_configuration_runtime(self, *, generation, initialized_at, workspace_root, settings_module):
        started = time.perf_counter()
        try:
            for _attempt in range(_WARMUP_APPLY_ATTEMPTS):
                with self._state_lock:
                    if generation != self._state_generation or self._stopping.is_set():
                        return
                    serial = self._reindex_serial
                    configuration = self._source_configuration_fingerprint
                venv = resolve_venv_info(workspace_root)
                _context, fingerprint = source_observation_context(workspace_root, venv)
                if fingerprint != configuration:
                    return
                roots = [Path(entry.path) for entry in venv.editable_installs] if venv else []
                sources = snapshot_python_sources(workspace_root, extra_roots=roots or None)
                initialized = self._initialize_from_source_snapshot(generation=generation, initialized_at=initialized_at,
                    workspace_root=workspace_root, settings_module=settings_module, defer_runtime=False,
                    venv_info=venv, source_snapshot=sources, started_at=started, expected_reindex_serial=serial)
                if initialized is None:
                    continue
                with self._state_lock:
                    if (generation != self._state_generation or self._stopping.is_set()
                            or self.static_index is not initialized.static_index
                            or self.model_graph is not initialized.model_graph):
                        return
                    self._publish_warmed_runtime_state(runtime=self.runtime_inspection,
                        model_graph=initialized.model_graph, health_snapshot=initialized.health_snapshot)
                _log_initialize_step(f'inspect_runtime(fresh_configuration) elapsed={time.perf_counter()-started:.2f}s')
                return
            if self._queue_fresh_runtime_retry(generation=generation, initialized_at=initialized_at,
                    workspace_root=workspace_root, settings_module=settings_module):
                _log_initialize_step('fresh_configuration_runtime superseded; current-owner retry queued')
        except Exception:
            _log_initialize_step('fresh_configuration_runtime failed ' + traceback.format_exc(limit=6))

    def _queue_fresh_runtime_retry(self, *, generation, initialized_at, workspace_root, settings_module) -> bool:
        """Continue a superseded warm-up after the current edit burst settles."""
        with self._state_lock:
            runtime = self.runtime_inspection
            if (generation != self._state_generation or self._stopping.is_set()
                    or self._fresh_configuration_runtime_generation != generation
                    or runtime is None or runtime.bootstrap_status != 'warming_up'):
                return False
            previous = self._fresh_runtime_retry
            if previous is not None and previous[0] == generation:
                return True
            if previous is not None:
                previous[1].cancel()

            def retry():
                with self._state_lock:
                    current = self._fresh_runtime_retry
                    if current is None or current[0] != generation or current[1] is not timer:
                        return
                    self._fresh_runtime_retry = None
                    runtime = self.runtime_inspection
                    if (generation != self._state_generation or self._stopping.is_set()
                            or self._fresh_configuration_runtime_generation != generation
                            or runtime is None or runtime.bootstrap_status != 'warming_up'):
                        return
                # Capture the current source serial again in the existing
                # verified initialization path; never reuse a rejected result.
                self._warm_fresh_configuration_runtime(generation=generation, initialized_at=initialized_at,
                    workspace_root=workspace_root, settings_module=settings_module)

            timer = threading.Timer(0.2, retry)
            timer.daemon = True
            self._fresh_runtime_retry = (generation, timer)
        try:
            timer.start()
        except BaseException:
            with self._state_lock:
                current = self._fresh_runtime_retry
                if current is not None and current[1] is timer:
                    self._fresh_runtime_retry = None
            timer.cancel()
            raise
        return True

    def _publish_warmed_runtime_state(
        self,
        *,
        runtime: RuntimeInspection,
        model_graph: ModelGraph,
        health_snapshot: dict[str, Any],
    ) -> None:
        """Push the runtime-derived fallback. Caller holds ``_state_lock``.

        Until the idle surface load lands (a cold prebuild can take long, or
        fail), the client's local index is built from this fallback. The one
        from initialize came from the static-only graph: models whose fields
        live on bases the static indexer cannot see had nothing but the
        synthesized `id` / `pk`, runtime-relabelled models (`zuzu.X` ↔ `db.X`)
        sat under the static label, and third-party models were missing.

        Written under the state lock so no reindex or surface load can publish
        newer state between this snapshot and its notification.
        """
        # Surface slices rebuilt by reindexes during warm-up were computed
        # against the pending runtime and static-only graph. Drop them; the
        # runtime fallback covers those models until the full surface loads.
        self._last_surface_index = {}
        self._surface_source_complete = False
        self._last_surface_fingerprints = {}
        model_names = self._build_model_names(model_graph)
        custom_lookups_fingerprint = fingerprint_json_payload(
            [runtime.custom_lookups, runtime.lookup_catalog]
        )
        static_fallback = self._build_static_fallback(
            model_graph=model_graph,
            surface_index={},
        )
        static_fallback_fingerprint = (
            fingerprint_json_payload(static_fallback)
            if static_fallback
            else None
        )
        self._last_model_names = model_names
        self._last_static_fallback = static_fallback
        self._last_static_fallback_fingerprint = static_fallback_fingerprint
        self._last_custom_lookups_fingerprint = custom_lookups_fingerprint
        self._last_lookup_fingerprint_state = (runtime.custom_lookups, runtime.lookup_catalog)
        self._write_notification(
            'surfaceIndexChanged',
            {
                'health': health_snapshot,
                'modelNames': model_names,
                'surfaceIndex': {},
                'sourceProvenance': None,
                'surfaceFingerprints': {},
                'customLookups': runtime.custom_lookups,
                'lookupCatalog': runtime.lookup_catalog,
                'customLookupsFingerprint': custom_lookups_fingerprint,
                'staticFallback': static_fallback,
                'staticFallbackFingerprint': static_fallback_fingerprint,
            },
        )

    def _initialize_frame_is_current(self, result: Any) -> bool:
        if (type(result) is not dict or self._stopping.is_set()
                or not self._surface_transport_enabled
                or self._source_configuration_fingerprint is None
                or not isinstance(result.get('sourceObservationContext'), dict)):
            return False
        runtime = self.runtime_inspection
        if runtime is None or runtime.bootstrap_status != 'ready':
            return False
        provenance = self._published_source_provenance()
        if provenance is None or result.get('sourceProvenance') is not provenance:
            return False
        # A transport sequence is not source proof. All metadata still belongs
        # to the exact live owner checked by normal initialization/publication.
        current = (
            ('health', self.health_snapshot), ('modelNames', self._last_model_names),
            ('surfaceIndex', self._last_surface_index),
            ('surfaceFingerprints', self._last_surface_fingerprints),
            ('customLookups', runtime.custom_lookups), ('lookupCatalog', runtime.lookup_catalog),
            ('customLookupsFingerprint', self._last_custom_lookups_fingerprint),
            ('staticFallback', self._last_static_fallback),
            ('staticFallbackFingerprint', self._last_static_fallback_fingerprint),
        )
        if any(result.get(name) is not value for name, value in current):
            return False
        surface, fingerprints = result['surfaceIndex'], result['surfaceFingerprints']
        return (isinstance(surface, dict) and isinstance(fingerprints, dict)
            and surface.keys() == fingerprints.keys()
            and all(isinstance(value, str) for value in fingerprints.values()))

    def _write_initialize_response(self, request_id: Any, result: Any) -> None:
        transport = None
        with self._state_lock:
            if self._initialize_frame_is_current(result):
                generation, serial = self._state_generation, self._reindex_serial
                configuration = self._source_configuration_fingerprint
                transport = self._surface_transport.prepare(result, force_full=True)
        if transport is None:
            self._write_response(request_id, result)
            return
        payload = {'id': request_id, 'result': transport.payload}
        # Keep expensive encoding outside both locks, like normal surface
        # publication. Recheck the captured owner and revision before writing.
        prepared = self._prepare_message(payload)
        with self._state_lock:
            if (generation == self._state_generation and serial == self._reindex_serial
                    and configuration == self._source_configuration_fingerprint
                    and self._initialize_frame_is_current(result)
                    and self._surface_transport.is_current(transport)):
                self._write_message(payload, prepared_message=prepared)
                self._surface_transport.commit(transport)
                return
        # Legacy full contents retain their normal resync recovery if another
        # publication/source owner won the race during preparation.
        self._write_response(request_id, result)

    def _write_response(self, request_id: Any, result: Any) -> None:
        self._write_message(
            {
                'id': request_id,
                'result': result,
            }
        )

    def _write_error(
        self,
        request_id: Any,
        code: str,
        message: str,
        data: dict[str, Any] | None = None,
    ) -> None:
        self._write_message(
            {
                'id': request_id,
                'error': {
                    'code': code,
                    'message': message,
                    'data': data or {},
                },
            }
        )

    def _write_notification(self, event: str, params: dict[str, Any],
                            *, prepared_message: _PreparedMessage | None = None) -> None:
        if (event == 'surfaceIndexChanged' and self._surface_transport_enabled
                and isinstance(params.get('surfaceIndex'), dict)):
            with self._state_lock:
                transport = prepared_message.surface_snapshot if prepared_message is not None else None
                if transport is None:
                    transport = self._surface_transport.prepare(params)
                    prepared_message = None
                if not self._surface_transport.is_current(transport):
                    raise RuntimeError('Surface transport baseline changed before write')
                self._write_message({'event': event, 'params': transport.payload}, prepared_message=prepared_message)
                self._surface_transport.commit(transport)
            return
        self._write_message(
            {
                'event': event,
                'params': params,
            },
            prepared_message=prepared_message,
        )

    def _resync_surface_snapshot(self) -> dict[str, bool]:
        with self._state_lock:
            self._surface_transport.reset()
            self._write_notification('surfaceIndexChanged', self._surface_index_changed_payload())
        return {'resynced': True}

    def _prepare_message(self, payload: dict[str, Any]) -> _PreparedMessage:
        profile_write = os.environ.get('DJLS_PROFILE_SURFACE_ADOPTION') == '1'
        started = time.perf_counter() if profile_write else 0.0
        line, kind, raw_chars, compression_seconds = encode_ipc_message(
            payload, _IPC_COMPRESS_MIN_KB, profile=profile_write)
        finished = time.perf_counter() if profile_write else 0.0
        return _PreparedMessage(line, kind, raw_chars / 1024, started,
            max(0.0, finished - started - compression_seconds) * 1000,
            compression_seconds * 1000)

    def _write_message(self, payload: dict[str, Any],
                       *, prepared_message: _PreparedMessage | None = None) -> None:
        prepared = prepared_message or self._prepare_message(payload)
        profile_write = bool(prepared.profile_started)
        wait_started = time.perf_counter() if profile_write else 0.0
        with self._write_lock:
            lock_acquired = time.perf_counter() if profile_write else 0.0
            request_id = payload.get('id')
            raw_size_kb = prepared.raw_size_kb
            # 옵션 C — payload 가 임계값을 넘으면 gzip+base64 로 wrap.
            # captain log.txt 의 initialize 22.8MB 가 한 줄 stdout 송신 +
            # JSON.parse 비용을 모두 부담함. gzip 으로 ~10x 압축 가능.
            line, kind = prepared.line, prepared.encoding
            final_size_kb = len(line) / 1024
            if raw_size_kb >= 10:
                if kind == 'gzip+b64':
                    print(
                        f'[ipc:write] {request_id} payload={final_size_kb:.1f}KB '
                        f'(raw={raw_size_kb:.1f}KB enc={kind})',
                        file=sys.stderr,
                        flush=True,
                    )
                else:
                    print(
                        f'[ipc:write] {request_id} payload={final_size_kb:.1f}KB',
                        file=sys.stderr,
                        flush=True,
                    )
            # Keep both writes under the publication lock without allocating
            # another full-size line just to append its framing delimiter.
            self._real_stdout.write(line)
            self._real_stdout.write('\n')
            self._real_stdout.flush()
        if profile_write:
            finished = time.perf_counter()
            if raw_size_kb >= 1024 or finished - prepared.profile_started >= 0.01:
                print('[ipc:profile] ' + json.dumps({
                    'event': payload.get('event'), 'id': request_id, 'rawKB': raw_size_kb,
                    'writeLockWaitMs': (lock_acquired - wait_started) * 1000,
                    'jsonMs': prepared.json_ms,
                    'compressionMs': prepared.compression_ms,
                    'writeMs': (finished - lock_acquired) * 1000,
                    'totalMs': (finished - prepared.profile_started) * 1000,
                }), file=sys.stderr, flush=True)


# 옵션 C — IPC payload 압축 임계값.
# captain 의 initialize 22.8MB 같은 케이스에서 gzip ~10x 압축으로 cold-start
# 단축. env DJLS_IPC_COMPRESS_MIN_KB=0 으로 비활성, =1 같이 매우 낮으면 모든
# 메시지 압축 (테스트용).
_IPC_COMPRESS_MIN_KB = int(
    os.environ.get('DJLS_IPC_COMPRESS_MIN_KB', '256') or '256'
)
_IPC_COMPRESS_PREFIX = '{"_enc":"gzip+b64","data":"'
_IPC_COMPRESS_SUFFIX = '"}'


def _maybe_compress_ipc_payload(serialized: str) -> tuple[str, str | None]:
    """Wrap serialized JSON in gzip+base64 envelope when above threshold.

    Returns (line_to_send, encoding_or_None). 호환성: TS client 가 `_enc`
    필드 못 보면 fallback 처리되어야 함 — 현재 새 client 빌드만 지원.
    """
    if _IPC_COMPRESS_MIN_KB <= 0:
        return serialized, None
    if len(serialized) < _IPC_COMPRESS_MIN_KB * 1024:
        return serialized, None
    compressed = gzip.compress(serialized.encode('utf-8'), compresslevel=6)
    b64 = base64.b64encode(compressed).decode('ascii')
    envelope = _IPC_COMPRESS_PREFIX + b64 + _IPC_COMPRESS_SUFFIX
    return envelope, 'gzip+b64'


def _clean_optional_string(value: Any) -> str | None:
    if value is None:
        return None

    text = str(value).strip()
    return text or None


_resource_usage_start_wall = time.monotonic()
_resource_usage_start_proc = time.process_time()
_resource_usage_lock = threading.Lock()
_resource_usage_last_wall = _resource_usage_start_wall
_resource_usage_last_proc = _resource_usage_start_proc

try:
    import resource as _resource_module
except ImportError:  # pragma: no cover — Windows fallback
    _resource_module = None  # type: ignore[assignment]


def _sample_cpu_percent() -> tuple[float, float]:
    """Return (cpu_now%, cpu_avg%) for the daemon main process.

    cpu_now is process CPU% since the previous sample call;
    cpu_avg is the cumulative process CPU% since daemon startup.
    Only main-process CPU is measured — ProcessPoolExecutor workers
    are separate OS processes and not counted here.
    """
    global _resource_usage_last_wall, _resource_usage_last_proc
    now_wall = time.monotonic()
    now_proc = time.process_time()
    with _resource_usage_lock:
        wall_delta = now_wall - _resource_usage_last_wall
        proc_delta = now_proc - _resource_usage_last_proc
        _resource_usage_last_wall = now_wall
        _resource_usage_last_proc = now_proc
    cpu_now = (proc_delta / wall_delta * 100.0) if wall_delta > 0 else 0.0
    total_wall = now_wall - _resource_usage_start_wall
    total_proc = now_proc - _resource_usage_start_proc
    cpu_avg = (total_proc / total_wall * 100.0) if total_wall > 0 else 0.0
    return cpu_now, cpu_avg


def _current_rss_mb() -> float:
    if _resource_module is None:
        return 0.0
    rss = _resource_module.getrusage(_resource_module.RUSAGE_SELF).ru_maxrss
    # macOS reports ru_maxrss in bytes; Linux reports kilobytes.
    if sys.platform == 'darwin':
        return rss / (1024 * 1024)
    return rss / 1024


def _format_resource_usage() -> str:
    cpu_now, cpu_avg = _sample_cpu_percent()
    rss_mb = _current_rss_mb()
    return f'cpu={cpu_now:.1f}%/avg={cpu_avg:.1f}% rss={rss_mb:.1f}MB'


def _log_ipc(
    thread: str,
    method: str | None,
    request_id: Any,
    elapsed: float,
    background: bool = False,
    *,
    source: Any = 'unknown',
    error: bool = False,
    batch_size: int | None = None,
    item_count: int | None = None,
) -> None:
    tag = 'bg' if background else 'fg'
    status = 'ERR' if error else 'OK'
    batch_info = f' batch={batch_size}' if batch_size else ''
    items_info = f' items={item_count}' if item_count is not None else ''
    print(
        f'[ipc:{tag}] [{thread}] {method}#{request_id}'
        f' source={source} {elapsed:.3f}s {status}{batch_info}{items_info}'
        f' {_format_resource_usage()}',
        file=sys.stderr,
        flush=True,
    )


def _log_bg_queue(
    *,
    event: str,
    worker: str,
    method: Any,
    request_id: Any,
    source: Any,
    inflight: int,
    total_inflight: int,
    running_est: int,
    queued_est: int,
    submitted: int,
    completed: int,
    failed: int,
    peak: int,
    ok: bool | None = None,
) -> None:
    status = ''
    if ok is True:
        status = ' ok=1'
    elif ok is False:
        status = ' ok=0'
    print(
        f'[bg-queue] {event} worker={worker} {method}#{request_id}'
        f' source={source} inflight={inflight} total_inflight={total_inflight}'
        f' running_est={running_est} queued_est={queued_est}'
        f' submitted={submitted} completed={completed}'
        f' failed={failed} peak={peak}{status}'
        f' {_format_resource_usage()}',
        file=sys.stderr,
        flush=True,
    )


def _log_initialize_step(message: str) -> None:
    print(f'[initialize] {message}', file=sys.stderr, flush=True)


def _source_root_identity(root: Path):
    try:
        value = root.stat()
    except FileNotFoundError:
        return None
    if not stat.S_ISDIR(value.st_mode) or not value.st_ino:
        raise ValueError('Source root does not have a reliable directory identity')
    return (value.st_dev, value.st_ino, value.st_mtime_ns, value.st_ctime_ns,
        getattr(value, 'st_birthtime_ns',
        getattr(value, 'st_birthtime', None)))


def _strict_source_snapshot(workspace_root: Path, source_roots: tuple[Path, ...]):
    """Reject partial directory/file scans instead of publishing missing sources."""
    expected = set()
    for root in dict.fromkeys((workspace_root, *source_roots)):
        def onerror(error):
            # A deleted declared root is a valid empty source inventory.
            if isinstance(error, FileNotFoundError) and error.filename == str(root):
                return
            raise error
        for directory, names, files in os.walk(root, onerror=onerror):
            names[:] = [name for name in names if name not in SKIP_DIRS and not name.startswith('.')]
            for name in files:
                if not name.endswith('.py'):
                    continue
                path = Path(directory, name)
                try:
                    path.stat()
                except FileNotFoundError:
                    if path.is_symlink():
                        continue
                    raise
                expected.add(path)
    snapshot = snapshot_python_sources(workspace_root, list(source_roots))
    if expected != set(snapshot.files):
        raise RuntimeError('Source inventory changed during root reconciliation')
    return snapshot


def _source_event_path(value, roots=None) -> Path:
    """Keep a file link's module namespace, resolving its directory aliases."""
    path = Path(str(value))
    try:
        resolved = path.resolve()
    except (OSError, RuntimeError):
        # A broken or looping leaf link can still revoke its indexed module.
        if not path.is_symlink() or path.is_dir():
            raise
        return path.parent.resolve() / path.name
    if resolved != path and path.is_symlink() and not path.is_dir():
        namespace = path.parent.resolve() / path.name
        if roots is None or any(namespace.is_relative_to(root) for root in roots):
            return namespace
    return resolved


def _runtime_can_publish_source_provenance(runtime: RuntimeInspection) -> bool:
    # Missing configuration/Django is a complete static route, unlike pending
    # or failed setup. It still needs a complete source-owned surface prebuild.
    return runtime.bootstrap_status in {'ready', 'skipped_missing_django', 'skipped_missing_settings'}


def _source_membership_matches(snapshot: PythonSourceSnapshot, expected: str | None) -> bool:
    if expected is None:
        return False
    try:
        return source_membership_fingerprint(snapshot) == expected
    except (OSError, ValueError):
        return False


def _runtime_cache_fingerprint(runtime: RuntimeInspection, *, source_fingerprint: str | None = None) -> str:
    digest = hashlib.sha256()
    digest.update(runtime.bootstrap_status.encode('utf-8'))
    digest.update(b'\0')
    digest.update(str(runtime.model_count).encode('ascii'))
    digest.update(b'\0')
    digest.update(str(runtime.field_count).encode('ascii'))
    digest.update(b'\0')
    digest.update((runtime.django_version or 'none').encode('utf-8'))
    if source_fingerprint is not None:
        digest.update(b'\0producer-source-v1\0')
        digest.update(source_fingerprint.encode('ascii'))
    return digest.hexdigest()


def _runtime_source_fingerprint(
    *,
    source_snapshot: PythonSourceSnapshot,
    static_index: StaticIndex,
    settings_module: str | None,
    membership_fingerprint: str | None = None,
    configuration_fingerprint: str | None = None,
) -> str:
    # Imports/registrations in a helper outside the model/settings packages
    # can change runtime metadata. A scoped directory hash is insufficient;
    # use the complete already-validated source identity without a model walk.
    digest = hashlib.sha256()
    digest.update(b'producer-source-v1\0')
    digest.update((settings_module or '').encode('utf-8'))
    digest.update(b'\0')
    digest.update(source_snapshot.fingerprint.encode('ascii'))
    digest.update(b'\0')
    digest.update((membership_fingerprint if membership_fingerprint is not None
        else source_membership_fingerprint(source_snapshot)).encode('ascii'))
    # Counts and source identity can stay equal while environment-driven
    # field types/registrations change. Graph and surface keys inherit this
    # same launch owner, rather than only invalidating the runtime envelope.
    digest.update(b'\0launch-environment-v1\0')
    digest.update(launch_environment_fingerprint().encode('ascii'))
    if configuration_fingerprint is not None:
        digest.update(b'\0source-configuration-v1\0')
        digest.update(configuration_fingerprint.encode('ascii'))
    return digest.hexdigest()
