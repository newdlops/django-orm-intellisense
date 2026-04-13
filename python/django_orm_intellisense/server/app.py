from __future__ import annotations

import contextlib
import hashlib
import json
import multiprocessing
import os
import sys
import threading
import time
import traceback
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..cache import (
    load_cached_source_snapshot,
    load_cached_runtime_inspection,
    load_cached_static_index,
    load_cached_surface_index,
    save_source_snapshot,
    save_runtime_inspection,
    save_static_index,
    save_surface_index,
)
from ..discovery.workspace import (
    PythonSourceSnapshot,
    VenvInfo,
    WorkspaceProfile,
    discover_workspace,
    resolve_venv_info,
    snapshot_python_sources,
)
from ..features.health import build_health_snapshot
from ..features.lookup_paths import (
    list_lookup_path_completions,
    resolve_lookup_path,
)
from ..features.orm_members import (
    list_orm_member_completions,
    prebuild_member_surface_cache,
    rebuild_surface_for_models,
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
    SemanticGraphSummary,
    build_model_graph,
    build_semantic_graph,
)
from ..static_index.indexer import StaticIndex, build_static_index, reindex_single_file


INITIAL_SYNC_SURFACE_INDEX_MODEL_LIMIT = 200


# ---------------------------------------------------------------------------
# Background worker process — runs in a separate OS process (no GIL sharing)
# ---------------------------------------------------------------------------

_worker_static_index: StaticIndex | None = None
_worker_runtime: RuntimeInspection | None = None
_worker_model_graph: ModelGraph | None = None


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
    custom_lookups: dict[str, list[str]]
    static_fallback: dict[str, dict[str, list[str]]] | None


def _init_bg_worker(
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    model_graph: ModelGraph,
) -> None:
    """Called once per worker process to set up shared-nothing state."""
    global _worker_static_index, _worker_runtime, _worker_model_graph
    _worker_static_index = static_index
    _worker_runtime = runtime
    _worker_model_graph = model_graph


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
        return resolve_orm_member(static_index=si, runtime=rt, model_label=ml, receiver_kind=rk, name=nm, manager_name=mn)

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
                results.append(resolve_orm_member(static_index=si, runtime=rt, model_label=ml, receiver_kind=rk, name=nm, manager_name=mn))
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
        return resolve_orm_member_chain(static_index=si, runtime=rt, model_label=ml, receiver_kind=rk, chain=[str(n) for n in chain], manager_name=mn)

    if method == 'lookupPathCompletions':
        base = _clean_optional_string(params.get('baseModelLabel'))
        prefix = _clean_optional_string(params.get('prefix')) or ''
        mth = _clean_optional_string(params.get('method'))
        if base is None or mth is None:
            raise ValueError('missing params for lookupPathCompletions')
        return list_lookup_path_completions(model_graph=mg, runtime=rt, base_model_label=base, prefix=prefix, method=mth)

    if method == 'ormMemberCompletions':
        ml = _clean_optional_string(params.get('modelLabel'))
        rk = _clean_optional_string(params.get('receiverKind'))
        prefix = _clean_optional_string(params.get('prefix')) or ''
        mn = _clean_optional_string(params.get('managerName'))
        if ml is None or rk is None:
            raise ValueError('missing params for ormMemberCompletions')
        return list_orm_member_completions(static_index=si, runtime=rt, model_label=ml, receiver_kind=rk, prefix=prefix, manager_name=mn)

    if method == 'relationTargets':
        prefix = _clean_optional_string(params.get('prefix'))
        return {'items': list_relation_targets(model_graph=mg, prefix=prefix)}

    raise ValueError(f'Unsupported background method: {method}')


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
        self._bg_pool: ProcessPoolExecutor | None = None
        self._last_surface_index: dict[str, object] | None = None
        self._last_model_names: list[str] | None = None
        self._last_static_fallback: dict[str, dict[str, list[str]]] | None = None

    def run_stdio(self) -> None:
        threading.current_thread().name = 'main'

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

            if request.get('background') and self._bg_pool is not None:
                # Background requests → separate OS processes (no GIL).
                self._submit_bg(request)
            else:
                # Foreground (hover, completion, initialize, reindexFile)
                # → main thread for immediate response.
                self._handle_request(request)

        if self._bg_pool is not None:
            self._bg_pool.shutdown(wait=False)

    # ------------------------------------------------------------------
    # Background process pool
    # ------------------------------------------------------------------

    def _rebuild_bg_pool(self) -> None:
        """(Re-)create the process pool with the current state snapshot.

        Called after initialize and reindexFile so workers get fresh data.
        """
        old = self._bg_pool
        self._bg_pool = None
        if old is not None:
            old.shutdown(wait=False)

        with self._state_lock:
            si = self.static_index
            rt = self.runtime_inspection
            mg = self.model_graph

        if si is None or rt is None or mg is None:
            return

        worker_count = min(os.cpu_count() or 4, 8)
        try:
            self._bg_pool = ProcessPoolExecutor(
                max_workers=worker_count,
                initializer=_init_bg_worker,
                initargs=(si, rt, mg),
            )
            print(
                f'[pool] ProcessPoolExecutor created workers={worker_count}',
                file=sys.stderr, flush=True,
            )
        except Exception as exc:  # pragma: no cover — pickle/fork failure
            print(
                f'[pool] ProcessPoolExecutor failed ({exc}), '
                f'background requests will run on main thread',
                file=sys.stderr, flush=True,
            )
            self._bg_pool = None

    def _submit_bg(self, request: dict[str, Any]) -> None:
        """Submit a request to the background process pool."""
        request_id = request.get('id')
        method = request.get('method')
        params = request.get('params') or {}
        source = request.get('source') or 'unknown'
        started = time.perf_counter()

        assert self._bg_pool is not None
        future = self._bg_pool.submit(_bg_dispatch, method, params)

        def _on_done(f: Any) -> None:
            elapsed = time.perf_counter() - started
            try:
                result = f.result()
                batch_size = result.get('_batch_size') if isinstance(result, dict) else None
                _log_ipc('bg', method, request_id, elapsed, True, source=source, batch_size=batch_size)
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

        future.add_done_callback(_on_done)

    def _handle_request(self, request: dict[str, Any]) -> None:
        request_id = request.get('id')
        method = request.get('method')
        params = request.get('params') or {}
        background = request.get('background', False)
        source = request.get('source') or 'unknown'
        started = time.perf_counter()
        thread = threading.current_thread().name

        try:
            with contextlib.redirect_stdout(sys.stderr):
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
        _log_ipc(thread, method, request_id, elapsed, background, source=source, batch_size=batch_size)
        if batch_size is not None:
            result.pop('_batch_size', None)
        self._write_response(request_id, result)

    def _initialize(self, params: dict[str, Any]) -> dict[str, Any]:
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
        started_at = time.perf_counter()

        _log_initialize_step(
            'start '
            f'workspace={workspace_root} '
            f'settings={settings_module or "<unset>"} '
            f'defer_runtime={defer_runtime}'
        )
        # Resolve venv first so editable installs can be included in snapshot
        venv_info = resolve_venv_info(workspace_root)
        editable_roots: list[Path] = []
        if venv_info and venv_info.editable_installs:
            editable_roots = [Path(ei.path) for ei in venv_info.editable_installs]
            _log_initialize_step(
                f'editable_installs count={len(editable_roots)} '
                f'paths={[str(p) for p in editable_roots]}'
            )
        source_snapshot = load_cached_source_snapshot(
            workspace_root,
            extra_roots=editable_roots or None,
        )
        used_cached_source_snapshot = source_snapshot is not None
        if source_snapshot is None:
            source_snapshot = snapshot_python_sources(
                workspace_root,
                extra_roots=editable_roots or None,
            )
            save_source_snapshot(
                workspace_root,
                source_snapshot,
                extra_roots=editable_roots or None,
            )
            _log_initialize_step(
                f'snapshot_python_sources files={source_snapshot.file_count} elapsed={time.perf_counter() - started_at:.2f}s'
            )
        else:
            _log_initialize_step(
                f'load_cached_source_snapshot files={source_snapshot.file_count} elapsed={time.perf_counter() - started_at:.2f}s'
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

        if used_cached_source_snapshot:
            self._start_source_snapshot_verification(
                generation=generation,
                workspace_root=workspace_root,
                settings_module=settings_module,
                venv_info=venv_info,
                editable_roots=editable_roots,
                initialized_state=initialized_state,
            )
        elif initialized_state.runtime_deferred:
            self._start_runtime_warmup(
                generation=generation,
                initialized_at=initialized_state.initialized_at,
                workspace_root=workspace_root,
                workspace_profile=initialized_state.workspace_profile,
                static_index=initialized_state.static_index,
                runtime_source_fingerprint=initialized_state.runtime_source_fingerprint,
                settings_module=initialized_state.effective_settings_module,
                source_snapshot=initialized_state.source_snapshot,
            )

        return self._initialize_response(
            initialized_state,
            venv_info=venv_info,
        )

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
    ) -> _InitializedState | None:
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
        static_index, cache_hit_kind = load_cached_static_index(
            workspace_root,
            source_snapshot,
        )
        if static_index is None:
            static_index = build_static_index(
                workspace_root,
                python_files=source_snapshot.files,
            )
            _log_initialize_step(
                'build_static_index '
                f'files={static_index.python_file_count} '
                f'models={static_index.model_candidate_count} '
                f'reexports={static_index.reexport_module_count} '
                f'elapsed={time.perf_counter() - started_at:.2f}s'
            )
            save_static_index(workspace_root, source_snapshot, static_index)
        elif cache_hit_kind == 'partial':
            _log_initialize_step(
                'load_cached_static_index(partial) '
                f'files={static_index.python_file_count} '
                f'models={static_index.model_candidate_count} '
                f'elapsed={time.perf_counter() - started_at:.2f}s'
            )
            save_static_index(workspace_root, source_snapshot, static_index)
        else:
            _log_initialize_step(
                'load_cached_static_index(full) '
                f'files={static_index.python_file_count} '
                f'models={static_index.model_candidate_count} '
                f'elapsed={time.perf_counter() - started_at:.2f}s'
            )

        runtime_source_fingerprint = _runtime_source_fingerprint(
            source_snapshot=source_snapshot,
            static_index=static_index,
            settings_module=effective_settings_module,
        )
        runtime = load_cached_runtime_inspection(
            workspace_root,
            runtime_source_fingerprint,
            effective_settings_module,
        )
        runtime_deferred = False
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
                runtime = inspect_runtime(effective_settings_module)
                save_runtime_inspection(
                    workspace_root,
                    runtime_source_fingerprint,
                    effective_settings_module,
                    runtime,
                )
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
        model_graph = build_model_graph(static_index, runtime)
        edge_count = sum(
            len(edges)
            for edges in model_graph.edges_by_source_label.values()
        )
        _log_initialize_step(
            'build_model_graph '
            f'models={len(model_graph.nodes_by_label)} '
            f'edges={edge_count} '
            f'elapsed={time.perf_counter() - started_at:.2f}s'
        )

        runtime_cache_fingerprint = _runtime_cache_fingerprint(runtime)
        surface_index = load_cached_surface_index(
            workspace_root,
            source_fingerprint=source_snapshot.fingerprint,
            runtime_fingerprint=runtime_cache_fingerprint,
        )
        surface_index_status = 'load_cached'
        should_prebuild_surface_index = False
        if surface_index is None:
            if static_index.model_candidate_count <= INITIAL_SYNC_SURFACE_INDEX_MODEL_LIMIT:
                surface_index = prebuild_member_surface_cache(static_index, runtime)
                save_surface_index(
                    workspace_root,
                    source_fingerprint=source_snapshot.fingerprint,
                    runtime_fingerprint=runtime_cache_fingerprint,
                    surface_index=surface_index,
                )
                surface_index_status = 'prebuild'
            else:
                surface_index = {}
                surface_index_status = 'defer_prebuild'
                should_prebuild_surface_index = True

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
        ):
            return None

        _log_initialize_step(
            f'{surface_index_status}_surface_index models={len(surface_index)} '
            f'elapsed={time.perf_counter() - started_at:.2f}s'
        )

        model_names = self._build_model_names(model_graph)
        static_fallback = self._build_static_fallback(
            model_graph=model_graph,
            surface_index=surface_index,
        )

        self._last_surface_index = surface_index
        self._last_model_names = model_names
        self._last_static_fallback = static_fallback
        self._rebuild_bg_pool()
        if should_prebuild_surface_index:
            self._start_surface_index_prebuild(
                generation=generation,
                workspace_root=workspace_root,
                source_snapshot=source_snapshot,
                static_index=static_index,
                runtime=runtime,
                health_snapshot=health_snapshot,
                model_graph=model_graph,
                model_names=model_names,
            )
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
            custom_lookups=runtime.custom_lookups if runtime else {},
            static_fallback=static_fallback,
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
            'health': initialized_state.health_snapshot,
            'modelNames': initialized_state.model_names,
            'surfaceIndex': initialized_state.surface_index,
            'customLookups': initialized_state.custom_lookups,
            'venvInfo': venv_info.to_dict() if venv_info else None,
            'staticFallback': initialized_state.static_fallback,
        }

    def _surface_index_notification(
        self,
        initialized_state: _InitializedState,
    ) -> dict[str, Any]:
        return {
            'health': initialized_state.health_snapshot,
            'modelNames': initialized_state.model_names,
            'surfaceIndex': initialized_state.surface_index,
            'customLookups': initialized_state.custom_lookups,
            'staticFallback': initialized_state.static_fallback,
        }

    def _build_static_fallback(
        self,
        *,
        model_graph: ModelGraph,
        surface_index: dict[str, object],
    ) -> dict[str, dict[str, list[str]]] | None:
        static_fallback: dict[str, dict[str, list[str]]] = {}
        runtime_labels = set(surface_index.keys())
        for node in model_graph.nodes_by_label.values():
            candidate = node.model_candidate
            if candidate is None or candidate.is_abstract or node.label in runtime_labels:
                continue
            fields_for = model_graph.fields_for_model(node.label)
            scalar_names: list[str] = []
            relation_names: list[str] = []
            for field in fields_for:
                if field.relation_direction == 'reverse':
                    continue
                if field.is_relation:
                    relation_names.append(field.name)
                else:
                    scalar_names.append(field.name)
            if scalar_names or relation_names:
                static_fallback[node.label] = {
                    'fields': scalar_names,
                    'relations': relation_names,
                }
        return static_fallback if static_fallback else None

    def _build_model_names(self, model_graph: ModelGraph) -> list[str]:
        return sorted(model_graph.nodes_by_object_name.keys())

    def _start_surface_index_prebuild(
        self,
        *,
        generation: int,
        workspace_root: Path,
        source_snapshot: PythonSourceSnapshot,
        static_index: StaticIndex,
        runtime: RuntimeInspection,
        health_snapshot: dict[str, Any],
        model_graph: ModelGraph,
        model_names: list[str],
    ) -> None:
        def worker() -> None:
            started_at = time.perf_counter()
            try:
                surface_index = prebuild_member_surface_cache(static_index, runtime)
                save_surface_index(
                    workspace_root,
                    source_fingerprint=source_snapshot.fingerprint,
                    runtime_fingerprint=_runtime_cache_fingerprint(runtime),
                    surface_index=surface_index,
                )
                static_fallback = self._build_static_fallback(
                    model_graph=model_graph,
                    surface_index=surface_index,
                )
                with self._state_lock:
                    if generation != self._state_generation:
                        return
                    self._last_surface_index = surface_index
                    self._last_model_names = model_names
                    self._last_static_fallback = static_fallback

                _log_initialize_step(
                    'prebuild_surface_index(background) '
                    f'models={len(surface_index)} '
                    f'elapsed={time.perf_counter() - started_at:.2f}s'
                )
                self._write_notification(
                    'surfaceIndexChanged',
                    {
                        'health': health_snapshot,
                        'modelNames': model_names,
                        'surfaceIndex': surface_index,
                        'customLookups': runtime.custom_lookups,
                        'staticFallback': static_fallback,
                    },
                )
            except Exception:
                print(
                    '[initialize] prebuild_surface_index(background) failed '
                    f'{traceback.format_exc(limit=6)}',
                    file=sys.stderr,
                    flush=True,
                )

        threading.Thread(
            target=worker,
            name='surface-index-prebuild',
            daemon=True,
        ).start()

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
        verify_started_at = time.perf_counter()
        verified_snapshot = snapshot_python_sources(
            workspace_root,
            extra_roots=editable_roots or None,
        )
        snapshot_changed = (
            verified_snapshot.fingerprint
            != initialized_state.source_snapshot.fingerprint
        )
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
                )
            return

        save_source_snapshot(
            workspace_root,
            verified_snapshot,
            extra_roots=editable_roots or None,
        )
        refreshed_at = datetime.now(timezone.utc)
        refreshed_generation = self._reserve_state_generation(
            workspace_root=workspace_root,
            initialized_at=refreshed_at,
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
        )
        if refreshed_state is None:
            return

        self._write_notification(
            'surfaceIndexChanged',
            self._surface_index_notification(refreshed_state),
        )

    def _reindex_file(self, params: dict[str, Any]) -> dict[str, Any]:
        file_path_str = params.get('filePath')
        if not file_path_str:
            return {'error': 'filePath is required'}

        file_path = Path(str(file_path_str)).resolve()

        with self._state_lock:
            static_index = self.static_index
            runtime = self.runtime_inspection

        if static_index is None:
            return {'error': 'not initialized'}

        # Verify file is within workspace
        try:
            file_path.relative_to(self.workspace_root)
        except ValueError:
            return {'error': 'file outside workspace'}

        started = time.perf_counter()
        new_static_index, old_labels, new_labels = reindex_single_file(
            root=self.workspace_root,
            file_path=file_path,
            existing_static_index=static_index,
        )

        affected_labels = old_labels | new_labels
        if not affected_labels and new_static_index is static_index:
            # No changes (e.g. syntax error, no model changes)
            elapsed = time.perf_counter() - started
            print(
                f'[PERF] reindexFile: no changes {elapsed:.3f}s',
                file=sys.stderr,
            )
            return {
                'surfaceIndex': self._last_surface_index or {},
                'modelNames': self._last_model_names or [],
                'staticFallback': self._last_static_fallback,
            }

        # Also invalidate reverse-relation targets: models that reference
        # affected models may have changed reverse relations.
        reverse_affected: set[str] = set()
        for candidate in new_static_index.model_candidates:
            if candidate.is_abstract:
                continue
            for field in new_static_index.fields_for_model(candidate.label):
                if field.is_relation and field.related_model_label in affected_labels:
                    reverse_affected.add(candidate.label)
        affected_labels = affected_labels | reverse_affected

        # Update static index
        model_graph = build_model_graph(new_static_index, runtime)
        with self._state_lock:
            self.static_index = new_static_index
            self.model_graph = model_graph

        # Rebuild surface for affected models only
        existing_surface = self._last_surface_index or {}
        if runtime is None:
            runtime = create_pending_runtime_inspection()

        surface_index = rebuild_surface_for_models(
            new_static_index, runtime, affected_labels, existing_surface,
        )

        # Build model names
        model_names = self._build_model_names(model_graph)

        # Build staticFallback for affected models
        static_fallback: dict[str, dict[str, list[str]]] = {}
        if self._last_static_fallback:
            static_fallback = dict(self._last_static_fallback)
        for label in affected_labels:
            static_fallback.pop(label, None)
        runtime_labels = set(surface_index.keys())
        for node in model_graph.nodes_by_label.values():
            candidate = node.model_candidate
            if candidate is None or candidate.is_abstract or node.label in runtime_labels:
                continue
            if node.label not in affected_labels:
                continue
            fields_for = model_graph.fields_for_model(node.label)
            scalar_names: list[str] = []
            relation_names: list[str] = []
            for f in fields_for:
                if f.relation_direction == 'reverse':
                    continue
                if f.is_relation:
                    relation_names.append(f.name)
                else:
                    scalar_names.append(f.name)
            if scalar_names or relation_names:
                static_fallback[node.label] = {
                    'fields': scalar_names,
                    'relations': relation_names,
                }

        # Cache for next request
        self._last_surface_index = surface_index
        self._last_model_names = model_names
        self._last_static_fallback = static_fallback if static_fallback else None

        # Refresh background workers with updated state.
        self._rebuild_bg_pool()

        elapsed = time.perf_counter() - started
        print(
            f'[PERF] reindexFile: {len(affected_labels)} affected '
            f'{elapsed:.3f}s',
            file=sys.stderr,
        )

        return {
            'surfaceIndex': surface_index,
            'modelNames': model_names,
            'staticFallback': static_fallback if static_fallback else None,
        }

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
        base_model_label = _clean_optional_string(params.get('baseModelLabel'))
        prefix = _clean_optional_string(params.get('prefix')) or ''
        method = _clean_optional_string(params.get('method'))
        if base_model_label is None or method is None:
            raise ValueError(
                '`baseModelLabel` and `method` are required for lookupPathCompletions.'
            )

        return list_lookup_path_completions(
            model_graph=model_graph,
            runtime=runtime,
            base_model_label=base_model_label,
            prefix=prefix,
            method=method,
        )

    def _resolve_lookup_path(self, params: dict[str, Any]) -> dict[str, Any]:
        _static_index, runtime, model_graph = self._require_graph_feature_state()
        base_model_label = _clean_optional_string(params.get('baseModelLabel'))
        value = _clean_optional_string(params.get('value'))
        method = _clean_optional_string(params.get('method'))
        if base_model_label is None or value is None or method is None:
            raise ValueError(
                '`baseModelLabel`, `value`, and `method` are required for resolveLookupPath.'
            )

        return resolve_lookup_path(
            model_graph=model_graph,
            runtime=runtime,
            base_model_label=base_model_label,
            path=value,
            method=method,
        )

    def _orm_member_completions(self, params: dict[str, Any]) -> dict[str, Any]:
        static_index, runtime = self._require_feature_state()
        model_label = _clean_optional_string(params.get('modelLabel'))
        receiver_kind = _clean_optional_string(params.get('receiverKind'))
        prefix = _clean_optional_string(params.get('prefix')) or ''
        manager_name = _clean_optional_string(params.get('managerName'))
        if model_label is None or receiver_kind is None:
            raise ValueError(
                '`modelLabel` and `receiverKind` are required for ormMemberCompletions.'
            )

        return list_orm_member_completions(
            static_index=static_index,
            runtime=runtime,
            model_label=model_label,
            receiver_kind=receiver_kind,
            prefix=prefix,
            manager_name=manager_name,
        )

    def _resolve_orm_member(self, params: dict[str, Any]) -> dict[str, Any]:
        static_index, runtime = self._require_feature_state()
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
            model_label=model_label,
            receiver_kind=receiver_kind,
            name=name,
            manager_name=manager_name,
        )

    def _resolve_orm_member_batch(self, params: dict[str, Any]) -> dict[str, Any]:
        """Batch resolve multiple ORM members in a single IPC call."""
        static_index, runtime = self._require_feature_state()
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
        static_index, runtime = self._require_feature_state()
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
    ) -> int:
        with self._state_lock:
            self._state_generation += 1
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
    ) -> bool:
        with self._state_lock:
            if generation != self._state_generation:
                return False

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
    ) -> None:
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
    ) -> None:
        started_at = time.perf_counter()
        runtime = inspect_runtime(settings_module)
        save_runtime_inspection(
            workspace_root,
            runtime_source_fingerprint,
            settings_module,
            runtime,
        )
        model_graph = build_model_graph(static_index, runtime)
        semantic_graph = build_semantic_graph(workspace_profile, static_index, runtime)
        health_snapshot = build_health_snapshot(
            workspace=workspace_profile,
            static_index=static_index,
            runtime=runtime,
            semantic_graph=semantic_graph,
            initialized_at=initialized_at,
        )
        _log_initialize_step(
            'inspect_runtime(background) '
            f'status={runtime.bootstrap_status} '
            f'django_importable={runtime.django_importable} '
            f'elapsed={time.perf_counter() - started_at:.2f}s'
        )

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
        ):
            return

        self._last_model_names = self._build_model_names(model_graph)
        if self._last_surface_index is not None:
            self._last_static_fallback = self._build_static_fallback(
                model_graph=model_graph,
                surface_index=self._last_surface_index,
            )

        # Runtime warmup produced better state; refresh worker pool.
        self._rebuild_bg_pool()

        self._write_notification(
            'healthChanged',
            {
                'health': health_snapshot,
            },
        )

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

    def _write_notification(self, event: str, params: dict[str, Any]) -> None:
        self._write_message(
            {
                'event': event,
                'params': params,
            }
        )

    def _write_message(self, payload: dict[str, Any]) -> None:
        with self._write_lock:
            self._real_stdout.write(json.dumps(payload, sort_keys=True) + '\n')
            self._real_stdout.flush()


def _clean_optional_string(value: Any) -> str | None:
    if value is None:
        return None

    text = str(value).strip()
    return text or None


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
) -> None:
    tag = 'bg' if background else 'fg'
    status = 'ERR' if error else 'OK'
    batch_info = f' batch={batch_size}' if batch_size else ''
    print(
        f'[ipc:{tag}] [{thread}] {method}#{request_id}'
        f' source={source} {elapsed:.3f}s {status}{batch_info}',
        file=sys.stderr,
        flush=True,
    )


def _log_initialize_step(message: str) -> None:
    print(f'[initialize] {message}', file=sys.stderr, flush=True)


def _runtime_cache_fingerprint(runtime: RuntimeInspection) -> str:
    digest = hashlib.sha256()
    digest.update(runtime.bootstrap_status.encode('utf-8'))
    digest.update(b'\0')
    digest.update(str(runtime.model_count).encode('ascii'))
    digest.update(b'\0')
    digest.update(str(runtime.field_count).encode('ascii'))
    digest.update(b'\0')
    digest.update((runtime.django_version or 'none').encode('utf-8'))
    return digest.hexdigest()


def _runtime_source_fingerprint(
    *,
    source_snapshot: PythonSourceSnapshot,
    static_index: StaticIndex,
    settings_module: str | None,
) -> str:
    digest = hashlib.sha256()
    scope_roots: set[str] = set()

    if settings_module:
        scope_roots.add(settings_module.split('.', 1)[0])

    for model_candidate in static_index.model_candidates:
        scope_roots.add(model_candidate.module.split('.', 1)[0])

    if not scope_roots:
        return str(source_snapshot.fingerprint)

    for scope_root in sorted(scope_roots):
        digest.update(scope_root.encode('utf-8'))
        digest.update(b'\0')
        digest.update(
            _scope_root_fingerprint(source_snapshot, scope_root).encode('ascii')
        )
        digest.update(b'\0')

    return digest.hexdigest()


def _scope_root_fingerprint(
    source_snapshot: PythonSourceSnapshot,
    scope_root: str,
) -> str:
    directory_fingerprint = source_snapshot.directory_fingerprints.get(scope_root)
    if directory_fingerprint is not None:
        return str(directory_fingerprint)

    module_entry = source_snapshot.entries_by_path.get(f'{scope_root}.py')
    if module_entry is not None:
        return str(module_entry.fingerprint)

    return str(source_snapshot.fingerprint)
