from __future__ import annotations

import contextlib
import hashlib
import json
import sys
import threading
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..cache import (
    load_cached_runtime_inspection,
    load_cached_static_index,
    load_cached_surface_index,
    save_runtime_inspection,
    save_static_index,
    save_surface_index,
)
from ..discovery.workspace import (
    PythonSourceSnapshot,
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
from ..semantic.graph import SemanticGraphSummary, build_semantic_graph
from ..static_index.indexer import StaticIndex, build_static_index


class DaemonServer:
    def __init__(self, workspace_root: Path):
        self.workspace_root = workspace_root
        self.initialized_at = datetime.now(timezone.utc)
        self.health_snapshot: dict[str, Any] | None = None
        self.workspace_profile: WorkspaceProfile | None = None
        self.static_index: StaticIndex | None = None
        self.runtime_inspection: RuntimeInspection | None = None
        self.semantic_graph: SemanticGraphSummary | None = None
        self._state_generation = 0
        self._state_lock = threading.RLock()
        self._write_lock = threading.Lock()

    def run_stdio(self) -> None:
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

            self._handle_request(request)

    def _handle_request(self, request: dict[str, Any]) -> None:
        request_id = request.get('id')
        method = request.get('method')
        params = request.get('params') or {}

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
                elif method == 'resolveOrmMemberChain':
                    result = self._resolve_orm_member_chain(params)
                else:
                    raise ValueError(f'Unsupported method: {method}')
        except Exception as error:  # pragma: no cover - scaffold safety net
            self._write_error(
                request_id=request_id,
                code='internal_error',
                message=str(error),
                data={'traceback': traceback.format_exc(limit=8)},
            )
            return

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
        source_snapshot = snapshot_python_sources(workspace_root)
        _log_initialize_step(
            f'snapshot_python_sources files={source_snapshot.file_count} elapsed={time.perf_counter() - started_at:.2f}s'
        )
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
        venv_info = resolve_venv_info(workspace_root)
        if venv_info:
            _log_initialize_step(
                f'resolve_venv_info root={venv_info.root} '
                f'python={venv_info.python_version or "<unknown>"} '
                f'site_packages={"yes" if venv_info.site_packages else "no"} '
                f'elapsed={time.perf_counter() - started_at:.2f}s'
            )
        static_index, cache_hit_kind = load_cached_static_index(workspace_root, source_snapshot)
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
        self._apply_state(
            generation=generation,
            initialized_at=initialized_at,
            workspace_profile=workspace_profile,
            static_index=static_index,
            runtime=runtime,
            semantic_graph=semantic_graph,
            health_snapshot=health_snapshot,
        )
        runtime_cache_fingerprint = _runtime_cache_fingerprint(runtime)
        cached_surface = load_cached_surface_index(
            workspace_root,
            source_fingerprint=source_snapshot.fingerprint,
            runtime_fingerprint=runtime_cache_fingerprint,
        )
        if cached_surface is not None:
            surface_index = cached_surface
            _log_initialize_step(
                f'load_cached_surface_index models={len(surface_index)} '
                f'elapsed={time.perf_counter() - started_at:.2f}s'
            )
        else:
            surface_index = prebuild_member_surface_cache(static_index, runtime)
            save_surface_index(
                workspace_root,
                source_fingerprint=source_snapshot.fingerprint,
                runtime_fingerprint=runtime_cache_fingerprint,
                surface_index=surface_index,
            )
            _log_initialize_step(
                f'prebuild_member_surface_cache models={len(surface_index)} '
                f'elapsed={time.perf_counter() - started_at:.2f}s'
            )
        _log_initialize_step(
            f'complete elapsed={time.perf_counter() - started_at:.2f}s'
        )
        if runtime_deferred:
            self._start_runtime_warmup(
                generation=generation,
                initialized_at=initialized_at,
                workspace_root=workspace_root,
                workspace_profile=workspace_profile,
                static_index=static_index,
                runtime_source_fingerprint=runtime_source_fingerprint,
                settings_module=effective_settings_module,
            )

        model_names = sorted({
            c.object_name
            for c in static_index.model_candidates
            if not c.is_abstract
        })

        # Build staticFallback for models present in static_index but missing
        # from the runtime surfaceIndex (e.g. import errors, circular deps).
        static_fallback: dict[str, dict[str, list[str]]] = {}
        runtime_labels = set(surface_index.keys())
        for candidate in static_index.model_candidates:
            if candidate.is_abstract or candidate.label in runtime_labels:
                continue
            fields_for = static_index.fields_for_model(candidate.label)
            scalar_names: list[str] = []
            relation_names: list[str] = []
            for f in fields_for:
                if f.is_relation:
                    relation_names.append(f.name)
                else:
                    scalar_names.append(f.name)
            if scalar_names or relation_names:
                static_fallback[candidate.label] = {
                    'fields': scalar_names,
                    'relations': relation_names,
                }

        return {
            'serverName': 'django-orm-intellisense',
            'protocolVersion': '0.1',
            'health': health_snapshot,
            'modelNames': model_names,
            'surfaceIndex': surface_index,
            'customLookups': runtime.custom_lookups if runtime else {},
            'venvInfo': venv_info.to_dict() if venv_info else None,
            'staticFallback': static_fallback if static_fallback else None,
        }

    def _health(self) -> dict[str, Any]:
        with self._state_lock:
            snapshot = self.health_snapshot

        if snapshot is None:
            return self._initialize({})

        return snapshot

    def _relation_targets(self, params: dict[str, Any]) -> dict[str, Any]:
        static_index, runtime = self._require_feature_state()
        prefix = _clean_optional_string(params.get('prefix'))
        targets = list_relation_targets(
            static_index=static_index,
            runtime=runtime,
            prefix=prefix,
        )
        return {
            'items': targets,
        }

    def _resolve_relation_target(self, params: dict[str, Any]) -> dict[str, Any]:
        static_index, runtime = self._require_feature_state()
        value = _clean_optional_string(params.get('value'))
        if value is None:
            raise ValueError('`value` is required for resolveRelationTarget.')

        return resolve_relation_target(
            static_index=static_index,
            runtime=runtime,
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
        static_index, runtime = self._require_feature_state()
        base_model_label = _clean_optional_string(params.get('baseModelLabel'))
        prefix = _clean_optional_string(params.get('prefix')) or ''
        method = _clean_optional_string(params.get('method'))
        if base_model_label is None or method is None:
            raise ValueError(
                '`baseModelLabel` and `method` are required for lookupPathCompletions.'
            )

        return list_lookup_path_completions(
            static_index=static_index,
            runtime=runtime,
            base_model_label=base_model_label,
            prefix=prefix,
            method=method,
        )

    def _resolve_lookup_path(self, params: dict[str, Any]) -> dict[str, Any]:
        static_index, runtime = self._require_feature_state()
        base_model_label = _clean_optional_string(params.get('baseModelLabel'))
        value = _clean_optional_string(params.get('value'))
        method = _clean_optional_string(params.get('method'))
        if base_model_label is None or value is None or method is None:
            raise ValueError(
                '`baseModelLabel`, `value`, and `method` are required for resolveLookupPath.'
            )

        return resolve_lookup_path(
            static_index=static_index,
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
            self._initialize({})

        with self._state_lock:
            static_index = self.static_index
            runtime = self.runtime_inspection

        if static_index is None or runtime is None:
            raise RuntimeError('Daemon state is unavailable.')

        return static_index, runtime

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
        workspace_profile: WorkspaceProfile,
        static_index: StaticIndex,
        runtime: RuntimeInspection,
        semantic_graph: SemanticGraphSummary,
        health_snapshot: dict[str, Any],
    ) -> bool:
        with self._state_lock:
            if generation != self._state_generation:
                return False

            self.initialized_at = initialized_at
            self.workspace_profile = workspace_profile
            self.static_index = static_index
            self.runtime_inspection = runtime
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
    ) -> None:
        started_at = time.perf_counter()
        runtime = inspect_runtime(settings_module)
        save_runtime_inspection(
            workspace_root,
            runtime_source_fingerprint,
            settings_module,
            runtime,
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
            workspace_profile=workspace_profile,
            static_index=static_index,
            runtime=runtime,
            semantic_graph=semantic_graph,
            health_snapshot=health_snapshot,
        ):
            return

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
            sys.stdout.write(json.dumps(payload, sort_keys=True) + '\n')
            sys.stdout.flush()


def _clean_optional_string(value: Any) -> str | None:
    if value is None:
        return None

    text = str(value).strip()
    return text or None


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
