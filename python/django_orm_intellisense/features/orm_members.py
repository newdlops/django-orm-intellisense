from __future__ import annotations

import ast
import hashlib
import inspect
import json
import os
import re
import threading
import stat
import dataclasses
import weakref
from collections.abc import Sequence
from contextvars import ContextVar
from dataclasses import dataclass
from functools import lru_cache, wraps
from operator import is_
from pathlib import Path
from types import DynamicClassAttribute
from typing import Any, get_args, get_origin, get_type_hints

from ..runtime.inspector import RuntimeInspection, runtime_field_registry_is_ready
from ..runtime.lookup_catalog import lookup_catalog_json_default
from ..semantic.graph import ModelGraph
from ..static_index.indexer import FieldCandidate, ModelCandidate, ModuleIndex, StaticIndex
from ..static_index.field_declarations import source_stat_key
from ..static_index.class_members import ClassDeclaration, ManagerCall, class_declaration, manager_call, member_source_hash
from ..static_index.source_coordinates import prepare_source_columns
from ..static_index.source_cache import latest_source_cache
from .django_builtins import (
    QUERYSET_BUILTIN_PROPERTIES,
    django_builtin_available,
    INSTANCE_BUILTIN_METHODS as _INSTANCE_BUILTINS,
    MANAGER_BUILTIN_METHODS as _MANAGER_BUILTINS,
    QUERYSET_BUILTIN_METHODS as _QUERYSET_BUILTINS,
)


class _MemberSurfaceCache:
    """One weakly owned snapshot, with atomic model invalidation."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._owner = None
        self._owner_token = object()
        self._owner_registry_ready = False
        self._list_cache: dict[
            tuple[str, str, str | None], Sequence[OrmMemberItem]
        ] = {}
        self._dict_cache: dict[
            tuple[str, str, str | None], dict[str, int]
        ] = {}
        self._keys_by_model: dict[str, set[tuple[str, str, str | None]]] = {}
        self._model_versions: dict[str, object] = {}
        self._inflight: dict[tuple[object, str], int] = {}
        self._hits = 0
        self._misses = 0

    def _matches_owner(
        self,
        static_index: StaticIndex,
        runtime: RuntimeInspection,
        model_graph: ModelGraph | None,
    ) -> bool:
        owner = self._owner
        return (owner is not None and owner[0]() is static_index and owner[1]() is runtime
                and (model_graph is not None and owner[2]() is model_graph
                     if owner[2] is not None else model_graph is None))

    def _set_owner(self, static_index, runtime, model_graph, *, clear: bool,
            registry_ready: bool | None = None) -> None:
        if clear:
            self._list_cache.clear()
            self._dict_cache.clear()
            self._keys_by_model.clear()
            self._model_versions.clear()
        self._owner = (weakref.ref(static_index), weakref.ref(runtime),
                       weakref.ref(model_graph) if model_graph is not None else None)
        self._owner_token = object()
        self._owner_registry_ready = (self._registry_ready(runtime)
            if registry_ready is None else registry_ready)
        # Only active builds can leave version entries without cached keys.
        for _, label in self._inflight:
            self._clean_model_version(label)

    def _check_owner(self, static_index, runtime, model_graph) -> None:
        registry_ready = self._registry_ready(runtime)
        if (not self._matches_owner(static_index, runtime, model_graph)
                or self._owner_registry_ready != registry_ready):
            self._set_owner(static_index, runtime, model_graph, clear=True,
                registry_ready=registry_ready)

    @staticmethod
    def _registry_ready(runtime: RuntimeInspection) -> bool:
        # Cached runtime summaries can be ready before this process's Django
        # registry. Availability is a cache epoch, checked without setup/wait.
        return bool(not runtime.detached and runtime.bootstrap_status == 'ready' and runtime.settings_module
            and runtime_field_registry_is_ready(runtime.settings_module))

    def _clean_model_version(self, label: str) -> None:
        if label not in self._keys_by_model and not self._inflight.get((self._owner_token, label)):
            self._model_versions.pop(label, None)

    def _finish_build(self, token: object, label: str) -> None:
        build_key = (token, label)
        count = self._inflight[build_key] - 1
        if count:
            self._inflight[build_key] = count
        else:
            self._inflight.pop(build_key)
        self._clean_model_version(label)

    def get_list(
        self,
        static_index: StaticIndex,
        runtime: RuntimeInspection,
        model_graph: ModelGraph | None,
        model_label: str,
        receiver_kind: str,
        manager_name: str | None,
    ) -> Sequence[OrmMemberItem]:
        key = (model_label, receiver_kind, manager_name)
        import time as _time
        while True:
            with self._lock:
                self._check_owner(static_index, runtime, model_graph)
                cached = self._list_cache.get(key)
                if cached is not None:
                    self._hits += 1
                    return cached
                self._misses += 1
                token = self._owner_token
                version = self._model_versions.setdefault(model_label, object())
                build_key = (token, model_label)
                self._inflight[build_key] = self._inflight.get(build_key, 0) + 1

            try:
                started = _time.perf_counter()
                surface = _compact_member_surface(
                    static_index=static_index,
                    runtime=runtime,
                    model_graph=model_graph,
                    model_label=model_label,
                    receiver_kind=receiver_kind,
                    manager_name=manager_name,
                )
                surface = _CachedMemberSurface(surface, model_label, manager_name)
                elapsed = _time.perf_counter() - started
                if elapsed >= 0.010:
                    print(f'[surface:miss] {model_label}/{receiver_kind} '
                          f'{elapsed:.3f}s items={len(surface)}',
                          file=__import__("sys").stderr, flush=True)
                with self._lock:
                    # An old request may finish after a newer snapshot has
                    # been adopted. Return its own result without reclaiming
                    # or clearing the current owner's cache.
                    if not self._matches_owner(static_index, runtime, model_graph):
                        return surface
                    # Django setup may have finished while this build was
                    # running. Retire its partial result under the same lock
                    # used for explicit invalidation and rebuild it below.
                    self._check_owner(static_index, runtime, model_graph)
                    cached = self._list_cache.get(key)
                    if cached is not None:
                        self._hits += 1
                        return cached
                    # Same-owner invalidation retires computations already in
                    # progress. Rebuild rather than republishing stale items.
                    if token is not self._owner_token or version is not self._model_versions.get(model_label):
                        continue
                    self._list_cache[key] = surface
                    self._dict_cache[key] = {name: position for position, name in enumerate(surface.names())}
                    self._keys_by_model.setdefault(model_label, set()).add(key)
                    return surface
            finally:
                with self._lock:
                    self._finish_build(token, model_label)

    def _invalidate_model(self, model_label: str) -> None:
        for key in self._keys_by_model.pop(model_label, ()):
            self._list_cache.pop(key, None)
            self._dict_cache.pop(key, None)
        if self._inflight.get((self._owner_token, model_label)):
            self._model_versions[model_label] = object()
        else:
            self._model_versions.pop(model_label, None)

    def invalidate_model(self, model_label: str) -> None:
        with self._lock:
            self._invalidate_model(model_label)

    def force_owner(
        self,
        static_index: StaticIndex,
        runtime: RuntimeInspection,
        model_graph: ModelGraph | None,
        *,
        previous_static_index: StaticIndex | None = None,
        previous_model_graph: ModelGraph | None = None,
        invalidated_labels: set[str] | None = None,
    ) -> None:
        """Reuse only the expected prior snapshot and invalidate atomically."""
        with self._lock:
            registry_ready = self._registry_ready(runtime)
            reusable = (previous_static_index is not None
                        and self._matches_owner(previous_static_index, runtime, previous_model_graph)
                        and self._owner_registry_ready == registry_ready)
            self._set_owner(static_index, runtime, model_graph, clear=not reusable,
                registry_ready=registry_ready)
            for label in invalidated_labels or ():
                self._invalidate_model(label)

    def rebind_runtime(
        self,
        static_index: StaticIndex,
        previous_runtime: RuntimeInspection,
        runtime: RuntimeInspection,
        model_graph: ModelGraph | None,
    ) -> None:
        """Advance a catalogue-only runtime replacement after reindex commit."""
        with self._lock:
            catalogue_only = all(
                getattr(previous_runtime, field.name) is getattr(runtime, field.name)
                for field in dataclasses.fields(RuntimeInspection) if field.name != 'lookup_catalog')
            if catalogue_only and self._matches_owner(static_index, previous_runtime, model_graph):
                registry_ready = self._registry_ready(runtime)
                self._set_owner(static_index, runtime, model_graph,
                    clear=self._owner_registry_ready != registry_ready,
                    registry_ready=registry_ready)

    def find(
        self,
        static_index: StaticIndex,
        runtime: RuntimeInspection,
        model_graph: ModelGraph | None,
        model_label: str,
        receiver_kind: str,
        name: str,
        manager_name: str | None,
    ) -> OrmMemberItem | None:
        key = (model_label, receiver_kind, manager_name)
        with self._lock:
            self._check_owner(static_index, runtime, model_graph)
            name_dict = self._dict_cache.get(key)
            if name_dict is not None:
                self._hits += 1
                position = name_dict.get(name)
                return self._list_cache[key][position] if position is not None else None
            self._misses += 1

        surface = self.get_list(
            static_index, runtime, model_graph, model_label, receiver_kind, manager_name
        )
        # A concurrent caller can switch or invalidate the global cache after
        # get_list returns. This cold lookup belongs to the returned snapshot.
        # Reverse iteration preserves the dictionary's last-name-wins rule.
        if isinstance(surface, _CachedMemberSurface):
            return surface.find(name)
        return next((item for item in reversed(surface) if item.name == name), None)


def rebind_member_surface_cache_runtime(static_index, previous_runtime, runtime, model_graph):
    """Used only for the catalogue-only dataclasses.replace in reindex commit."""
    _surface_cache.rebind_runtime(static_index, previous_runtime, runtime, model_graph)


def reuse_member_surface_cache_for_unchanged_index(previous_index, static_index, runtime, model_graph):
    _surface_cache.force_owner(static_index, runtime, model_graph,
        previous_static_index=previous_index, previous_model_graph=model_graph)


_surface_cache = _MemberSurfaceCache()
_workspace_files_cache_lock = threading.RLock()
_runtime_source_paths: ContextVar[dict[int, _RuntimeSourcePathResolver] | None] = ContextVar(
    'orm_member_runtime_source_paths', default=None)
_static_manager_bindings: ContextVar[dict[tuple[int, int, str, str, object],
    tuple[StaticIndex, ModuleIndex, dict[str, dict[str, object]]]] | None] = ContextVar(
    'orm_member_static_manager_bindings', default=None)
_runtime_callable_candidates: ContextVar[dict | None] = ContextVar(
    'orm_member_runtime_callable_candidates', default=None)
_runtime_model_catalogs: ContextVar[dict | None] = ContextVar(
    'orm_member_runtime_model_catalogs', default=None)
_runtime_member_snapshot: ContextVar[tuple | None] = ContextVar(
    'orm_member_runtime_member_snapshot', default=None)
_runtime_capture_labels: ContextVar[dict | None] = ContextVar(
    'orm_member_runtime_capture_labels', default=None)


@dataclass(frozen=True, slots=True)
class RuntimeMemberSnapshot:
    runtime_identity: tuple
    items: dict
    manager_names: dict[str, tuple[str, ...]]
    complete_labels: frozenset[str]
    invalidated_labels: frozenset[str] = frozenset()
    models: dict = dataclasses.field(default_factory=dict)


def _runtime_member_identity(runtime):
    return (runtime.python_executable, runtime.settings_module, runtime.django_version)


def _owned_runtime_members(static_index, runtime):
    snapshot = getattr(static_index, '_runtime_member_snapshot', None)
    return snapshot if (snapshot is not None and runtime.bootstrap_status == 'ready'
        and snapshot.runtime_identity == _runtime_member_identity(runtime)) else None


def runtime_member_snapshot_is_complete(static_index, runtime, model_graph, snapshot):
    if (snapshot is None or runtime.bootstrap_status != 'ready' or snapshot.invalidated_labels
            or snapshot.runtime_identity != _runtime_member_identity(runtime)):
        return False
    labels = {candidate.label for candidate in static_index.model_candidates if not candidate.is_abstract}
    if model_graph is not None:
        labels.update(node.label for node in model_graph.nodes_by_label.values()
            if node.runtime_model is not None and node.model_candidate is None)
    return snapshot.complete_labels == labels


def invalidate_runtime_members(previous_index, static_index, runtime, labels):
    """Carry immutable unchanged records; exclude edited live classes until refreshed."""
    previous = _owned_runtime_members(previous_index, runtime)
    static_index._runtime_member_snapshot = RuntimeMemberSnapshot(
        _runtime_member_identity(runtime), previous.items if previous else {},
        previous.manager_names if previous else {}, previous.complete_labels if previous else frozenset(),
        frozenset(labels) | (previous.invalidated_labels if previous else frozenset()),
        getattr(previous, 'models', {}) if previous else {})


def install_runtime_members(static_index, runtime, model_graph, snapshot,
        *, previous_runtime=None, previous_model_graph=None):
    """Retire in-flight/cache entries atomically with installing this owner's records."""
    with _surface_cache._lock:
        static_index._runtime_member_snapshot = snapshot
        if (_surface_cache._matches_owner(static_index, runtime, model_graph)
                or (previous_runtime is not None and _surface_cache._matches_owner(
                    static_index, previous_runtime, previous_model_graph))):
            _surface_cache._set_owner(static_index, runtime, model_graph, clear=True)


def rebase_runtime_member_source_paths(previous_index, static_index, runtime):
    """Keep verified same-source records while moving their canonical locations."""
    snapshot = _owned_runtime_members(previous_index, runtime)
    if snapshot is None:
        return None
    current = static_index._workspace_source_paths
    current_by_module = static_index._workspace_source_paths_by_module
    targets = {}
    for name, old_path in (previous_index._workspace_source_paths_by_module or {}).items():
        new_path = current_by_module.get(name)
        if new_path is not None:
            targets.setdefault(old_path, set()).add(new_path)
    items, changed = {}, False
    for key, records in snapshot.items.items():
        rebased = []
        for item in records:
            if item.file_path is not None and item.file_path not in current:
                choices = targets.get(item.file_path)
                if not choices:
                    raise RuntimeError('Owned runtime member source no longer has a workspace location.')
                candidate = static_index._model_candidates_by_label.get(item.model_label)
                preferred = current_by_module.get(candidate.module) if candidate is not None else None
                # Multiple aliases of the same verified source can remain.
                # Prefer the model's module, otherwise a stable owned alias.
                target = preferred if preferred in choices else min(choices)
                item = dataclasses.replace(item, file_path=target)
                changed = True
            rebased.append(item)
        items[key] = tuple(rebased)
    return dataclasses.replace(snapshot, items=items) if changed else snapshot


def _with_runtime_source_paths(function):
    """Share source paths, callable names and model/manager analysis for one build."""
    @wraps(function)
    def build(*args, **kwargs):
        static_index = kwargs.get('static_index', args[0] if args else None)
        model_graph = kwargs.get('model_graph', args[2] if len(args) > 2 else None)
        labels_token = _runtime_capture_labels.set(
            _build_static_to_graph_label_map(static_index, model_graph))
        try:
            if _runtime_source_paths.get() is not None:
                return function(*args, **kwargs)
            token = _runtime_source_paths.set({})
            try:
                bindings_token = _static_manager_bindings.set({})
                try:
                    candidates_token = _runtime_callable_candidates.set({})
                    try:
                        catalogs_token = _runtime_model_catalogs.set({})
                        try:
                            return function(*args, **kwargs)
                        finally:
                            _runtime_model_catalogs.reset(catalogs_token)
                    finally:
                        _runtime_callable_candidates.reset(candidates_token)
                finally:
                    _static_manager_bindings.reset(bindings_token)
            finally:
                _runtime_source_paths.reset(token)
        finally:
            _runtime_capture_labels.reset(labels_token)
    return build

def _build_builtin_dict(
    source: dict[str, object],
) -> dict[str, tuple[str, str]]:
    """Convert BuiltinMethodInfo dict to legacy (detail, return_kind) format."""
    return {
        name: (info.description, info.return_kind)
        for name, info in source.items()
    }


BUILTIN_QUERYSET_METHODS: dict[str, tuple[str, str]] = _build_builtin_dict(
    _QUERYSET_BUILTINS,
)

BUILTIN_MANAGER_METHODS: dict[str, tuple[str, str]] = {
    **BUILTIN_QUERYSET_METHODS,
    **_build_builtin_dict(_MANAGER_BUILTINS),
}

BUILTIN_INSTANCE_METHODS: dict[str, tuple[str, str]] = _build_builtin_dict(
    _INSTANCE_BUILTINS,
)


@dataclass(frozen=True, slots=True)
class OrmMemberItem:
    name: str
    member_kind: str
    model_label: str
    receiver_kind: str
    detail: str
    source: str
    return_kind: str | None = None
    return_model_label: str | None = None
    manager_name: str | None = None
    file_path: str | None = None
    line: int | None = None
    column: int | None = None
    field_kind: str | None = None
    is_relation: bool = False
    signature: str | None = None

    def to_dict(self) -> dict[str, object]:
        d: dict[str, object] = {
            'name': self.name,
            'memberKind': self.member_kind,
            'modelLabel': self.model_label,
            'receiverKind': self.receiver_kind,
            'detail': self.detail,
            'source': self.source,
            'returnKind': self.return_kind,
            'returnModelLabel': self.return_model_label,
            'managerName': self.manager_name,
            'filePath': self.file_path,
            'line': self.line,
            'column': self.column,
            'fieldKind': self.field_kind,
            'isRelation': self.is_relation,
        }
        if self.signature is not None:
            d['signature'] = self.signature
        return d


@dataclass(frozen=True, slots=True)
class _BuiltinMemberTemplate:
    item: OrmMemberItem
    returns_model: bool
    has_manager: bool

    @property
    def name(self):
        return self.item.name


@lru_cache(maxsize=512)
def _builtin_member_template(name, member_kind, receiver_kind, detail, return_kind,
                             file_path, line, column, field_kind, is_relation,
                             signature, returns_model, has_manager):
    return _BuiltinMemberTemplate(OrmMemberItem(
        name=name, member_kind=member_kind, model_label='', receiver_kind=receiver_kind,
        detail=detail, source='builtin', return_kind=return_kind, file_path=file_path,
        line=line, column=column, field_kind=field_kind, is_relation=is_relation,
        signature=signature), returns_model, has_manager)


_compact_builtin_items = ContextVar('compact_builtin_items', default=False)


@_with_runtime_source_paths
def _compact_member_surface(**kwargs):
    # Only cache construction consumes unbound templates. Direct member
    # queries and another thread still receive complete bound records.
    token = _compact_builtin_items.set(True)
    try:
        return _member_surface(**kwargs)
    finally:
        _compact_builtin_items.reset(token)


class _CachedMemberSurface(Sequence[OrmMemberItem]):
    """Read-only members with shared builtin metadata and local bindings."""
    __slots__ = ('_members', 'model_label', 'manager_name')

    def __init__(self, items, model_label, manager_name):
        self.model_label = model_label
        self.manager_name = manager_name
        members = []
        for item in items:
            if (type(item) is OrmMemberItem and item.source == 'builtin'
                    and item.model_label == model_label
                    and item.return_model_label in (None, model_label)
                    and item.manager_name in (None, manager_name)):
                item = _builtin_member_template(
                    item.name, item.member_kind, item.receiver_kind, item.detail,
                    item.return_kind, item.file_path, item.line, item.column,
                    item.field_kind, item.is_relation, item.signature,
                    item.return_model_label is not None, item.manager_name is not None)
            members.append(item)
        self._members = tuple(members)

    def __len__(self):
        return len(self._members)

    def __getitem__(self, position):
        if isinstance(position, slice):
            return [self[index] for index in range(*position.indices(len(self)))]
        item = self._members[position]
        if isinstance(item, _BuiltinMemberTemplate):
            return dataclasses.replace(item.item, model_label=self.model_label,
                return_model_label=self.model_label if item.returns_model else None,
                manager_name=self.manager_name if item.has_manager else None)
        return item

    def __eq__(self, other):
        if not isinstance(other, Sequence):
            return NotImplemented
        return len(self) == len(other) and all(left == right for left, right in zip(self, other))

    def names(self):
        for item in self._members:
            yield item.item.name if isinstance(item, _BuiltinMemberTemplate) else item.name

    def find(self, name):
        for position in range(len(self._members) - 1, -1, -1):
            member = self._members[position]
            item = member.item if isinstance(member, _BuiltinMemberTemplate) else member
            if item.name == name:
                return self[position]
        return None

    def metadata(self):
        # Full surface export needs five scalar values, not a bound record for
        # every method. Custom/runtime records retain their complete metadata.
        for member in self._members:
            if isinstance(member, _BuiltinMemberTemplate):
                item = member.item
                model_label = self.model_label
                return_model_label = model_label if member.returns_model else None
            else:
                item = member
                model_label = item.model_label
                return_model_label = item.return_model_label
            yield (item.name, item.return_kind, return_model_label or model_label,
                   item.member_kind, item.field_kind)

    def storage_roots(self):
        return self._members, self.model_label, self.manager_name


def _surface_metadata(surface):
    if isinstance(surface, _CachedMemberSurface):
        yield from surface.metadata()
    else:
        for item in surface:
            yield (item.name, item.return_kind, item.return_model_label or item.model_label,
                   item.member_kind, item.field_kind)


def log_surface_index_gap(
    static_index: StaticIndex,
    model_graph: ModelGraph | None,
    surface_index: dict[str, object],
) -> None:
    """Captain regression: `db.Company` (and similar workspace models) are
    present in the runtime ModelGraph but missing from the surfaceIndex sent
    to TS — diagnostics and completion lose the model entirely. The gap can
    come from:
      - abstract:    intentionally excluded by build_surface_index
      - unparseable: source file failed AST parse (StaticIndex tracks these)
      - shadowed:    file's module slot was taken by a sibling __init__.py
      - graph-only:  in ModelGraph (e.g. via inheritance/runtime) but no
                     matching static ModelCandidate at all
    Without this log the gap is invisible — users see "no completion items"
    with no path to debugging which model or file is at fault.
    Emits one summary line plus per-category file lists when non-empty.
    """
    import sys
    if model_graph is None:
        return
    surface_labels = set(surface_index.keys())
    graph_labels = set(model_graph.nodes_by_label.keys())
    missing = graph_labels - surface_labels
    if not missing:
        print(
            f'[surface:gap] none — surfaceIndex covers all {len(graph_labels)} graph models',
            file=sys.stderr,
        )
        return

    # Index candidates for lookup.
    candidates_by_label: dict[str, ModelCandidate] = {
        candidate.label: candidate for candidate in static_index.model_candidates
    }
    # Captain regression follow-up: surface a `(module, object_name)` index so
    # we can detect "the AST found a candidate, but stored it under a
    # different `app_label.Class` key than ModelGraph used". This happens
    # when Django's AppConfig sets a custom `app_label` that the indexer's
    # `module_name.split('.', 1)[0]` heuristic does NOT recover. captain
    # registers `zuzu.db` with `app_label='db'`, but the indexer derives
    # `app_label='zuzu'` and stores the candidate as `zuzu.Company` while
    # ModelGraph stores it as `db.Company` — the labels never match and
    # every workspace model permanently appears in surface:gap.
    candidates_by_module_and_name: dict[tuple[str, str], ModelCandidate] = {
        (candidate.module, candidate.object_name): candidate
        for candidate in static_index.model_candidates
    }
    # Reverse-lookup: file → set of missing labels in that file.
    abstract_labels: list[str] = []
    unparseable_labels: list[tuple[str, str, str]] = []  # (label, file, reason)
    shadowed_labels: list[tuple[str, str, str]] = []
    graph_only_labels: list[tuple[str, str | None]] = []  # (label, file_path_or_None)

    unparseable_files: dict[str, str] = getattr(static_index, 'unparseable_files', {}) or {}
    shadowed_files: dict[str, str] = getattr(static_index, 'shadowed_files', {}) or {}

    def _normalize_path(path: str | None) -> str | None:
        if not path:
            return None
        return path

    for label in sorted(missing):
        candidate = candidates_by_label.get(label)
        graph_node = model_graph.nodes_by_label.get(label)
        if candidate is None:
            file_path = _normalize_path(graph_node.file_path if graph_node else None)
            graph_only_labels.append((label, file_path))
            continue
        if candidate.is_abstract:
            abstract_labels.append(label)
            continue
        # Concrete candidate that should have surfaced — check why not.
        file_path = candidate.file_path
        if file_path in unparseable_files:
            reason = unparseable_files[file_path]
            unparseable_labels.append((label, file_path, reason))
            continue
        if file_path in shadowed_files:
            reason = shadowed_files[file_path]
            shadowed_labels.append((label, file_path, reason))
            continue
        # Concrete + parseable + non-shadowed yet still missing. This is the
        # genuinely surprising bucket — surface enumeration produced an empty
        # entry that got dropped, OR the candidate slipped past index. Treat
        # as graph-only so it shows up explicitly.
        graph_only_labels.append((label, file_path))

    total_missing = len(missing)
    print(
        f'[surface:gap] total={total_missing} '
        f'abstract={len(abstract_labels)} '
        f'unparseable={len(unparseable_labels)} '
        f'shadowed={len(shadowed_labels)} '
        f'graph-only={len(graph_only_labels)} '
        f'graph={len(graph_labels)} surface={len(surface_labels)}',
        file=sys.stderr,
    )
    SAMPLE = 8
    if unparseable_labels:
        # Each entry shows the captain-relevant info: which label, which file,
        # and what parse error blocked it. This is the highest-priority
        # bucket because every label here is a real model the user wrote
        # that we silently dropped due to a syntax/AST error.
        sample = unparseable_labels[:SAMPLE]
        formatted = ', '.join(
            f'{label}@{file_path}:{reason}'
            for label, file_path, reason in sample
        )
        more = '' if len(unparseable_labels) <= SAMPLE else f' (+{len(unparseable_labels) - SAMPLE} more)'
        print(f'[surface:gap:unparseable] {formatted}{more}', file=sys.stderr)
    if shadowed_labels:
        sample = shadowed_labels[:SAMPLE]
        formatted = ', '.join(
            f'{label}@{file_path}:{reason}'
            for label, file_path, reason in sample
        )
        more = '' if len(shadowed_labels) <= SAMPLE else f' (+{len(shadowed_labels) - SAMPLE} more)'
        print(f'[surface:gap:shadowed] {formatted}{more}', file=sys.stderr)
    if graph_only_labels:
        # Captain regression: 109 of 109 missing models landed here with
        # file_path=None — they were discovered via Django runtime introspection
        # but the AST indexer never produced a ModelCandidate. Split into
        # workspace vs external so the user can immediately see which models
        # they're responsible for fixing vs which are just packaged Django/
        # site-packages models (where missing surface is acceptable).
        EXTERNAL_MODULE_PREFIXES = (
            'django.',
            'django_',
            'rest_framework.',
            'axes.',
            'corsheaders.',
            'allauth.',
            'debug_toolbar.',
            'graphene.',
            'channels.',
            'storages.',
            'silk.',
            'oauth2_provider.',
            'guardian.',
            'taggit.',
        )

        def _is_external(node) -> bool:
            module = (node.module or '').strip()
            import_path = (node.import_path or '').strip()
            for prefix in EXTERNAL_MODULE_PREFIXES:
                if module.startswith(prefix) or import_path.startswith(prefix):
                    return True
            # site-packages anywhere in import path → external
            if 'site-packages' in import_path:
                return True
            return False

        workspace_entries: list[tuple[str, object]] = []
        external_entries: list[tuple[str, object]] = []
        for label, _file_path in graph_only_labels:
            node = model_graph.nodes_by_label.get(label)
            if node is None:
                external_entries.append((label, None))
                continue
            if _is_external(node):
                external_entries.append((label, node))
            else:
                workspace_entries.append((label, node))

        # Workspace entries: dump ALL of them with module + runtime info so
        # the user can locate every missing workspace model. captain's
        # `db.Company` will be here.
        if workspace_entries:
            WORKSPACE_DUMP = 64
            details = []
            for label, node in workspace_entries[:WORKSPACE_DUMP]:
                if node is None:
                    details.append(f'{label}@? module=? runtime=?')
                    continue
                runtime = 'yes' if node.runtime_model is not None else 'no'
                candidate = 'yes' if node.model_candidate is not None else 'no'
                module = node.module or '?'
                # Look up an AST candidate keyed by (module, object_name) —
                # captures the case where the indexer stored a candidate
                # under a different app_label-based label than ModelGraph
                # used. If found, surface its label so the mismatch is
                # visible. Otherwise mark `candidate_alt=none` so the
                # user can tell "really no AST candidate" vs "candidate
                # exists but under a different label".
                sibling = candidates_by_module_and_name.get(
                    (node.module, node.object_name)
                )
                if sibling is not None and sibling.label != label:
                    alt_label = sibling.label
                else:
                    alt_label = 'none'
                details.append(
                    f'{label} module={module} runtime={runtime} '
                    f'candidate={candidate} candidate_alt={alt_label}'
                )
            more = (
                ''
                if len(workspace_entries) <= WORKSPACE_DUMP
                else f' (+{len(workspace_entries) - WORKSPACE_DUMP} more)'
            )
            print(
                f'[surface:gap:graph-only:workspace] count={len(workspace_entries)} {", ".join(details)}{more}',
                file=sys.stderr,
            )

        # External entries: just count + small sample, since these are
        # site-packages models we don't expect to surface anyway.
        if external_entries:
            EXTERNAL_DUMP = 6
            sample = external_entries[:EXTERNAL_DUMP]
            details = []
            for label, node in sample:
                if node is None:
                    details.append(label)
                else:
                    top_module = (node.module or '').split('.')[0]
                    details.append(f'{label}({top_module})')
            more = (
                ''
                if len(external_entries) <= EXTERNAL_DUMP
                else f' (+{len(external_entries) - EXTERNAL_DUMP} more)'
            )
            print(
                f'[surface:gap:graph-only:external] count={len(external_entries)} {", ".join(details)}{more}',
                file=sys.stderr,
            )
    if abstract_labels:
        # Abstract is intentional; just emit count so the breakdown adds up.
        sample = abstract_labels[:SAMPLE]
        more = '' if len(abstract_labels) <= SAMPLE else f' (+{len(abstract_labels) - SAMPLE} more)'
        print(
            f'[surface:gap:abstract] {", ".join(sample)}{more}',
            file=sys.stderr,
        )


def _build_static_to_graph_label_map(
    static_index: StaticIndex,
    model_graph: ModelGraph | None,
) -> dict[str, str]:
    """Map ``ModelCandidate.label`` → graph (runtime) label via (module, object_name).

    Captain's `zuzu/db/models/company/company.py` reproduces the canonical
    split: the AST candidate is stored as ``zuzu.Company`` (module-segment
    heuristic) while Django's runtime model is ``db.Company`` (AppConfig
    label='db'). The ModelGraph linker already joins these via
    ``(candidate.module, candidate.object_name)`` and exposes the node under
    the runtime label. This helper hoists that join so callers — most
    importantly ``build_surface_index`` — can present a single canonical
    label to TS (the runtime label, matching what Pylance hands back).
    """
    if model_graph is None:
        return {}
    return model_graph.static_to_graph_labels(static_index)


def _remap_label(label: str | None, label_map: dict[str, str]) -> str | None:
    if label is None:
        return None
    return label_map.get(label, label)


def _resolve_graph_label_for_static_label(
    static_index: StaticIndex,
    model_graph: ModelGraph | None,
    model_label: str,
) -> str | None:
    """Given a candidate.label, return the graph (runtime) label for the same
    ``(module, object_name)`` pair when they diverge — captain pattern.

    Returns ``None`` when the candidate is unknown to the static index, or
    when no graph node matches its module/object_name. Returns the same
    ``model_label`` when graph and static agree (the common case).
    """
    if model_graph is None:
        return None
    candidate = static_index.find_model_candidate(model_label)
    if candidate is None:
        return None
    for node in model_graph.nodes_by_object_name.get(candidate.object_name, ()):
        if node.module == candidate.module:
            return node.label
    return None


def _normalize_to_static_label(
    static_index: StaticIndex,
    model_graph: ModelGraph | None,
    model_label: str,
) -> str:
    """Translate a TS-facing graph label back to the static candidate label.

    After option C, TS receives surface entries keyed by the runtime/graph
    label (e.g. ``db.Company``). When TS calls back into the daemon with
    that label, downstream resolvers that key off
    ``static_index.find_model_candidate(label)`` would miss — the static
    index is keyed by ``candidate.label`` (e.g. ``zuzu.Company``). This
    helper performs the inverse of the Step-3 label map so the internal
    resolution chain keeps working regardless of which label the caller
    holds; only public return values need to be re-flipped to the graph
    label on the way out.
    """
    if static_index.find_model_candidate(model_label) is not None:
        return model_label
    if model_graph is None:
        return model_label
    node = model_graph.node_for_model(model_label)
    if node is not None and node.model_candidate is not None:
        return node.model_candidate.label
    return model_label


def _remap_member_item_for_output(
    item: OrmMemberItem,
    label_map: dict[str, str],
) -> OrmMemberItem:
    """Flip ``model_label`` and ``return_model_label`` from static → graph label.

    Used when an OrmMemberItem is about to leave the daemon (resolve_orm_member
    return path, chain resolution). Ensures the labels TS sees are consistent
    with the surface index keys so receiver-chain lookups don't dead-end on the
    extension host.
    """
    if not label_map:
        return item
    new_model_label = label_map.get(item.model_label, item.model_label)
    new_return_label = _remap_label(item.return_model_label, label_map)
    if (
        new_model_label == item.model_label
        and new_return_label == item.return_model_label
    ):
        return item
    return dataclasses.replace(
        item,
        model_label=new_model_label,
        return_model_label=new_return_label,
    )


@_with_runtime_source_paths
def build_surface_index(
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    model_graph: ModelGraph | None = None,
    *,
    _cache: _MemberSurfaceCache | None = None,
    labels: set[str] | frozenset[str] | None = None,
) -> dict[str, object]:
    """전체 model surface를 경량 dict로 빌드. TS에 전송하여 로컬 O(1) 해석.

    Surface entries are keyed by the **graph (runtime) label** when the
    ModelGraph exposes one for ``(candidate.module, candidate.object_name)``;
    otherwise we fall back to ``candidate.label``. This bridges the captain
    pattern where `AppConfig.label` diverges from the module's first segment
    (`zuzu.Company` candidate ↔ `db.Company` runtime label) — TS now finds
    the surface entry under the same label Pylance hands back.
    """
    label_map = _build_static_to_graph_label_map(static_index, model_graph)
    cache = _surface_cache if _cache is None else _cache

    index: dict[str, dict[str, dict[str, tuple[str | None, ...]]]] = {}
    receiver_kinds = ['instance', 'model_class', 'manager', 'queryset', 'related_manager']
    for candidate in static_index.model_candidates:
        if candidate.is_abstract or (labels is not None and candidate.label not in labels):
            continue
        # Internal lookups (StaticIndex.find_model_candidate, field tables)
        # are keyed by candidate.label; only the OUTER dict key flips to the
        # graph label. This is the smallest change that fixes the captain
        # pattern without rippling label semantics into every downstream
        # resolver — those migrations belong in the audit step.
        surface_key = label_map.get(candidate.label, candidate.label)
        model_entry: dict[str, dict[str, tuple[str | None, ...]]] = {}
        # Receiver return metadata contains only immutable scalars. Many
        # methods share it; keep one tuple per value within this model.
        values: dict[tuple[str | None, ...], tuple[str | None, ...]] = {}
        for kind in receiver_kinds:
            surface = cache.get_list(
                static_index, runtime, model_graph,
                candidate.label, kind, None,
            )
            kind_entry: dict[str, tuple[str | None, ...]] = {}
            for name, return_kind, return_label, member_kind, field_kind in _surface_metadata(surface):
                if return_kind:
                    value = (
                        return_kind, _remap_label(return_label, label_map), member_kind, field_kind,
                    )
                    kind_entry[name] = values.setdefault(value, value)
            if kind_entry:
                model_entry[kind] = kind_entry

        # Django attaches `objects = Manager()` to every concrete Model via
        # its metaclass. The static enumeration above can miss it when the
        # source declaration uses an unusual pattern (custom base class,
        # late binding, etc.), and the captain workspace trace showed
        # `<model>.objects.filter(...)` landing in noRecv as a result.
        # Guarantee the entry exists; if surface enumeration produced a
        # richer record for `objects` it wins via dict insertion order.
        model_class_entry = model_entry.setdefault('model_class', {})
        if 'objects' not in model_class_entry:
            value = ('manager', surface_key, 'manager', None)
            model_class_entry['objects'] = values.setdefault(value, value)
        # Always register concrete candidates — even ones whose receivers came
        # back empty (e.g. inheritance-only models where every field lives on
        # an abstract base). Dropping them silently hides the model from the
        # TS-side surfaceIndex, which breaks receiver-aware completion on the
        # extension host because our lookup path keys off the candidate label.
        index[surface_key] = model_entry
    return index


def fingerprint_surface_index(
    surface_index: dict[str, object],
    *,
    labels: set[str] | list[str] | tuple[str, ...] | None = None,
) -> dict[str, str]:
    if labels is None:
        selected_labels = surface_index.keys()
    else:
        selected_labels = labels

    fingerprints: dict[str, str] = {}
    for label in selected_labels:
        entry = surface_index.get(label)
        if entry is None:
            continue
        payload = json.dumps(
            entry,
            ensure_ascii=True,
            separators=(',', ':'),
            sort_keys=True,
        )
        fingerprints[label] = hashlib.blake2b(
            payload.encode('utf-8'),
            digest_size=16,
        ).hexdigest()
    return fingerprints


def fingerprint_json_payload(payload: object) -> str:
    serialized = json.dumps(
        payload,
        ensure_ascii=True,
        separators=(',', ':'),
        sort_keys=True,
        default=lookup_catalog_json_default,
    )
    return hashlib.blake2b(
        serialized.encode('utf-8'),
        digest_size=16,
    ).hexdigest()


@_with_runtime_source_paths
def rebuild_surface_for_models(
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    model_graph: ModelGraph | None,
    affected_labels: set[str],
    existing_surface_index: dict[str, object],
    *,
    previous_static_index: StaticIndex | None = None,
    previous_model_graph: ModelGraph | None = None,
) -> dict[str, object]:
    """Rebuild surface entries for affected models and merge into existing index.

    - Invalidates only the affected model cache entries.
    - Updates force_owner so _check_owner doesn't clear the entire cache.
    - Returns the full updated surface_index.
    """
    import time
    started = time.perf_counter()

    _surface_cache.force_owner(static_index, runtime, model_graph,
        previous_static_index=previous_static_index, previous_model_graph=previous_model_graph,
        invalidated_labels=affected_labels)

    label_map = _build_static_to_graph_label_map(static_index, model_graph)

    # Build a shallow copy of the existing surface index
    index: dict[str, dict[str, dict[str, tuple[str | None, ...]]]] = dict(existing_surface_index)  # type: ignore[arg-type]

    # Remove labels that no longer exist. Match against both candidate labels
    # and their graph-remapped keys so the captain split (candidate=zuzu.X,
    # surface=db.X) doesn't leave dead `db.X` entries behind on deletion.
    current_surface_keys = {
        label_map.get(c.label, c.label)
        for c in static_index.model_candidates
        if not c.is_abstract
    }
    for label in affected_labels:
        surface_key = label_map.get(label, label)
        if surface_key not in current_surface_keys:
            index.pop(surface_key, None)

    # Rebuild affected labels
    receiver_kinds = ['instance', 'model_class', 'manager', 'queryset', 'related_manager']
    for candidate in static_index.model_candidates:
        if candidate.is_abstract or candidate.label not in affected_labels:
            continue
        surface_key = label_map.get(candidate.label, candidate.label)
        model_entry: dict[str, dict[str, tuple[str | None, ...]]] = {}
        values: dict[tuple[str | None, ...], tuple[str | None, ...]] = {}
        for kind in receiver_kinds:
            surface = _surface_cache.get_list(
                static_index, runtime, model_graph,
                candidate.label, kind, None,
            )
            kind_entry: dict[str, tuple[str | None, ...]] = {}
            for name, return_kind, return_label, member_kind, field_kind in _surface_metadata(surface):
                if return_kind:
                    value = (
                        return_kind, _remap_label(return_label, label_map), member_kind, field_kind,
                    )
                    kind_entry[name] = values.setdefault(value, value)
            if kind_entry:
                model_entry[kind] = kind_entry
        # Keep concrete models registered even when every receiver surface is
        # temporarily empty. Dropping the label here makes incremental rebuilds
        # diverge from full initialization and can hide inheritance-only
        # concrete models from TS lookup completion until the next full restart.
        index[surface_key] = model_entry

    elapsed = time.perf_counter() - started
    print(
        f'[PERF] rebuild_surface_for_models: {len(affected_labels)} affected '
        f'{elapsed:.3f}s',
        file=__import__("sys").stderr,
    )
    return index


@_with_runtime_source_paths
def prebuild_member_surface_cache(
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    model_graph: ModelGraph | None = None,
    *,
    runtime_members: dict | None = None,
) -> dict[str, object]:
    """초기화 시 모든 모델의 member surface를 프리빌드하고 surface index를 반환."""
    if runtime_members is None:
        return _prebuild_member_surface_cache(static_index, runtime, model_graph, _surface_cache)
    # A snapshot belongs to this build only. A reused worker must not return
    # member-cache entries created with an earlier runtime capture.
    token = _runtime_member_snapshot.set((static_index, runtime, runtime_members))
    try:
        return _prebuild_member_surface_cache(static_index, runtime, model_graph, _MemberSurfaceCache())
    finally:
        _runtime_member_snapshot.reset(token)


def _prebuild_member_surface_cache(static_index, runtime, model_graph, cache):
    import time
    started = time.perf_counter()
    receiver_kinds = ['instance', 'model_class', 'manager', 'queryset', 'related_manager']
    surface_index = build_surface_index(static_index, runtime, model_graph, _cache=cache)
    count = sum(not candidate.is_abstract for candidate in static_index.model_candidates) * len(receiver_kinds)
    elapsed = time.perf_counter() - started
    print(
        f'[PERF] prebuild_member_surface_cache: {count} surfaces '
        f'{elapsed:.2f}s '
        f'cache={cache._hits}hit/{cache._misses}miss '
        f'surfaceIndex={len(surface_index)} models',
        file=__import__("sys").stderr,
    )
    log_surface_index_gap(static_index, model_graph, surface_index)
    return surface_index


@_with_runtime_source_paths
def capture_runtime_member_surface(static_index: StaticIndex, runtime: RuntimeInspection,
        model_graph: ModelGraph | None = None) -> dict | None:
    """Capture only transferable runtime members from the initialized parent."""
    if runtime.bootstrap_status != 'ready':
        return None
    if runtime.detached:
        owned = _owned_runtime_members(static_index, runtime)
        return dict(owned.items) if owned is not None and not owned.invalidated_labels else None
    # A restored ready catalogue can precede the parent's asynchronous Django
    # setup. Serialize app population with Django's own lock before capturing;
    # an empty capture in that window must not become a complete disk cache.
    if runtime.settings_module:
        import django
        from django.apps import apps
        if not apps.ready:
            os.environ['DJANGO_SETTINGS_MODULE'] = runtime.settings_module
            django.setup()
    captured = {}
    for candidate in static_index.model_candidates:
        if candidate.is_abstract:
            continue
        for kind in ('instance', 'model_class', 'manager', 'queryset', 'related_manager'):
            if kind in ('instance', 'model_class'):
                items = _project_model_method_items(static_index=static_index, runtime=runtime,
                    model_label=candidate.label, receiver_kind=kind)
            elif kind == 'queryset':
                items = _project_queryset_method_items(static_index=static_index, runtime=runtime,
                    model_label=candidate.label, manager_name=None)
            else:
                items = _project_manager_method_items(static_index=static_index, runtime=runtime,
                    model_label=candidate.label, manager_name=None, runtime_receiver_kind=kind)
            if items:
                captured[(candidate.label, kind, None)] = tuple(items)
    return captured


def _captured_runtime_items(static_index, runtime, model_label, receiver_kind, manager_name):
    snapshot = _runtime_member_snapshot.get()
    if snapshot is not None and snapshot[0] is static_index and snapshot[1] is runtime:
        return snapshot[2].get((model_label, receiver_kind, manager_name), ())
    owned = _owned_runtime_members(static_index, runtime)
    if owned is not None:
        if model_label in owned.invalidated_labels:
            return ()
        if model_label in owned.complete_labels:
            return owned.items.get((model_label, receiver_kind, manager_name), ())
    return None


@_with_runtime_source_paths
def capture_current_runtime_members(static_index, runtime, model_graph, *, cancelled=None):
    """Capture a matching registry, including named managers and runtime app labels."""
    if cancelled is not None and cancelled():
        return None
    import django
    from django.apps import apps
    from django.conf import settings
    if not apps.ready:
        os.environ['DJANGO_SETTINGS_MODULE'] = runtime.settings_module
        django.setup()
    elif getattr(settings, 'SETTINGS_MODULE', None) != runtime.settings_module:
        raise RuntimeError('Runtime member registry belongs to another settings module.')
    if cancelled is not None and cancelled():
        return None
    models = {(model.__module__, model.__name__): model for model in apps.get_models()}
    labels = _build_static_to_graph_label_map(static_index, model_graph)
    candidates = {candidate.label: candidate for candidate in static_index.model_candidates
        if not candidate.is_abstract}
    resolved = {}
    for label, candidate in candidates.items():
        model = models.get((candidate.module, candidate.object_name))
        if model is not None:
            resolved[label] = _model_label_for_runtime_model(model)
        elif label in labels:
            resolved[label] = labels[label]
    # Runtime-only graph nodes may also have project-defined methods.
    for node in model_graph.nodes_by_label.values():
        if node.runtime_model is not None and node.model_candidate is None:
            candidates.setdefault(node.label, node)
            resolved[node.label] = node.label
    items, manager_names = {}, {}
    token = _runtime_capture_labels.set(resolved)
    try:
        for label in candidates:
            if cancelled is not None and cancelled():
                return None
            model = _runtime_model_class(label)
            names = tuple(sorted({manager.name for manager in model._meta.managers})) if model is not None else ()
            if model is not None:
                manager_names[label] = names
            for kind in ('instance', 'model_class'):
                values = _project_model_method_items(static_index=static_index, runtime=runtime,
                    model_label=label, receiver_kind=kind)
                if values:
                    items[(label, kind, None)] = tuple(values)
            for name in (None, *names):
                for kind in ('manager', 'queryset', 'related_manager'):
                    values = (_project_queryset_method_items(static_index=static_index, runtime=runtime,
                        model_label=label, manager_name=name) if kind == 'queryset'
                        else _project_manager_method_items(static_index=static_index, runtime=runtime,
                            model_label=label, manager_name=name, runtime_receiver_kind=kind))
                    if values:
                        items[(label, kind, name)] = tuple(values)
    finally:
        _runtime_capture_labels.reset(token)
    if cancelled is not None and cancelled():
        return None
    return RuntimeMemberSnapshot(_runtime_member_identity(runtime), items, manager_names,
        frozenset(candidates))


@_with_runtime_source_paths
def resolve_orm_member_chain(
    *,
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    model_graph: ModelGraph | None = None,
    model_label: str,
    receiver_kind: str,
    chain: list[str],
    manager_name: str | None = None,
) -> dict[str, object]:
    """멤버 체인을 한 번에 해석. IPC 1회로 여러 단계 해석."""
    # Captain-pattern bridge: keep all cache lookups in the static-label
    # space (cache key matches surface build), then remap return labels back
    # to the graph label before responding to TS.
    label_map = _build_static_to_graph_label_map(static_index, model_graph)
    current_label = _normalize_to_static_label(static_index, model_graph, model_label)
    current_kind = receiver_kind
    current_manager = manager_name
    visited: set[tuple[str, str, str]] = set()

    for name in chain:
        visit_key = (current_label, current_kind, name)
        if visit_key in visited:
            return {
                'resolved': False,
                'reason': 'cycle_detected',
                'failedAt': name,
                'modelLabel': label_map.get(current_label, current_label),
                'receiverKind': current_kind,
            }
        visited.add(visit_key)
        item = _surface_cache.find(
            static_index, runtime, model_graph,
            current_label, current_kind, name, current_manager,
        )
        if item is None:
            return {
                'resolved': False,
                'reason': 'not_found',
                'failedAt': name,
                'modelLabel': label_map.get(current_label, current_label),
                'receiverKind': current_kind,
            }

        return_kind = item.return_kind
        if not return_kind:
            return {
                'resolved': False,
                'reason': 'no_return_kind',
                'failedAt': name,
            }

        return_label = item.return_model_label or item.model_label
        # The cache stores the static label internally; the next iteration
        # also looks up by static label, so we don't remap mid-chain — only
        # the final modelLabel returned to TS gets flipped to the graph label.
        current_label = _normalize_to_static_label(
            static_index, model_graph, return_label,
        )
        current_kind = return_kind
        current_manager = (
            item.manager_name or item.name
            if return_kind == 'manager'
            else item.manager_name
        )

    return {
        'resolved': True,
        'modelLabel': label_map.get(current_label, current_label),
        'receiverKind': current_kind,
        'managerName': current_manager,
    }


@_with_runtime_source_paths
def resolve_orm_member(
    *,
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    model_graph: ModelGraph | None = None,
    model_label: str,
    receiver_kind: str,
    name: str,
    manager_name: str | None = None,
) -> dict[str, object]:
    normalized_name = name.strip()
    if not normalized_name:
        return {'resolved': False, 'reason': 'empty'}

    # Captain-pattern bridge: TS calls back with the graph (runtime) label, but
    # all the resolvers below key off candidate.label. Translate once at the
    # boundary, then remap return labels back to the graph label.
    internal_label = _normalize_to_static_label(static_index, model_graph, model_label)
    label_map = _build_static_to_graph_label_map(static_index, model_graph)

    direct_item = _direct_resolve_member_item(
        static_index=static_index,
        runtime=runtime,
        model_label=internal_label,
        receiver_kind=receiver_kind,
        name=normalized_name,
        manager_name=manager_name,
    )
    if direct_item is not None:
        return {
            'resolved': True,
            'item': _remap_member_item_for_output(direct_item, label_map).to_dict(),
        }

    item = _surface_cache.find(
        static_index, runtime, model_graph, internal_label, receiver_kind,
        normalized_name, manager_name,
    )
    if item is None:
        return {
            'resolved': False,
            'reason': 'not_found',
        }

    return {
        'resolved': True,
        'item': _remap_member_item_for_output(item, label_map).to_dict(),
    }


def _direct_resolve_member_item(
    *,
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    model_label: str,
    receiver_kind: str,
    name: str,
    manager_name: str | None,
) -> OrmMemberItem | None:
    if receiver_kind == 'instance':
        field = static_index.find_field(model_label, name)
        if field is not None:
            return _field_member_item(field)

        for item in _static_model_method_items(
            static_index=static_index,
            model_label=model_label,
            receiver_kind='instance',
        ):
            if item.name == name:
                return item

        builtin = BUILTIN_INSTANCE_METHODS.get(name)
        if builtin is not None:
            detail, return_kind = builtin
            info = _INSTANCE_BUILTINS.get(name)
            return OrmMemberItem(
                name=name,
                member_kind='method',
                model_label=model_label,
                receiver_kind='instance',
                detail=detail,
                source='builtin',
                return_kind=return_kind,
                return_model_label=(
                    model_label if return_kind == 'instance' else None
                ),
                signature=info.signature if info else None,
            )
        return None

    if receiver_kind == 'model_class':
        for item in _manager_name_items(static_index, runtime, model_label):
            if item.name == name:
                return item
        for item in _static_model_method_items(
            static_index=static_index,
            model_label=model_label,
            receiver_kind='model_class',
        ):
            if item.name == name:
                return item
        return None

    if receiver_kind in {'manager', 'related_manager'}:
        builtin = BUILTIN_MANAGER_METHODS.get(name)
        if builtin is not None and django_builtin_available(name, runtime.django_version):
            detail, return_kind = builtin
            _all_builtins = {**_QUERYSET_BUILTINS, **_MANAGER_BUILTINS}
            info = _all_builtins.get(name)
            return OrmMemberItem(
                name=name,
                member_kind='method',
                model_label=model_label,
                receiver_kind=receiver_kind,
                detail=detail,
                source='builtin',
                return_kind=return_kind,
                return_model_label=(
                    model_label if return_kind in {'instance', 'manager', 'queryset'} else None
                ),
                manager_name=manager_name,
                signature=info.signature if info else None,
            )

        for item in _static_manager_method_items(
            static_index=static_index,
            model_label=model_label,
            manager_name=manager_name,
        ):
            if item.name == name:
                return item
        return None

    if receiver_kind == 'queryset':
        if name in QUERYSET_BUILTIN_PROPERTIES and django_builtin_available(name, runtime.django_version):
            info = QUERYSET_BUILTIN_PROPERTIES[name]
            return OrmMemberItem(name=name, member_kind='property', model_label=model_label,
                                 receiver_kind='queryset', detail=info.description, source='builtin',
                                 return_kind='scalar', field_kind='BooleanField', signature=info.signature)
        builtin = BUILTIN_QUERYSET_METHODS.get(name)
        if builtin is not None and django_builtin_available(name, runtime.django_version):
            detail, return_kind = builtin
            info = _QUERYSET_BUILTINS.get(name)
            return OrmMemberItem(
                name=name,
                member_kind='method',
                model_label=model_label,
                receiver_kind='queryset',
                detail=detail,
                source='builtin',
                return_kind=return_kind,
                return_model_label=(
                    model_label if return_kind in {'instance', 'manager', 'queryset'} else None
                ),
                manager_name=manager_name,
                signature=info.signature if info else None,
            )

        for item in _static_queryset_method_items(
            static_index=static_index,
            model_label=model_label,
            manager_name=manager_name,
        ):
            if item.name == name:
                return item
        return None

    return None


def _member_surface(
    *,
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    model_graph: ModelGraph | None,
    model_label: str,
    receiver_kind: str,
    manager_name: str | None,
) -> list[OrmMemberItem]:
    if receiver_kind == 'instance':
        return _instance_surface(static_index, runtime, model_graph, model_label)
    if receiver_kind == 'model_class':
        return _model_class_surface(static_index, runtime, model_label)
    if receiver_kind == 'manager':
        return _manager_surface(
            static_index=static_index,
            runtime=runtime,
            model_label=model_label,
            manager_name=manager_name,
        )
    if receiver_kind == 'queryset':
        return _queryset_surface(
            static_index=static_index,
            runtime=runtime,
            model_label=model_label,
            manager_name=manager_name,
        )
    if receiver_kind == 'related_manager':
        return _related_manager_surface(
            static_index=static_index,
            runtime=runtime,
            model_label=model_label,
            manager_name=manager_name,
        )
    return []


def _instance_surface(
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    model_graph: ModelGraph | None,
    model_label: str,
) -> list[OrmMemberItem]:
    items: list[OrmMemberItem] = []
    seen_names: set[str] = set()

    field_source: list = []
    if model_graph is not None:
        field_source = list(model_graph.fields_for_model(model_label))
        if not field_source:
            # Captain split-label bridge: the cache key uses candidate.label
            # (e.g. `zuzu.Company`) but model_graph indexes fields under the
            # runtime label (e.g. `db.Company`). Re-query via the graph node
            # for (candidate.module, candidate.object_name) so runtime-only
            # fields still surface for AppConfig-label-split models.
            graph_label = _resolve_graph_label_for_static_label(
                static_index, model_graph, model_label,
            )
            if graph_label is not None and graph_label != model_label:
                field_source = list(model_graph.fields_for_model(graph_label))
    if not field_source:
        field_source = list(static_index.fields_for_model(model_label))
    if not field_source:
        # Inheritance-only concrete models (fields all come from abstract base
        # classes) have no direct fields in the static index and, when runtime
        # introspection misses them, no entry in the model graph either. Walk
        # the recorded base_class_refs so we still surface inherited lookup
        # fields instead of reporting an empty completion list.
        field_source = _fields_from_base_classes(static_index, model_label, set())
    for field in field_source:
        item = _field_member_item(field)
        items.append(item)
        seen_names.add(item.name)

    for item in _static_model_method_items(
        static_index=static_index,
        model_label=model_label,
        receiver_kind='instance',
    ):
        if item.name in seen_names:
            continue
        items.append(item)
        seen_names.add(item.name)

    for item in _project_model_method_items(
        static_index=static_index,
        runtime=runtime,
        model_label=model_label,
        receiver_kind='instance',
    ):
        if item.name in seen_names:
            continue
        items.append(item)
        seen_names.add(item.name)

    for item in _builtin_instance_method_items(model_label):
        if item.name in seen_names:
            continue
        items.append(item)
        seen_names.add(item.name)

    return items


def _fields_from_base_classes(
    static_index: StaticIndex,
    model_label: str,
    visited: set[str],
) -> list[FieldCandidate]:
    """Collect fields from the static bases of ``model_label``.

    Walks ``ModelCandidate.base_class_refs`` recursively so concrete models
    that inherit every field from an abstract base class still surface
    lookup-friendly field candidates. Returning this list lets callers (e.g.
    ``_instance_surface``) back-fill when the primary sources produce an
    empty field set.
    """
    if model_label in visited:
        return []
    visited.add(model_label)

    candidate = static_index.find_model_candidate(model_label)
    if candidate is None:
        return []

    fields: list[FieldCandidate] = []
    seen_names: set[str] = set()
    for base_ref in candidate.base_class_refs:
        base_candidate = _resolve_base_candidate(
            static_index=static_index,
            module_name=candidate.module,
            base_ref=base_ref,
        )
        if base_candidate is None:
            continue
        for field in static_index.fields_for_model(base_candidate.label):
            if field.name in seen_names:
                continue
            seen_names.add(field.name)
            fields.append(field)
        # Recurse into the base's own bases so we capture fields from
        # deep inheritance chains (e.g. Company -> BaseCompany -> TimestampedModel).
        for inherited in _fields_from_base_classes(
            static_index=static_index,
            model_label=base_candidate.label,
            visited=visited,
        ):
            if inherited.name in seen_names:
                continue
            seen_names.add(inherited.name)
            fields.append(inherited)

    return fields


def _resolve_base_candidate(
    *,
    static_index: StaticIndex,
    module_name: str,
    base_ref: str,
) -> ModelCandidate | None:
    if not base_ref:
        return None
    local_candidate = static_index.find_model_candidate_by_module_and_name(
        module_name, base_ref
    )
    if local_candidate is not None:
        return local_candidate
    if '.' in base_ref:
        base_module, _, base_name = base_ref.rpartition('.')
        dotted_candidate = static_index.find_model_candidate_by_module_and_name(
            base_module, base_name
        )
        if dotted_candidate is not None:
            return dotted_candidate
    return None


def _model_class_surface(
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    model_label: str,
) -> list[OrmMemberItem]:
    items: list[OrmMemberItem] = []
    seen_names: set[str] = set()

    for item in _manager_name_items(static_index, runtime, model_label):
        items.append(item)
        seen_names.add(item.name)

    for item in _static_model_method_items(
        static_index=static_index,
        model_label=model_label,
        receiver_kind='model_class',
    ):
        if item.name in seen_names:
            continue
        items.append(item)
        seen_names.add(item.name)

    for item in _project_model_method_items(
        static_index=static_index,
        runtime=runtime,
        model_label=model_label,
        receiver_kind='model_class',
    ):
        if item.name in seen_names:
            continue
        items.append(item)
        seen_names.add(item.name)

    return items


def _manager_surface(
    *,
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    model_label: str,
    manager_name: str | None,
    _runtime_receiver_kind: str = 'manager',
) -> list[OrmMemberItem]:
    items: list[OrmMemberItem] = []
    seen_names: set[str] = set()

    for item in _builtin_method_items(
        BUILTIN_MANAGER_METHODS,
        runtime=runtime,
        receiver_kind='manager',
        model_label=model_label,
        manager_name=manager_name,
    ):
        items.append(item)
        seen_names.add(item.name)

    for item in _static_manager_method_items(
        static_index=static_index,
        model_label=model_label,
        manager_name=manager_name,
    ):
        if item.name in seen_names:
            continue
        items.append(item)
        seen_names.add(item.name)

    for item in _project_manager_method_items(static_index=static_index, runtime=runtime,
            model_label=model_label, manager_name=manager_name,
            runtime_receiver_kind=_runtime_receiver_kind):
        if item.name in seen_names:
            continue
        items.append(item)
        seen_names.add(item.name)

    return items


def _project_manager_method_items(*, static_index, runtime, model_label, manager_name,
                                  runtime_receiver_kind='manager'):
    captured = _captured_runtime_items(static_index, runtime, model_label, runtime_receiver_kind, manager_name)
    if captured is not None:
        return captured
    if runtime.detached:
        return []
    manager = _runtime_manager(model_label, manager_name) if runtime.bootstrap_status == 'ready' else None
    if manager is None:
        return []
    items = _runtime_callable_member_items(owner_classes=[manager.__class__],
        workspace_files=_workspace_files(static_index), receiver_kind='manager',
        model_label=model_label, manager_name=manager_name, default_return_kind='queryset')
    queryset_class = _runtime_queryset_class(manager)
    if queryset_class is not None:
        items.extend(_runtime_callable_member_items(owner_classes=[queryset_class],
            workspace_files=_workspace_files(static_index), receiver_kind='manager',
            model_label=model_label, manager_name=manager_name, default_return_kind='queryset'))
    return items


def _queryset_surface(
    *,
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    model_label: str,
    manager_name: str | None,
) -> list[OrmMemberItem]:
    items: list[OrmMemberItem] = []
    seen_names: set[str] = set()

    for item in _builtin_method_items(
        BUILTIN_QUERYSET_METHODS,
        runtime=runtime,
        receiver_kind='queryset',
        model_label=model_label,
        manager_name=manager_name,
    ):
        items.append(item)
        seen_names.add(item.name)

    for name, info in QUERYSET_BUILTIN_PROPERTIES.items():
        if django_builtin_available(name, runtime.django_version):
            items.append(OrmMemberItem(name=name, member_kind='property', model_label=model_label,
                                       receiver_kind='queryset', detail=info.description, source='builtin',
                                       return_kind='scalar', field_kind='BooleanField', signature=info.signature))
            seen_names.add(name)

    for item in _static_queryset_method_items(
        static_index=static_index,
        model_label=model_label,
        manager_name=manager_name,
    ):
        if item.name in seen_names:
            continue
        items.append(item)
        seen_names.add(item.name)

    for item in _project_queryset_method_items(static_index=static_index, runtime=runtime,
            model_label=model_label, manager_name=manager_name):
        if item.name in seen_names:
            continue
        items.append(item)
        seen_names.add(item.name)

    return items


def _project_queryset_method_items(*, static_index, runtime, model_label, manager_name):
    captured = _captured_runtime_items(static_index, runtime, model_label, 'queryset', manager_name)
    if captured is not None:
        return captured
    if runtime.detached:
        return []
    manager = _runtime_manager(model_label, manager_name) if runtime.bootstrap_status == 'ready' else None
    if manager is None:
        return []
    queryset_class = _runtime_queryset_class(manager)
    if queryset_class is None:
        return []
    return _runtime_callable_member_items(owner_classes=[queryset_class],
        workspace_files=_workspace_files(static_index), receiver_kind='queryset',
        model_label=model_label, manager_name=manager_name, default_return_kind='queryset')


def _runtime_queryset_class(manager):
    try:
        return type(manager.get_queryset())
    except Exception:
        # Some managers consult database-backed configuration while creating
        # a queryset. Optional callable inspection must not discard an already
        # populated registry. Use its declared class without calling it again.
        declared = inspect.getattr_static(manager, '_queryset_class', None)
        return declared if isinstance(declared, type) else None


def _related_manager_surface(
    *,
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    model_label: str,
    manager_name: str | None,
) -> list[OrmMemberItem]:
    return _manager_surface(
        static_index=static_index,
        runtime=runtime,
        model_label=model_label,
        manager_name=manager_name,
        _runtime_receiver_kind='related_manager',
    )


def _field_member_item(field: FieldCandidate) -> OrmMemberItem:
    member_kind = 'field'
    return_kind = 'scalar'
    return_model_label = None
    detail = field.field_kind

    if field.is_relation:
        member_kind = (
            'reverse_relation'
            if field.relation_direction == 'reverse'
            else 'relation'
        )
        return_model_label = field.related_model_label
        if field.field_kind in {'ForeignKey', 'OneToOneField', 'reverse_OneToOneField'}:
            return_kind = 'instance'
        else:
            return_kind = 'related_manager'
        if field.related_model_label:
            detail = f'{field.field_kind} -> {field.related_model_label}'

    return OrmMemberItem(
        name=field.name,
        member_kind=member_kind,
        model_label=field.model_label,
        receiver_kind='instance',
        detail=detail,
        source='static' if field.source == 'static_edit' else field.source,
        return_kind=return_kind,
        return_model_label=return_model_label,
        file_path=field.file_path,
        line=field.line,
        column=field.column,
        field_kind=field.field_kind,
        is_relation=field.is_relation,
    )


def _manager_name_items(
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    model_label: str,
) -> list[OrmMemberItem]:
    candidate = static_index.find_model_candidate(model_label)
    manager_definitions = _manager_binding_definitions(static_index, candidate)
    names = list(_manager_names(static_index, runtime, model_label))
    items: list[OrmMemberItem] = []
    for name in names:
        definition = manager_definitions.get(name)
        items.append(
            OrmMemberItem(
                name=name,
                member_kind='manager',
                model_label=model_label,
                receiver_kind='model_class',
                detail='Django manager',
                source='runtime' if runtime.bootstrap_status == 'ready' else 'static',
                return_kind='manager',
                return_model_label=model_label,
                manager_name=name,
                file_path=definition['filePath'] if definition else candidate.file_path if candidate else None,
                line=definition['line'] if definition else candidate.line if candidate else None,
                column=definition['column'] if definition else candidate.column if candidate else None,
            )
        )
    return items


def _builtin_method_items(
    definitions: dict[str, tuple[str, str]],
    *,
    runtime: RuntimeInspection,
    receiver_kind: str,
    model_label: str,
    manager_name: str | None,
) -> list[OrmMemberItem]:
    # Look up signature from the knowledge base
    _all_builtins = {**_QUERYSET_BUILTINS, **_MANAGER_BUILTINS}
    if _compact_builtin_items.get():
        return [_builtin_member_template(
            name, 'method', receiver_kind, detail, return_kind, None, None, None,
            None, False, _all_builtins[name].signature if name in _all_builtins else None,
            return_kind in {'instance', 'manager', 'queryset'}, manager_name is not None)
            for name, (detail, return_kind) in sorted(definitions.items())
            if django_builtin_available(name, runtime.django_version)]
    return [
        OrmMemberItem(
            name=name,
            member_kind='method',
            model_label=model_label,
            receiver_kind=receiver_kind,
            detail=detail,
            source='builtin',
            return_kind=return_kind,
            return_model_label=model_label if return_kind in {'instance', 'manager', 'queryset'} else None,
            manager_name=manager_name,
            signature=_all_builtins[name].signature if name in _all_builtins else None,
        )
        for name, (detail, return_kind) in sorted(definitions.items())
        if django_builtin_available(name, runtime.django_version)
    ]


def _builtin_instance_method_items(
    model_label: str,
) -> list[OrmMemberItem]:
    if _compact_builtin_items.get():
        return [_builtin_member_template(
            name, 'method', 'instance', detail, return_kind, None, None, None,
            None, False, _INSTANCE_BUILTINS[name].signature if name in _INSTANCE_BUILTINS else None,
            return_kind == 'instance', False)
            for name, (detail, return_kind) in sorted(BUILTIN_INSTANCE_METHODS.items())]
    return [
        OrmMemberItem(
            name=name,
            member_kind='method',
            model_label=model_label,
            receiver_kind='instance',
            detail=detail,
            source='builtin',
            return_kind=return_kind,
            return_model_label=model_label if return_kind == 'instance' else None,
            signature=_INSTANCE_BUILTINS[name].signature if name in _INSTANCE_BUILTINS else None,
        )
        for name, (detail, return_kind) in sorted(BUILTIN_INSTANCE_METHODS.items())
    ]


def _static_model_method_items(
    *,
    static_index: StaticIndex,
    model_label: str,
    receiver_kind: str,
) -> list[OrmMemberItem]:
    candidate = static_index.find_model_candidate(model_label)
    if candidate is None:
        return []

    return _static_class_method_items(
        static_index=static_index,
        module_name=candidate.module,
        class_name=candidate.object_name,
        receiver_kind=receiver_kind,
        model_label=model_label,
        manager_name=None,
        default_return_kind='unknown',
    )


def _static_manager_method_items(
    *,
    static_index: StaticIndex,
    model_label: str,
    manager_name: str | None,
) -> list[OrmMemberItem]:
    items: list[OrmMemberItem] = []
    seen_names: set[str] = set()

    manager_binding = _manager_binding_for_model(static_index, model_label, manager_name)
    if manager_binding is None:
        return []

    manager_module = manager_binding.get('managerModule')
    manager_class_name = manager_binding.get('managerClassName')
    queryset_module = manager_binding.get('querysetModule')
    queryset_class_name = manager_binding.get('querysetClassName')
    if isinstance(manager_module, str) and isinstance(manager_class_name, str):
        for item in _static_class_method_items(
            static_index=static_index,
            module_name=manager_module,
            class_name=manager_class_name,
            receiver_kind='manager',
            model_label=model_label,
            manager_name=manager_name,
            default_return_kind='queryset',
        ):
            if item.name in seen_names:
                continue
            items.append(item)
            seen_names.add(item.name)

        queryset_ref = _queryset_class_reference_from_manager(
            static_index=static_index,
            module_name=manager_module,
            class_name=manager_class_name,
            visited_classes=set(),
        )
        if queryset_ref is not None:
            queryset_module, queryset_class_name = queryset_ref

    if isinstance(queryset_module, str) and isinstance(queryset_class_name, str):
        for item in _static_class_method_items(
            static_index=static_index,
            module_name=queryset_module,
            class_name=queryset_class_name,
            receiver_kind='manager',
            model_label=model_label,
            manager_name=manager_name,
            default_return_kind='queryset',
        ):
            if item.name in seen_names:
                continue
            items.append(item)
            seen_names.add(item.name)

    return items


def _static_queryset_method_items(
    *,
    static_index: StaticIndex,
    model_label: str,
    manager_name: str | None,
) -> list[OrmMemberItem]:
    manager_binding = _manager_binding_for_model(static_index, model_label, manager_name)
    if manager_binding is None:
        return []

    manager_module = manager_binding.get('managerModule')
    manager_class_name = manager_binding.get('managerClassName')
    queryset_module = manager_binding.get('querysetModule')
    queryset_class_name = manager_binding.get('querysetClassName')
    if (
        not isinstance(queryset_module, str)
        or not isinstance(queryset_class_name, str)
    ) and isinstance(manager_module, str) and isinstance(manager_class_name, str):
        queryset_ref = _queryset_class_reference_from_manager(
            static_index=static_index,
            module_name=manager_module,
            class_name=manager_class_name,
            visited_classes=set(),
        )
        if queryset_ref is not None:
            queryset_module, queryset_class_name = queryset_ref

    if not isinstance(queryset_module, str) or not isinstance(queryset_class_name, str):
        return []

    return _static_class_method_items(
        static_index=static_index,
        module_name=queryset_module,
        class_name=queryset_class_name,
        receiver_kind='queryset',
        model_label=model_label,
        manager_name=manager_name,
        default_return_kind='queryset',
    )


def _static_class_method_items(
    *,
    static_index: StaticIndex,
    module_name: str,
    class_name: str,
    receiver_kind: str,
    model_label: str,
    manager_name: str | None,
    default_return_kind: str,
) -> list[OrmMemberItem]:
    module_index = static_index.modules.get(module_name)
    if module_index is None:
        return []

    declaration = _current_class_declaration(module_index, module_index.file_path, class_name)
    if declaration is None:
        class_node = _parse_class_node(module_index.file_path, class_name)
        if class_node is None:
            return []
        declaration = class_declaration(class_node)

    items: list[OrmMemberItem] = []
    for child in declaration.functions:
        return_kind, return_model_label = _static_return_semantics(
            static_index=static_index,
            annotation=child.annotation,
            current_model_label=model_label,
            default_return_kind=default_return_kind,
        )
        items.append(
            OrmMemberItem(
                name=child.name,
                member_kind=child.member_kind,
                model_label=model_label,
                receiver_kind=receiver_kind,
                detail=child.detail,
                source='static',
                return_kind=return_kind,
                return_model_label=return_model_label,
                manager_name=manager_name,
                file_path=module_index.file_path,
                line=child.line,
                column=child.column,
            )
        )

    return sorted(items, key=lambda item: item.name)


def _static_member_kind(
    node: ast.FunctionDef | ast.AsyncFunctionDef,
) -> str:
    decorator_names = {
        _expression_text(decorator).split('.')[-1]
        for decorator in node.decorator_list
    }
    return 'property' if 'property' in decorator_names else 'method'


def _static_method_detail(
    node: ast.FunctionDef | ast.AsyncFunctionDef,
) -> str:
    decorator_names = {
        _expression_text(decorator).split('.')[-1]
        for decorator in node.decorator_list
    }
    if 'property' in decorator_names:
        return 'Django model property'
    if 'staticmethod' in decorator_names:
        return 'Django static method'
    if 'classmethod' in decorator_names:
        return 'Django class method'
    return 'Django method'


def _static_return_semantics(
    *,
    static_index: StaticIndex,
    annotation: str,
    current_model_label: str,
    default_return_kind: str,
) -> tuple[str, str | None]:
    normalized = annotation.replace(' ', '')
    annotation_model_label = _static_annotation_model_label(
        static_index=static_index,
        annotation=annotation,
        current_model_label=current_model_label,
    )
    if normalized:
        if 'QuerySet' in normalized:
            return 'queryset', annotation_model_label or current_model_label
        if normalized.endswith('Manager') or 'Manager[' in normalized:
            return 'manager', annotation_model_label or current_model_label
        if annotation_model_label is not None:
            return 'instance', annotation_model_label

    if default_return_kind == 'unknown':
        return 'unknown', None

    return default_return_kind, current_model_label


def _project_model_method_items(
    *,
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    model_label: str,
    receiver_kind: str,
) -> list[OrmMemberItem]:
    captured = _captured_runtime_items(static_index, runtime, model_label, receiver_kind, None)
    if captured is not None:
        return captured
    if runtime.bootstrap_status != 'ready' or runtime.detached:
        return []
    model_class = _runtime_model_class(model_label)
    if model_class is None:
        return []

    return _runtime_callable_member_items(
        owner_classes=[model_class],
        workspace_files=_workspace_files(static_index),
        receiver_kind=receiver_kind,
        model_label=model_label,
        manager_name=None,
        default_return_kind='unknown',
    )


@dataclass(slots=True)
class _RuntimeSourcePathResolver:
    workspace_files: set[str] | frozenset[str]
    paths: dict[str, str | None]

    def __call__(self, source_file):
        if source_file in self.paths:
            return self.paths[source_file]
        resolved = source_file if source_file in self.workspace_files else str(Path(source_file).resolve())
        result = resolved if resolved in self.workspace_files else None
        self.paths[source_file] = result
        return result


@dataclass(frozen=True, slots=True)
class _CallableCandidateSnapshot:
    owners: tuple[type, ...]
    namespaces: tuple[dict[str, object], ...]
    codes: tuple[tuple[object, object], ...]
    names: frozenset[str]

    def matches(self, owners, namespaces):
        # Copied namespaces keep their keys/values alive and preserve order.
        # Own a coherent namespace copy before separate key/value checks. C
        # iterators preserve identity semantics without user-defined equality;
        # namespace reordering conservatively scans candidates again.
        return (len(owners) == len(self.owners)
            and all(old is new for old, new in zip(self.owners, owners))
            and all(len(old) == len(current := new.copy()) and all(map(is_, old, current))
                    and all(map(is_, old.values(), current.values()))
                    for old, new in zip(self.namespaces, namespaces))
            and all(target.__code__ is code for target, code in self.codes))


def _runtime_callable_member_items(
    *,
    owner_classes: list[type[object]],
    workspace_files: set[str] | frozenset[str],
    receiver_kind: str,
    model_label: str,
    manager_name: str | None,
    default_return_kind: str,
) -> list[OrmMemberItem]:
    items: list[OrmMemberItem] = []
    seen_names: set[str] = set()
    batch_paths = _runtime_source_paths.get()
    if batch_paths is not None and isinstance(workspace_files, frozenset):
        # The resolver owns this exact membership set and its path cache.
        # Context copies may share the batch: publish one owner atomically.
        key = id(workspace_files)
        resolve_source_path = batch_paths.get(key)
        if resolve_source_path is None:
            candidate = _RuntimeSourcePathResolver(workspace_files, {})
            resolve_source_path = batch_paths.setdefault(key, candidate)
    else:
        resolve_source_path = _RuntimeSourcePathResolver(workspace_files, {})

    for owner_class in owner_classes:
        for name, raw_member in _workspace_callable_members(owner_class, resolve_source_path):
            if name.startswith('_') or name in seen_names:
                continue

            callable_member, member_kind, member_detail = _callable_member_target(
                raw_member
            )
            if callable_member is None:
                continue

            code = getattr(callable_member, '__code__', None)
            source_file = code.co_filename if code is not None else None
            # Python functions carry their source filename directly. Avoid
            # getsourcefile's per-method stat/module search for ordinary .py
            # files; membership below is the authoritative workspace check.
            if source_file is None or not source_file.endswith(('.py', '.pyw')):
                try:
                    source_file = inspect.getsourcefile(callable_member)
                except (OSError, TypeError):
                    source_file = None
            if source_file is None:
                continue
            resolved_path = resolve_source_path(source_file)
            if resolved_path is None:
                continue

            # Use __code__.co_firstlineno for O(1) line lookup instead of
            # inspect.getsourcelines which reads and parses the source file.
            line = getattr(code, 'co_firstlineno', None) if code is not None else None

            return_kind, return_model_label = _runtime_return_semantics(
                callable_member,
                default_return_kind=default_return_kind,
                current_model_label=model_label,
            )
            items.append(
                OrmMemberItem(
                    name=name,
                    member_kind=member_kind,
                    model_label=model_label,
                    receiver_kind=receiver_kind,
                    detail=member_detail,
                    source='runtime',
                    return_kind=return_kind,
                    return_model_label=return_model_label,
                    manager_name=manager_name,
                    file_path=resolved_path,
                    line=line,
                    column=1,
                )
            )
            seen_names.add(name)

    return sorted(items, key=lambda item: item.name)


def _workspace_callable_members(owner_class: type[object], resolve_source_path):
    """Statically resolve project callables without inspecting every library member.

    Namespace scanning only selects names; getattr_static still decides which
    declaration wins under subclass overrides and metaclass descriptors.
    DynamicClassAttribute's duplicate-name fallback keeps inspect's behavior.
    """
    if any(isinstance(member, DynamicClassAttribute)
           for base in owner_class.__bases__ for member in vars(base).values()):
        return inspect.getmembers_static(owner_class)
    class_owners = inspect.getmro(owner_class)
    owners = (*class_owners, *inspect.getmro(type(owner_class)))
    class_namespaces = [vars(base) for base in class_owners]
    namespaces = list(class_namespaces)
    namespaces.extend(vars(base) for base in owners[len(class_owners):])
    batch = _runtime_callable_candidates.get()
    key = None
    if (batch is not None and isinstance(resolve_source_path, _RuntimeSourcePathResolver)
            and isinstance(resolve_source_path.workspace_files, frozenset)):
        key = (id(owner_class), id(resolve_source_path.workspace_files))
        cached = batch.get(key)
        if cached is not None and cached[0] is resolve_source_path.workspace_files and cached[1].matches(owners, namespaces):
            candidates = cached[1].names
        else:
            candidates = None
    else:
        candidates = None
    if candidates is None:
        # Candidate names and their reuse guard must describe the same view.
        # Source resolution can yield while the live class namespace changes.
        captured_namespaces = (tuple(dict(namespace) for namespace in namespaces)
            if key is not None else namespaces)
        candidates, codes = _workspace_callable_candidate_names(captured_namespaces, resolve_source_path)
        if key is not None and codes is not None:
            batch[key] = (resolve_source_path.workspace_files,
                _CallableCandidateSnapshot(owners, captured_namespaces,
                                           tuple(codes), frozenset(candidates)))
    if not candidates:
        return []
    # Visibility and descriptor precedence are live even when candidate source
    # names are reused. Annotation/default/signature metadata is read later.
    visible = candidates.intersection(dir(owner_class))
    selected = []
    for name in sorted(visible):
        try:
            member = inspect.getattr_static(owner_class, name)
        except AttributeError:
            member = next((namespace[name] for namespace in class_namespaces
                           if name in namespace), None)
        selected.append((name, member))
    return selected


def _workspace_callable_candidate_names(namespaces, resolve_source_path):
    candidates = set()
    codes = []
    reusable = True
    for namespace in namespaces:
        for name, member in namespace.items():
            if name.startswith('_') or name in candidates:
                continue
            target, _, _ = _callable_member_target(member)
            if target is None:
                continue
            code = getattr(target, '__code__', None)
            source_file = code.co_filename if code is not None else None
            # Standard wrapper targets are immutable; Python function code can
            # change in place and is part of the reuse guard. Unusual wrappers
            # and source discovery through inspect retain the complete scan.
            if (type(member) not in (property, staticmethod, classmethod) and not inspect.isfunction(member)
                    or not inspect.isfunction(target) or source_file is None
                    or not source_file.endswith(('.py', '.pyw'))):
                reusable = False
            else:
                codes.append((target, code))
            if source_file is None or not source_file.endswith(('.py', '.pyw')):
                try:
                    source_file = inspect.getsourcefile(target)
                except (OSError, TypeError):
                    source_file = None
            if source_file is not None and resolve_source_path(source_file) is not None:
                candidates.add(name)
    return candidates, codes if reusable else None


def _callable_member_target(raw_member: object) -> tuple[object | None, str, str]:
    if isinstance(raw_member, property):
        if raw_member.fget is None:
            return None, '', ''
        return raw_member.fget, 'property', 'Django model property'

    if isinstance(raw_member, staticmethod):
        return raw_member.__func__, 'method', 'Django static method'

    if isinstance(raw_member, classmethod):
        return raw_member.__func__, 'method', 'Django class method'

    if inspect.isfunction(raw_member):
        return raw_member, 'method', 'Django method'

    return None, '', ''


def _runtime_return_semantics(
    callable_member: object,
    *,
    default_return_kind: str,
    current_model_label: str,
) -> tuple[str, str | None]:
    annotation: object = inspect.Signature.empty

    try:
        annotation = inspect.signature(callable_member).return_annotation
    except (TypeError, ValueError):
        annotation = inspect.Signature.empty

    if annotation is inspect.Signature.empty:
        try:
            annotation = get_type_hints(callable_member).get('return', inspect.Signature.empty)
        except Exception:
            annotation = inspect.Signature.empty

    resolved = _return_semantics_from_annotation(
        annotation,
        current_model_label=current_model_label,
    )
    if resolved is not None:
        return resolved

    if default_return_kind == 'unknown':
        return 'unknown', None
    return default_return_kind, current_model_label


def _return_semantics_from_annotation(
    annotation: object,
    *,
    current_model_label: str,
) -> tuple[str, str | None] | None:
    if annotation is inspect.Signature.empty:
        return None

    if isinstance(annotation, str):
        return _return_semantics_from_annotation_string(
            annotation,
            current_model_label=current_model_label,
        )

    origin = get_origin(annotation)
    if origin is not None:
        for argument in get_args(annotation):
            resolved = _return_semantics_from_annotation(
                argument,
                current_model_label=current_model_label,
            )
            if resolved is not None:
                return resolved
        return None

    if annotation is None or annotation is type(None):  # noqa: E721
        return None

    try:
        from django.db import models  # type: ignore
    except Exception:
        models = None

    if models is not None:
        if inspect.isclass(annotation) and issubclass(annotation, models.QuerySet):
            return 'queryset', current_model_label
        if inspect.isclass(annotation) and issubclass(annotation, models.Manager):
            return 'manager', current_model_label
        if inspect.isclass(annotation) and issubclass(annotation, models.Model):
            return 'instance', _model_label_for_runtime_model(annotation)

    return None


def _return_semantics_from_annotation_string(
    annotation: str,
    *,
    current_model_label: str,
) -> tuple[str, str | None] | None:
    normalized = annotation.replace(' ', '')
    annotation_model_label = _runtime_annotation_model_label(
        annotation,
        current_model_label=current_model_label,
    )
    if 'QuerySet' in normalized:
        return 'queryset', annotation_model_label or current_model_label
    if normalized.endswith('Manager') or 'Manager[' in normalized:
        return 'manager', annotation_model_label or current_model_label
    if annotation_model_label is not None:
        return 'instance', annotation_model_label

    return None


def _static_annotation_model_label(
    *,
    static_index: StaticIndex,
    annotation: str,
    current_model_label: str,
) -> str | None:
    candidate = static_index.find_model_candidate(current_model_label)
    if candidate is None:
        return None

    for reference in _annotation_reference_candidates(annotation):
        resolved_label = static_index.resolve_model_label_reference(
            module_name=candidate.module,
            app_label=candidate.app_label,
            reference=reference,
        )
        if resolved_label is not None:
            return resolved_label

    return None


def _runtime_annotation_model_label(
    annotation: str,
    *,
    current_model_label: str,
) -> str | None:
    try:
        from django.apps import apps  # type: ignore
    except Exception:
        return None

    current_model_class = _runtime_model_class(current_model_label)
    current_app_label = (
        getattr(current_model_class._meta, 'app_label', None)
        if current_model_class is not None
        else None
    )
    all_models = list(apps.get_models())

    for reference in _annotation_reference_candidates(annotation):
        if '.' in reference:
            app_label, _, object_name = reference.rpartition('.')
            if app_label and object_name:
                try:
                    model_class = apps.get_model(app_label, object_name)
                except Exception:
                    model_class = None
                if model_class is not None:
                    return _model_label_for_runtime_model(model_class)

            module_name, _, class_name = reference.rpartition('.')
            if module_name and class_name:
                for model_class in all_models:
                    if model_class.__module__ == module_name and model_class.__name__ == class_name:
                        return _model_label_for_runtime_model(model_class)

        if isinstance(current_app_label, str):
            same_app_matches = [
                model_class
                for model_class in all_models
                if (
                    getattr(model_class._meta, 'app_label', None) == current_app_label
                    and model_class.__name__ == reference
                )
            ]
            if len(same_app_matches) == 1:
                return _model_label_for_runtime_model(same_app_matches[0])

        global_matches = [
            model_class
            for model_class in all_models
            if model_class.__name__ == reference
        ]
        if len(global_matches) == 1:
            return _model_label_for_runtime_model(global_matches[0])

    return None


def _annotation_reference_candidates(annotation: str) -> list[str]:
    candidates: list[str] = []
    seen: set[str] = set()
    for match in re.finditer(r'[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*', annotation):
        candidate = match.group(0)
        if candidate in seen or candidate in {'None', 'NoneType'}:
            continue
        seen.add(candidate)
        candidates.append(candidate)
    return candidates


def _manager_binding_for_model(
    static_index: StaticIndex,
    model_label: str,
    manager_name: str | None,
) -> dict[str, object] | None:
    candidate = static_index.find_model_candidate(model_label)
    definitions = _manager_binding_definitions(static_index, candidate)
    if not definitions:
        return None

    if manager_name and manager_name in definitions:
        return definitions[manager_name]

    if 'objects' in definitions:
        return definitions['objects']

    return next(iter(definitions.values()), None)


def _queryset_class_reference_from_manager(
    *,
    static_index: StaticIndex,
    module_name: str,
    class_name: str,
    visited_classes: set[tuple[str, str]],
) -> tuple[str, str] | None:
    visit_key = (module_name, class_name)
    if visit_key in visited_classes:
        return None
    visited_classes.add(visit_key)

    module_index = static_index.modules.get(module_name)
    if module_index is None:
        return None

    declaration = _current_class_declaration(module_index, module_index.file_path, class_name)
    if declaration is None:
        class_node = _parse_class_node(module_index.file_path, class_name)
        if class_node is None:
            return None
        declaration = class_declaration(class_node)

    for base in declaration.bases:
        if base.from_queryset:
            if base.queryset_symbol is None:
                continue
            queryset_symbol = base.queryset_symbol
            if not queryset_symbol:
                continue
            queryset_module, queryset_class_name = _resolve_symbol_source(
                symbol_name=queryset_symbol,
                module_name=module_name,
                module_index=module_index,
                static_index=static_index,
            )
            return queryset_module, queryset_class_name

        base_symbol = base.expression.split('.')[-1]
        if not base_symbol:
            continue
        base_module, base_class_name = _resolve_symbol_source(
            symbol_name=base_symbol,
            module_name=module_name,
            module_index=module_index,
            static_index=static_index,
        )
        resolved = _queryset_class_reference_from_manager(
            static_index=static_index,
            module_name=base_module,
            class_name=base_class_name,
            visited_classes=visited_classes,
        )
        if resolved is not None:
            return resolved

    return None


@lru_cache(maxsize=1)
def _native_workspace_path_functions():
    # Keep only process-library functions, never workspace paths or owners.
    import sys
    if sys.platform not in ('darwin', 'linux'):
        return None
    try:
        import ctypes
        library = ctypes.CDLL(None)
        realpath, free = library.realpath, library.free
        realpath.argtypes = [ctypes.c_char_p, ctypes.c_void_p]
        realpath.restype = ctypes.c_void_p
        free.argtypes = [ctypes.c_void_p]
        free.restype = None
    except (ImportError, AttributeError, OSError):
        return None
    return realpath, ctypes.string_at, free


def _native_workspace_path_is_canonical(file_path):
    if type(file_path) is not str or '\x00' in file_path:
        return False
    functions = _native_workspace_path_functions()
    if functions is None:
        return False
    encoded = os.fsencode(file_path)
    realpath, string_at, free = functions
    pointer = realpath(encoded, None)
    if not pointer:
        return False
    try:
        # Darwin may correct the spelling of case-insensitive paths. Only
        # accept an identical absolute path; aliases/case changes use pathlib's
        # existing semantics through the ordinary resolver below.
        return string_at(pointer) == encoded
    finally:
        free(pointer)


def _canonical_workspace_source_path(file_path: str) -> str:
    if os.name != 'posix':
        return str(Path(file_path).resolve())
    # Match POSIX Path.resolve without constructing/parsing Path objects for
    # every source. Keep realpath's complete ancestor/leaf symlink checks and
    # its final stat: non-strict realpath alone would hide symlink loops.
    try:
        canonical = (file_path if _native_workspace_path_is_canonical(file_path)
            else os.path.realpath(file_path))
        os.stat(canonical)
    except OSError:
        # Preserve pathlib's non-strict missing/denied-path and loop contract.
        return str(Path(file_path).resolve())
    return canonical


def _canonical_workspace_source_paths(static_index: StaticIndex) -> dict[str, str]:
    """Resolve source paths while reusing POSIX parent directory realpaths."""
    if os.name != 'posix':
        return {name: _canonical_workspace_source_path(module.file_path)
            for name, module in static_index.modules.items()}

    canonical_parents: dict[str, str] = {}
    paths_by_module: dict[str, str] = {}
    for name, module in static_index.modules.items():
        file_path = module.file_path
        if type(file_path) is str:
            parent, leaf = os.path.split(file_path)
        else:
            parent = os.path.dirname(file_path)
        try:
            canonical_parent = canonical_parents.get(parent)
            if canonical_parent is None:
                canonical_parent = _canonical_workspace_source_path(parent)
                canonical_parents[parent] = canonical_parent
            if stat.S_ISLNK(os.lstat(file_path).st_mode):
                canonical = _canonical_workspace_source_path(file_path)
            else:
                # Reuse only exact strings whose spelling already equals the join.
                # Redundant separators, aliases and owner-bearing inputs keep the ordinary path.
                if (type(file_path) is str and type(canonical_parent) is str
                        and canonical_parent == parent
                        and len(file_path) == len(parent) + len(leaf) + (not parent.endswith('/'))):
                    canonical = file_path
                else:
                    canonical = os.path.join(canonical_parent, leaf if type(file_path) is str
                        else os.path.basename(file_path))
                os.stat(canonical)
        except OSError:
            # Preserve pathlib's non-strict behavior for denied, missing,
            # non-directory, or concurrently replaced paths.
            canonical = _canonical_workspace_source_path(file_path)
        paths_by_module[name] = canonical
    return paths_by_module


def _workspace_files(static_index: StaticIndex) -> frozenset[str]:
    with _workspace_files_cache_lock:
        if static_index._workspace_source_paths is not None:
            return static_index._workspace_source_paths

    paths_by_module = _canonical_workspace_source_paths(static_index)
    counts: dict[str, int] = {}
    for file_path in paths_by_module.values():
        counts[file_path] = counts.get(file_path, 0) + 1
    files = frozenset(counts)
    with _workspace_files_cache_lock:
        static_index._workspace_source_paths_by_module = paths_by_module
        static_index._workspace_source_path_counts = counts
        static_index._workspace_source_paths = files
    return files


def runtime_workspace_paths_are_current(static_index: StaticIndex) -> bool:
    """Validate prepared membership at a source publication boundary."""
    prepared = static_index._workspace_source_paths_by_module
    if prepared is None:
        return True
    if len(prepared) != len(static_index.modules):
        return False
    parents: dict[str, str] = {}
    for name, cached_path in prepared.items():
        module = static_index.modules.get(name)
        if module is None:
            return False
        parent, leaf = os.path.split(module.file_path)
        canonical_parent = parents.get(parent)
        if canonical_parent is None:
            canonical_parent = _canonical_workspace_source_path(parent)
            parents[parent] = canonical_parent
        # File aliases need their own check. Regular files already have fresh
        # stat identities from the source scan; resolve each parent only once.
        if (cached_path != os.path.join(canonical_parent, leaf)
                and _canonical_workspace_source_path(module.file_path) != cached_path):
            return False
    return True


def prebuild_runtime_workspace_paths(static_index: StaticIndex, runtime: RuntimeInspection) -> None:
    """Warm the foreground owner's source caches before full-ready publication."""
    if runtime.bootstrap_status == 'ready' and static_index.model_candidates:
        _workspace_files(static_index)
        static_index._import_dependents()
        # The empty seed builds only immutable constructor adjacency; it
        # cannot match a Python module or require a dependent closure.
        static_index.constructor_dependents('')


def _manager_names(
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    model_label: str,
) -> list[str]:
    owned = _owned_runtime_members(static_index, runtime)
    if owned is not None and model_label not in owned.invalidated_labels and model_label in owned.manager_names:
        return list(owned.manager_names[model_label])
    pending = owned is not None and model_label in owned.invalidated_labels
    labels = _runtime_capture_labels.get()
    runtime_label = labels.get(model_label, model_label) if labels is not None else model_label
    catalogs = _runtime_model_catalogs.get()
    if pending:
        runtime_model = None
    elif catalogs is None:
        runtime_model = next(
            (candidate for candidate in runtime.model_catalog if candidate.label == runtime_label),
            None,
        )
    else:
        catalog = runtime.model_catalog
        cached = catalogs.get(id(catalog))
        if cached is None:
            models = {}
            for candidate in catalog:
                models.setdefault(candidate.label, candidate)
            # Keep the tuple alive with its map, including nested builds for
            # other runtimes. The first matching summary retains precedence.
            cached = (catalog, models)
            catalogs[id(catalog)] = cached
        runtime_model = cached[1].get(runtime_label)
    if runtime_model is not None and runtime_model.manager_names:
        return sorted(dict.fromkeys(runtime_model.manager_names))

    candidate = static_index.find_model_candidate(model_label)
    if candidate is None or candidate.is_abstract:
        return []

    definitions = _manager_binding_definitions(static_index, candidate)
    if definitions:
        return sorted(definitions)

    return ['objects']


def _manager_binding_definitions(
    static_index: StaticIndex,
    candidate: ModelCandidate | None,
) -> dict[str, dict[str, object]]:
    if candidate is None:
        return {}

    module_index = static_index.modules.get(candidate.module)
    if module_index is None:
        return {}
    declaration = _current_class_declaration(module_index, candidate.file_path, candidate.object_name)
    if declaration is None:
        class_node = _parse_class_node(candidate.file_path, candidate.object_name)
        if class_node is None:
            return {}
        declaration = class_declaration(class_node)
        source_stamp = getattr(class_node, '_orm_source_stamp', class_node)
    else:
        source_stamp = module_index.source_member_declarations.source_hash

    # Every lookup checks the source stat; declarations also require a matching
    # content hash. A changed class gets a new stamp during nested builds. Keep index and
    # module owners alive until the build ends, and never share mutable results
    # with callers or carry bindings across reindex boundaries.
    batch_bindings = _static_manager_bindings.get()
    # Concurrent cold lru_cache misses may produce two AST objects for the
    # same source. Reuse their stable stamp rather than object identity.
    cache_key = (id(static_index), id(module_index), candidate.file_path,
                 candidate.object_name, source_stamp)
    if batch_bindings is not None and cache_key in batch_bindings:
        return {name: dict(value) for name, value in batch_bindings[cache_key][2].items()}

    definitions: dict[str, dict[str, object]] = {}
    for child in declaration.assignments:
        manager_metadata = _manager_assignment_metadata(
            child.call,
            module_index,
            static_index,
        )
        if manager_metadata is None:
            continue

        definitions[child.name] = {
            'filePath': candidate.file_path,
            'line': child.line,
            'column': child.column,
            **manager_metadata,
        }

    if batch_bindings is not None:
        batch_bindings[cache_key] = (static_index, module_index,
            {name: dict(value) for name, value in definitions.items()})
    return definitions


def _manager_assignment_metadata(
    value_node: ast.expr | ManagerCall | None,
    module_index: ModuleIndex,
    static_index: StaticIndex,
) -> dict[str, object] | None:
    call = value_node if isinstance(value_node, ManagerCall) else manager_call(value_node)
    if call is None:
        return None

    if call.nested_function is not None:
        nested_function_text = call.nested_function
        if nested_function_text.endswith('.from_queryset'):
            manager_symbol = nested_function_text[: -len('.from_queryset')].split('.')[-1]
            if not manager_symbol:
                return None

            manager_module, manager_class_name = _resolve_symbol_source(
                symbol_name=manager_symbol,
                module_name=module_index.module_name,
                module_index=module_index,
                static_index=static_index,
            )

            queryset_module: str | None = None
            queryset_class_name: str | None = None
            if call.queryset_symbol is not None:
                queryset_symbol = call.queryset_symbol
                if queryset_symbol:
                    queryset_module, queryset_class_name = _resolve_symbol_source(
                        symbol_name=queryset_symbol,
                        module_name=module_index.module_name,
                        module_index=module_index,
                        static_index=static_index,
                    )

            metadata: dict[str, object] = {
                'managerModule': manager_module,
                'managerClassName': manager_class_name,
            }
            if queryset_module and queryset_class_name:
                metadata['querysetModule'] = queryset_module
                metadata['querysetClassName'] = queryset_class_name
            return metadata

    function_text = call.function
    if not function_text:
        return None

    if function_text.endswith('.as_manager'):
        queryset_symbol = function_text[: -len('.as_manager')].split('.')[-1]
        queryset_module, queryset_class_name = _resolve_symbol_source(
            symbol_name=queryset_symbol,
            module_name=module_index.module_name,
            module_index=module_index,
            static_index=static_index,
        )
        return {
            'querysetModule': queryset_module,
            'querysetClassName': queryset_class_name,
        }

    function_tail = function_text.split('.')[-1]
    if function_tail.endswith('Manager') or function_tail == 'Manager':
        manager_module, manager_class_name = _resolve_symbol_source(
            symbol_name=function_tail,
            module_name=module_index.module_name,
            module_index=module_index,
            static_index=static_index,
        )
        return {
            'managerModule': manager_module,
            'managerClassName': manager_class_name,
        }

    resolved_module_name, resolved_symbol_name = _resolve_symbol_source(
        symbol_name=function_tail,
        module_name=module_index.module_name,
        module_index=module_index,
        static_index=static_index,
    )
    if (
        resolved_module_name == module_index.module_name
        and resolved_symbol_name.endswith('Manager')
    ):
        return {
            'managerModule': resolved_module_name,
            'managerClassName': resolved_symbol_name,
        }

    return None

def _runtime_model_class(model_label: str) -> type[object] | None:
    labels = _runtime_capture_labels.get()
    if labels is not None:
        model_label = labels.get(model_label, model_label)
    try:
        from django.apps import apps  # type: ignore
    except Exception:
        return None

    if '.' not in model_label:
        return None

    app_label, object_name = model_label.split('.', 1)
    try:
        model_class = apps.get_model(app_label, object_name)
    except Exception:
        return None

    return model_class


def _runtime_manager(
    model_label: str,
    manager_name: str | None,
) -> object | None:
    model_class = _runtime_model_class(model_label)
    if model_class is None:
        return None

    candidate_names = [manager_name] if manager_name else []
    try:
        default_manager_name = model_class._default_manager.name  # type: ignore[attr-defined]
    except Exception:
        default_manager_name = 'objects'
    candidate_names.append(default_manager_name)

    for candidate_name in candidate_names:
        if not candidate_name:
            continue
        try:
            return getattr(model_class, candidate_name)
        except Exception:
            continue

    return None


def _model_label_for_runtime_model(model_class: type[object]) -> str | None:
    meta = getattr(model_class, '_meta', None)
    if meta is None:
        return None
    app_label = getattr(meta, 'app_label', None)
    object_name = getattr(meta, 'object_name', None)
    if not isinstance(app_label, str) or not isinstance(object_name, str):
        return None
    return f'{app_label}.{object_name}'


@latest_source_cache(maxsize=512, stamp_index=1)
def _current_member_source_hash(file_path: str, source_stamp: tuple[int, ...]) -> str | None:
    try:
        return member_source_hash(Path(file_path).read_text(encoding='utf-8'))
    except (OSError, UnicodeDecodeError):
        return None


def _current_class_declaration(module_index: ModuleIndex, file_path: str, class_name: str) -> ClassDeclaration | None:
    declarations = getattr(module_index, 'source_member_declarations', None)
    if declarations is None or module_index.file_path != file_path:
        return None
    try:
        stamp = source_stat_key(os.stat(file_path))
    except OSError:
        _current_member_source_hash.cache_discard(file_path)
        return None
    if _current_member_source_hash(file_path, stamp) != declarations.source_hash:
        return None
    return declarations.classes.get(class_name)


def _parse_class_node(file_path: str, class_name: str) -> ast.ClassDef | None:
    try:
        source_stat = os.stat(file_path)
    except OSError:
        _parse_class_nodes_cached.cache_discard(file_path)
        return None
    return _parse_class_node_cached(file_path, class_name, source_stat_key(source_stat))


def _parse_class_nodes(file_path: str, source_stamp: tuple[int, ...]) -> dict[str, ast.ClassDef]:
    try:
        text = Path(file_path).read_text(encoding='utf-8')
        parsed_module = ast.parse(text)
        prepare_source_columns(parsed_module, text)
    except (OSError, SyntaxError, UnicodeDecodeError):
        return {}

    classes = {}
    for node in parsed_module.body:
        if isinstance(node, ast.ClassDef):
            node._orm_source_stamp = source_stamp
            classes.setdefault(node.name, node)
    return classes


@latest_source_cache(maxsize=512, stamp_index=1)
def _parse_class_nodes_cached(file_path: str, source_stamp: tuple[int, ...]) -> dict[str, ast.ClassDef]:
    return _parse_class_nodes(file_path, source_stamp)


def _parse_class_node_uncached(file_path: str, class_name: str, source_stamp: tuple[int, ...]) -> ast.ClassDef | None:
    return _parse_class_nodes(file_path, source_stamp).get(class_name)


@wraps(_parse_class_node_uncached)
def _parse_class_node_cached(file_path: str, class_name: str, source_stamp: tuple[int, ...]) -> ast.ClassDef | None:
    return _parse_class_nodes_cached(file_path, source_stamp).get(class_name)


_parse_class_node_cached.cache_clear = _parse_class_nodes_cached.cache_clear
_parse_class_node_cached.cache_info = _parse_class_nodes_cached.cache_info


def _expression_text(expression: ast.expr | None) -> str:
    if expression is None:
        return ''

    try:
        return ast.unparse(expression)
    except Exception:
        return ''


def _resolve_symbol_source(
    *,
    symbol_name: str,
    module_name: str,
    module_index: ModuleIndex,
    static_index: StaticIndex | None,
) -> tuple[str, str]:
    for binding in module_index.import_bindings:
        if binding.alias != symbol_name or binding.is_star:
            continue
        if binding.symbol is None:
            return binding.module, symbol_name

        if static_index is None:
            return binding.module, binding.symbol

        resolution = static_index.resolve_export_origin(binding.module, binding.symbol)
        return (
            resolution.origin_module or binding.module,
            resolution.origin_symbol or binding.symbol,
        )

    return module_name, symbol_name
