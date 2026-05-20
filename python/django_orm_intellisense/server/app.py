from __future__ import annotations

import base64
import contextlib
import gzip
import hashlib
import json
import multiprocessing
import os
import sys
import threading
import time
import traceback
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..cache import (
    load_cached_model_graph,
    load_cached_source_snapshot,
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
    PythonSourceSnapshot,
    VenvInfo,
    WorkspaceProfile,
    discover_workspace,
    resolve_venv_info,
    snapshot_python_sources,
)
from ..features.health import build_health_snapshot
from ..features.lookup_paths import (
    resolve_lookup_path,
)
from ..features.orm_members import (
    fingerprint_json_payload,
    fingerprint_surface_index,
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
    rebuild_model_graph_for_labels,
)
from ..static_index.indexer import StaticIndex, build_static_index, reindex_single_file


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
    if not seed_labels:
        return set()

    affected = set(seed_labels)
    changed = True
    while changed:
        changed = False
        for candidate in static_index.model_candidates:
            if candidate.label in affected:
                continue
            base_labels = static_index._resolve_model_base_labels(candidate)
            if not base_labels:
                continue
            if any(base_label in affected for base_label in base_labels):
                affected.add(candidate.label)
                changed = True

    return affected - seed_labels


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
    surface_fingerprints: dict[str, str]
    custom_lookups: dict[str, list[str]]
    custom_lookups_fingerprint: str
    static_fallback: dict[str, dict[str, object]] | None
    static_fallback_fingerprint: str | None


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


def _bg_prebuild_surface_index() -> dict[str, object]:
    """Build the full surface index inside a background worker process."""
    si = _worker_static_index
    rt = _worker_runtime
    mg = _worker_model_graph
    if si is None or rt is None:
        raise RuntimeError('Background worker not initialized')
    return prebuild_member_surface_cache(si, rt, mg)


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
        self._bg_pool: ProcessPoolExecutor | None = None
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
        self._last_surface_fingerprints: dict[str, str] | None = None
        self._last_model_names: list[str] | None = None
        self._last_static_fallback: dict[str, dict[str, object]] | None = None
        self._last_static_fallback_fingerprint: str | None = None
        self._last_custom_lookups_fingerprint: str | None = None
        self._surface_prebuild_future: Any | None = None
        self._surface_load_idle_timer: threading.Timer | None = None
        self._surface_load_lock = threading.Lock()
        self._surface_load_attempted_generation: int | None = None

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

        self._cancel_surface_index_idle_load()
        if self._bg_pool is not None:
            self._bg_pool.shutdown(wait=False)
        if self._fallback_bg_pool is not None:
            self._fallback_bg_pool.shutdown(wait=False)

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
        if os.environ.get('DJLS_BG_PROCESS_POOL') != '1':
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
        try:
            self._bg_pool = ProcessPoolExecutor(
                max_workers=worker_count,
                initializer=_init_bg_worker,
                initargs=(si, rt, mg),
            )
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
                    pool=self._bg_pool,
                    token=self._bg_pool_prewarm_token,
                    worker_count=warm_count,
                )
        except Exception as exc:  # pragma: no cover — pickle/fork failure
            print(
                f'[pool] ProcessPoolExecutor failed ({exc}), '
                f'background requests will run on fallback thread',
                file=sys.stderr, flush=True,
            )
            self._discard_bg_pool()

    def _start_bg_pool_prewarm(
        self,
        *,
        pool: ProcessPoolExecutor,
        token: int,
        worker_count: int,
    ) -> None:
        def worker() -> None:
            started_at = time.perf_counter()
            try:
                with self._state_lock:
                    if self._bg_pool is not pool or self._bg_pool_prewarm_token != token:
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
        runtime_cache_fingerprint = _runtime_cache_fingerprint(runtime)
        model_graph = load_cached_model_graph(
            workspace_root,
            source_fingerprint=source_snapshot.fingerprint,
            runtime_fingerprint=runtime_cache_fingerprint,
        )
        if model_graph is None:
            model_graph = build_model_graph(static_index, runtime)
            save_model_graph(
                workspace_root,
                source_fingerprint=source_snapshot.fingerprint,
                runtime_fingerprint=runtime_cache_fingerprint,
                model_graph=model_graph,
            )
            model_graph_status = 'build_model_graph'
        else:
            model_graph_status = 'load_cached_model_graph'
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

        # 옵션 D — surface_index 는 main initialize 에서 로드하지 않는다.
        # cache load/prebuild 는 idle/on-demand 경로로 미뤄 cold-start 작업량을
        # 거의 0에 가깝게 유지한다.
        surface_index: dict[str, object] = {}
        surface_index_status = 'defer_load_or_prebuild'
        should_schedule_surface_index_load = not runtime_deferred

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
        custom_lookups_fingerprint = fingerprint_json_payload(custom_lookups)

        self._last_surface_index = surface_index
        self._last_surface_fingerprints = surface_fingerprints
        self._last_model_names = model_names
        self._last_static_fallback = static_fallback
        self._last_static_fallback_fingerprint = static_fallback_fingerprint
        self._last_custom_lookups_fingerprint = custom_lookups_fingerprint
        self._discard_bg_pool()
        if should_schedule_surface_index_load:
            self._schedule_surface_index_idle_load(
                reason='initialize',
                expected_generation=generation,
            )
        # 옵션 A2 — runtime field registry 를 background 에서 미리 빌드.
        # captain 의 첫 resolveLookupPath IPC 2.8s 폭주가 lazy `django.setup()`
        # 때문 (옵션 6 분석 확정). initialize 응답 직전에 thread 시작 → 사용자가
        # 첫 IPC 보낼 무렵 ready. 안 ready 면 lock 에서 wait (1회만 손해).
        self._start_runtime_field_registry_prewarm(runtime)
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
            custom_lookups_fingerprint=custom_lookups_fingerprint,
            static_fallback=static_fallback,
            static_fallback_fingerprint=static_fallback_fingerprint,
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
            'surfaceFingerprints': initialized_state.surface_fingerprints,
            'customLookups': initialized_state.custom_lookups,
            'customLookupsFingerprint': initialized_state.custom_lookups_fingerprint,
            'venvInfo': venv_info.to_dict() if venv_info else None,
            'staticFallback': initialized_state.static_fallback,
            'staticFallbackFingerprint': initialized_state.static_fallback_fingerprint,
        }

    def _surface_index_notification(
        self,
        initialized_state: _InitializedState,
    ) -> dict[str, Any]:
        return {
            'health': initialized_state.health_snapshot,
            'modelNames': initialized_state.model_names,
            'surfaceIndex': initialized_state.surface_index,
            'surfaceFingerprints': initialized_state.surface_fingerprints,
            'customLookups': initialized_state.custom_lookups,
            'customLookupsFingerprint': initialized_state.custom_lookups_fingerprint,
            'staticFallback': initialized_state.static_fallback,
            'staticFallbackFingerprint': initialized_state.static_fallback_fingerprint,
        }

    def _build_static_fallback(
        self,
        *,
        model_graph: ModelGraph,
        surface_index: dict[str, object],
    ) -> dict[str, dict[str, object]] | None:
        static_fallback: dict[str, dict[str, object]] = {}
        runtime_labels = set(surface_index.keys())
        for node in model_graph.nodes_by_label.values():
            candidate = node.model_candidate
            if candidate is None or candidate.is_abstract or node.label in runtime_labels:
                continue
            fields_for = model_graph.fields_for_model(node.label)
            scalar_names: list[str] = []
            relation_names: list[str] = []
            reverse_relation_names: list[str] = []
            field_details: dict[str, dict[str, object]] = {}
            for field in fields_for:
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
            if scalar_names or relation_names or reverse_relation_names:
                static_fallback[node.label] = {
                    'fields': scalar_names,
                    'relations': relation_names,
                    'reverseRelations': reverse_relation_names,
                    'fieldDetails': field_details,
                }
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
    ) -> None:
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
        if delay_seconds <= 0:
            self._request_surface_index_load(
                reason=f'idle:{reason}',
                expected_generation=expected_generation,
            )
            return

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
            model_names = self._last_model_names

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
        if model_names is None:
            model_names = self._build_model_names(model_graph)

        self._start_surface_index_prebuild(
            generation=generation,
            workspace_root=workspace_root,
            source_snapshot=source_snapshot,
            static_index=static_index,
            runtime=runtime,
            health_snapshot=health_snapshot,
            model_graph=model_graph,
            model_names=model_names,
            reason=reason,
        )

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
        reason: str,
    ) -> None:
        started_at = time.perf_counter()

        def _apply_surface_index(
            surface_index: dict[str, object],
            *,
            from_cache: bool = False,
        ) -> None:
            surface_fingerprints = fingerprint_surface_index(surface_index)
            # 옵션 D — cache 에서 로드한 경우 디스크 재기록 불필요.
            if not from_cache:
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
            static_fallback_fingerprint = (
                fingerprint_json_payload(static_fallback)
                if static_fallback
                else None
            )
            custom_lookups_fingerprint = fingerprint_json_payload(
                runtime.custom_lookups
            )
            with self._state_lock:
                if generation != self._state_generation:
                    return
                self._last_surface_index = surface_index
                self._last_surface_fingerprints = surface_fingerprints
                self._last_model_names = model_names
                self._last_static_fallback = static_fallback
                self._last_static_fallback_fingerprint = static_fallback_fingerprint
                self._last_custom_lookups_fingerprint = custom_lookups_fingerprint
                with self._surface_load_lock:
                    self._surface_load_attempted_generation = generation

            stage = 'load_cached' if from_cache else 'prebuild'
            _log_initialize_step(
                f'{stage}_surface_index(background) '
                f'reason={reason} '
                f'models={len(surface_index)} '
                f'elapsed={time.perf_counter() - started_at:.2f}s'
            )
            self._write_notification(
                'surfaceIndexChanged',
                {
                    'health': health_snapshot,
                    'modelNames': model_names,
                    'surfaceIndex': surface_index,
                    'surfaceFingerprints': surface_fingerprints,
                    'customLookups': runtime.custom_lookups,
                    'customLookupsFingerprint': custom_lookups_fingerprint,
                    'staticFallback': static_fallback,
                    'staticFallbackFingerprint': static_fallback_fingerprint,
                },
            )

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
                cached = load_cached_surface_index(
                    workspace_root,
                    source_fingerprint=source_snapshot.fingerprint,
                    runtime_fingerprint=_runtime_cache_fingerprint(runtime),
                )
                if cached is not None:
                    # captain regression: cache hit 케이스도 graph gap 진단
                    # 으로그를 출력해야 db.Company 같은 누락 가시화.
                    from django_orm_intellisense.features.orm_members import (
                        log_surface_index_gap,
                    )
                    log_surface_index_gap(static_index, model_graph, cached)
                    _apply_surface_index(cached, from_cache=True)
                    return

                if os.environ.get('DJLS_SURFACE_PREBUILD_ON_MISS') != '1':
                    with self._surface_load_lock:
                        self._surface_load_attempted_generation = generation
                    _log_initialize_step(
                        'skip_prebuild_surface_index(background) '
                        f'reason=cache_miss trigger={reason} '
                        f'elapsed={time.perf_counter() - started_at:.2f}s'
                    )
                    return

                # cache miss — opt-in prebuild off the main daemon process. A
                # long-lived pool is also opt-in; otherwise use a single
                # short-lived worker so memory is returned after the cache is
                # written.
                if self._bg_pool is not None:
                    future = self._bg_pool.submit(_bg_prebuild_surface_index)
                    surface_index = future.result()
                else:
                    with ProcessPoolExecutor(
                        max_workers=1,
                        initializer=_init_bg_worker,
                        initargs=(static_index, runtime, model_graph),
                    ) as pool:
                        future = pool.submit(_bg_prebuild_surface_index)
                        surface_index = future.result()
                _apply_surface_index(surface_index, from_cache=False)
            except Exception:
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

    def _start_runtime_field_registry_prewarm(
        self,
        runtime: RuntimeInspection,
    ) -> None:
        """daemon initialize 끝에 호출. background thread 가 Django setup +
        runtime field registry build 를 미리 진행. captain 의 첫 IPC 폭주(2.8s)
        가 사용자 응답 대기 시간이 아니라 background 시간으로 이동.
        """
        if runtime.bootstrap_status != 'ready' or not runtime.settings_module:
            return

        from ..runtime.inspector import _ensure_runtime_field_registry

        settings_module = runtime.settings_module

        def _bg_prewarm() -> None:
            started = time.perf_counter()
            try:
                _ensure_runtime_field_registry(settings_module)
            except Exception:
                print(
                    '[initialize] runtime_field_registry(background) failed '
                    f'{traceback.format_exc(limit=6)}',
                    file=sys.stderr, flush=True,
                )
                return
            elapsed_ms = (time.perf_counter() - started) * 1000
            _log_initialize_step(
                f'runtime_field_registry(background) ready '
                f'elapsed={elapsed_ms:.0f}ms'
            )

        thread = threading.Thread(
            target=_bg_prewarm,
            name='runtime-field-registry-prewarm',
            daemon=True,
        )
        thread.start()

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
        if not affected_labels:
            # No model changes — static index structure may be rebuilt but
            # model surfaces are identical. Skip the expensive surface rebuild
            # and return unchanged to avoid sending the 18MB+ payload.
            if new_static_index is not static_index:
                with self._state_lock:
                    self.static_index = new_static_index
            elapsed = time.perf_counter() - started
            print(
                f'[PERF] reindexFile: no changes {elapsed:.3f}s',
                file=sys.stderr,
            )
            return {'unchanged': True}

        # Inheritance changes propagate beyond the edited module: when an
        # abstract/base model changes, every descendant model that inherits its
        # fields must refresh lookup/hover/diagnostic surfaces as well.
        affected_labels |= _inheritance_dependent_labels(static_index, affected_labels)
        affected_labels |= _inheritance_dependent_labels(new_static_index, affected_labels)

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

        # Update static index and refresh only the graph slices touched by this
        # file and by reverse-relation invalidation.
        previous_model_graph = self.model_graph
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
        with self._state_lock:
            self.static_index = new_static_index
            self.model_graph = model_graph

        # Rebuild surface for affected models only
        existing_surface = self._last_surface_index or {}
        if runtime is None:
            runtime = create_pending_runtime_inspection()

        surface_index = rebuild_surface_for_models(
            new_static_index, runtime, model_graph, affected_labels, existing_surface,
        )
        removed_labels = sorted(
            label for label in affected_labels if label not in surface_index
        )
        added_labels = sorted(new_labels - old_labels)
        changed_labels = sorted(
            label for label in affected_labels
            if label in surface_index and label not in new_labels - old_labels
        )
        surface_index_delta = {
            label: surface_index[label]
            for label in sorted(affected_labels)
            if label in surface_index
        }
        surface_fingerprints = fingerprint_surface_index(
            surface_index,
            labels=set(surface_index_delta),
        )

        # Build model names
        model_names = self._build_model_names(model_graph)

        # Build staticFallback for affected models
        static_fallback: dict[str, dict[str, object]] = {}
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
        self._last_surface_fingerprints = {
            **(self._last_surface_fingerprints or {}),
            **surface_fingerprints,
        }
        for label in removed_labels:
            self._last_surface_fingerprints.pop(label, None)
        self._last_model_names = model_names
        self._last_static_fallback = static_fallback if static_fallback else None
        self._last_static_fallback_fingerprint = (
            fingerprint_json_payload(self._last_static_fallback)
            if self._last_static_fallback
            else None
        )

        # State snapshots changed; drop stale workers instead of spawning
        # fresh processes during edit-time reindex.
        self._discard_bg_pool()

        elapsed = time.perf_counter() - started
        print(
            f'[PERF] reindexFile: {len(affected_labels)} affected '
            f'{elapsed:.3f}s',
            file=sys.stderr,
        )

        return {
            'surfaceIndexDelta': surface_index_delta,
            'surfaceFingerprints': surface_fingerprints,
            'staticFallback': static_fallback if static_fallback else None,
            'staticFallbackFingerprint': self._last_static_fallback_fingerprint,
            'addedLabels': added_labels,
            'changedLabels': changed_labels,
            'removedLabels': removed_labels,
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
        # Rust fast-path + TS local index are authoritative. This Python
        # stub exists only so the IPC surface stays backward-compatible;
        # it returns an empty result so the caller shows no completions.
        del params
        return {'items': [], 'resolved': False, 'reason': 'handled_by_native'}

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
    ) -> int:
        self._cancel_surface_index_idle_load()
        with self._surface_load_lock:
            self._surface_load_attempted_generation = None
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
        runtime_cache_fingerprint = _runtime_cache_fingerprint(runtime)
        model_graph = build_model_graph(static_index, runtime)
        save_model_graph(
            workspace_root,
            source_fingerprint=source_snapshot.fingerprint,
            runtime_fingerprint=runtime_cache_fingerprint,
            model_graph=model_graph,
        )
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
            self._last_static_fallback_fingerprint = (
                fingerprint_json_payload(self._last_static_fallback)
                if self._last_static_fallback
                else None
            )
        self._last_custom_lookups_fingerprint = fingerprint_json_payload(
            runtime.custom_lookups
        )

        # Runtime warmup produced better state; drop stale workers. Surface
        # cache/prebuild stays idle/on-demand so warmup completion does not
        # immediately spend cache IO or prebuild CPU.
        self._discard_bg_pool()
        self._schedule_surface_index_idle_load(
            reason='runtime_warmup',
            expected_generation=generation,
        )

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
            serialized = json.dumps(payload, sort_keys=True)
            request_id = payload.get('id')
            raw_size_kb = len(serialized) / 1024
            # 옵션 C — payload 가 임계값을 넘으면 gzip+base64 로 wrap.
            # captain log.txt 의 initialize 22.8MB 가 한 줄 stdout 송신 +
            # JSON.parse 비용을 모두 부담함. gzip 으로 ~10x 압축 가능.
            line, kind = _maybe_compress_ipc_payload(serialized)
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
            self._real_stdout.write(line + '\n')
            self._real_stdout.flush()


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
