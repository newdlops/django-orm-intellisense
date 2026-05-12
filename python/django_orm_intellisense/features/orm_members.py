from __future__ import annotations

import ast
import hashlib
import inspect
import json
import os
import re
import threading
import dataclasses
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, get_args, get_origin, get_type_hints

from ..runtime.inspector import RuntimeInspection
from ..semantic.graph import ModelGraph
from ..static_index.indexer import FieldCandidate, ModelCandidate, ModuleIndex, StaticIndex
from .django_builtins import (
    INSTANCE_BUILTIN_METHODS as _INSTANCE_BUILTINS,
    MANAGER_BUILTIN_METHODS as _MANAGER_BUILTINS,
    QUERYSET_BUILTIN_METHODS as _QUERYSET_BUILTINS,
)


class _MemberSurfaceCache:
    """(model_label, receiver_kind, manager_name) → {name: OrmMemberItem} 캐시.
    surface 리스트 구성을 1회만 수행하고 이후 O(1) 조회.
    static_index/runtime 인스턴스가 바뀌면 자동 무효화."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._owner: tuple[int, int, int] = (0, 0, 0)
        self._list_cache: dict[
            tuple[str, str, str | None], list[OrmMemberItem]
        ] = {}
        self._dict_cache: dict[
            tuple[str, str, str | None], dict[str, OrmMemberItem]
        ] = {}
        self._hits = 0
        self._misses = 0

    def _check_owner(
        self,
        static_index: StaticIndex,
        runtime: RuntimeInspection,
        model_graph: ModelGraph | None,
    ) -> None:
        owner = (id(static_index), id(runtime), id(model_graph))
        if owner != self._owner:
            self._list_cache.clear()
            self._dict_cache.clear()
            self._owner = owner

    def get_list(
        self,
        static_index: StaticIndex,
        runtime: RuntimeInspection,
        model_graph: ModelGraph | None,
        model_label: str,
        receiver_kind: str,
        manager_name: str | None,
    ) -> list[OrmMemberItem]:
        key = (model_label, receiver_kind, manager_name)
        with self._lock:
            self._check_owner(static_index, runtime, model_graph)
            cached = self._list_cache.get(key)
            if cached is not None:
                self._hits += 1
                return cached
            self._misses += 1

        import time as _time
        _started = _time.perf_counter()
        surface = _member_surface(
            static_index=static_index,
            runtime=runtime,
            model_graph=model_graph,
            model_label=model_label,
            receiver_kind=receiver_kind,
            manager_name=manager_name,
        )
        _elapsed = _time.perf_counter() - _started
        if _elapsed >= 0.010:
            print(
                f'[surface:miss] {model_label}/{receiver_kind} '
                f'{_elapsed:.3f}s items={len(surface)}',
                file=__import__("sys").stderr,
                flush=True,
            )
        with self._lock:
            self._check_owner(static_index, runtime, model_graph)
            cached = self._list_cache.get(key)
            if cached is not None:
                self._hits += 1
                return cached
            self._list_cache[key] = surface
            self._dict_cache[key] = {item.name: item for item in surface}
            return surface

    def invalidate_model(self, model_label: str) -> None:
        """Invalidate cache entries for a specific model label."""
        with self._lock:
            keys_to_remove = [
                key for key in self._list_cache if key[0] == model_label
            ]
            for key in keys_to_remove:
                self._list_cache.pop(key, None)
                self._dict_cache.pop(key, None)

    def force_owner(
        self,
        static_index: StaticIndex,
        runtime: RuntimeInspection,
        model_graph: ModelGraph | None,
    ) -> None:
        """Update the owner without clearing the cache.

        Used when static_index is replaced but most cache entries are still
        valid (e.g. single-file reindex).
        """
        with self._lock:
            self._owner = (id(static_index), id(runtime), id(model_graph))

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
                return name_dict.get(name)
            self._misses += 1

        self.get_list(
            static_index, runtime, model_graph, model_label, receiver_kind, manager_name
        )
        with self._lock:
            return self._dict_cache[key].get(name)


_surface_cache = _MemberSurfaceCache()
_workspace_files_cache_lock = threading.RLock()
_workspace_files_cache_owner = 0
_workspace_files_cache_value: set[str] | None = None

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


@dataclass(frozen=True)
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

    nodes_by_module_and_name: dict[tuple[str, str], str] = {}
    for graph_label, node in model_graph.nodes_by_label.items():
        if not node.module:
            continue
        nodes_by_module_and_name.setdefault(
            (node.module, node.object_name), graph_label,
        )

    label_map: dict[str, str] = {}
    for candidate in static_index.model_candidates:
        graph_label = nodes_by_module_and_name.get(
            (candidate.module, candidate.object_name)
        )
        if graph_label and graph_label != candidate.label:
            label_map[candidate.label] = graph_label
    return label_map


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


def build_surface_index(
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    model_graph: ModelGraph | None = None,
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

    index: dict[str, dict[str, dict[str, list[str | None]]]] = {}
    receiver_kinds = ['instance', 'model_class', 'manager', 'queryset', 'related_manager']
    for candidate in static_index.model_candidates:
        if candidate.is_abstract:
            continue
        # Internal lookups (StaticIndex.find_model_candidate, field tables)
        # are keyed by candidate.label; only the OUTER dict key flips to the
        # graph label. This is the smallest change that fixes the captain
        # pattern without rippling label semantics into every downstream
        # resolver — those migrations belong in the audit step.
        surface_key = label_map.get(candidate.label, candidate.label)
        model_entry: dict[str, dict[str, list[str | None]]] = {}
        for kind in receiver_kinds:
            surface = _surface_cache.get_list(
                static_index, runtime, model_graph,
                candidate.label, kind, None,
            )
            kind_entry: dict[str, list[str | None]] = {}
            for item in surface:
                if item.return_kind:
                    kind_entry[item.name] = [
                        item.return_kind,
                        _remap_label(
                            item.return_model_label or item.model_label,
                            label_map,
                        ),
                        item.member_kind,
                        item.field_kind,
                    ]
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
            model_class_entry['objects'] = [
                'manager', surface_key, 'manager', None,
            ]
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
    )
    return hashlib.blake2b(
        serialized.encode('utf-8'),
        digest_size=16,
    ).hexdigest()


def rebuild_surface_for_models(
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    model_graph: ModelGraph | None,
    affected_labels: set[str],
    existing_surface_index: dict[str, object],
) -> dict[str, object]:
    """Rebuild surface entries for affected models and merge into existing index.

    - Invalidates only the affected model cache entries.
    - Updates force_owner so _check_owner doesn't clear the entire cache.
    - Returns the full updated surface_index.
    """
    import time
    started = time.perf_counter()

    # Update owner reference without clearing cache
    _surface_cache.force_owner(static_index, runtime, model_graph)
    # Invalidate only affected models
    for label in affected_labels:
        _surface_cache.invalidate_model(label)

    label_map = _build_static_to_graph_label_map(static_index, model_graph)

    # Build a shallow copy of the existing surface index
    index: dict[str, dict[str, dict[str, list[str | None]]]] = dict(existing_surface_index)  # type: ignore[arg-type]

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
        model_entry: dict[str, dict[str, list[str | None]]] = {}
        for kind in receiver_kinds:
            surface = _surface_cache.get_list(
                static_index, runtime, model_graph,
                candidate.label, kind, None,
            )
            kind_entry: dict[str, list[str | None]] = {}
            for item in surface:
                if item.return_kind:
                    kind_entry[item.name] = [
                        item.return_kind,
                        _remap_label(
                            item.return_model_label or item.model_label,
                            label_map,
                        ),
                        item.member_kind,
                        item.field_kind,
                ]
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


def prebuild_member_surface_cache(
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    model_graph: ModelGraph | None = None,
) -> dict[str, object]:
    """초기화 시 모든 모델의 member surface를 프리빌드하고 surface index를 반환."""
    import time
    started = time.perf_counter()
    receiver_kinds = ['instance', 'model_class', 'manager', 'queryset', 'related_manager']
    count = 0
    for candidate in static_index.model_candidates:
        if candidate.is_abstract:
            continue
        for kind in receiver_kinds:
            _surface_cache.get_list(
                static_index, runtime, model_graph,
                candidate.label, kind, None,
            )
            count += 1
    surface_index = build_surface_index(static_index, runtime, model_graph)
    elapsed = time.perf_counter() - started
    print(
        f'[PERF] prebuild_member_surface_cache: {count} surfaces '
        f'{elapsed:.2f}s '
        f'cache={_surface_cache._hits}hit/{_surface_cache._misses}miss '
        f'surfaceIndex={len(surface_index)} models',
        file=__import__("sys").stderr,
    )
    log_surface_index_gap(static_index, model_graph, surface_index)
    return surface_index


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
        if builtin is not None:
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
        builtin = BUILTIN_QUERYSET_METHODS.get(name)
        if builtin is not None:
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
) -> list[OrmMemberItem]:
    items: list[OrmMemberItem] = []
    seen_names: set[str] = set()

    for item in _builtin_method_items(
        BUILTIN_MANAGER_METHODS,
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

    runtime_manager = _runtime_manager(model_label, manager_name)
    if runtime_manager is not None:
        for item in _runtime_callable_member_items(
            owner_classes=[runtime_manager.__class__],
            workspace_files=_workspace_files(static_index),
            receiver_kind='manager',
            model_label=model_label,
            manager_name=manager_name,
            default_return_kind='queryset',
        ):
            if item.name in seen_names:
                continue
            items.append(item)
            seen_names.add(item.name)

        queryset = runtime_manager.get_queryset()
        for item in _runtime_callable_member_items(
            owner_classes=[queryset.__class__],
            workspace_files=_workspace_files(static_index),
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
        receiver_kind='queryset',
        model_label=model_label,
        manager_name=manager_name,
    ):
        items.append(item)
        seen_names.add(item.name)

    for item in _static_queryset_method_items(
        static_index=static_index,
        model_label=model_label,
        manager_name=manager_name,
    ):
        if item.name in seen_names:
            continue
        items.append(item)
        seen_names.add(item.name)

    runtime_manager = _runtime_manager(model_label, manager_name)
    if runtime_manager is not None:
        queryset = runtime_manager.get_queryset()
        for item in _runtime_callable_member_items(
            owner_classes=[queryset.__class__],
            workspace_files=_workspace_files(static_index),
            receiver_kind='queryset',
            model_label=model_label,
            manager_name=manager_name,
            default_return_kind='queryset',
        ):
            if item.name in seen_names:
                continue
            items.append(item)
            seen_names.add(item.name)

    return items


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
        source=field.source,
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
    receiver_kind: str,
    model_label: str,
    manager_name: str | None,
) -> list[OrmMemberItem]:
    # Look up signature from the knowledge base
    _all_builtins = {**_QUERYSET_BUILTINS, **_MANAGER_BUILTINS}
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
    ]


def _builtin_instance_method_items(
    model_label: str,
) -> list[OrmMemberItem]:
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

    class_node = _parse_class_node(module_index.file_path, class_name)
    if class_node is None:
        return []

    items: list[OrmMemberItem] = []
    for child in class_node.body:
        if not isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if child.name.startswith('_'):
            continue

        member_kind = _static_member_kind(child)
        detail = _static_method_detail(child)
        return_kind, return_model_label = _static_return_semantics(
            static_index=static_index,
            annotation=_expression_text(child.returns),
            current_model_label=model_label,
            default_return_kind=default_return_kind,
        )
        items.append(
            OrmMemberItem(
                name=child.name,
                member_kind=member_kind,
                model_label=model_label,
                receiver_kind=receiver_kind,
                detail=detail,
                source='static',
                return_kind=return_kind,
                return_model_label=return_model_label,
                manager_name=manager_name,
                file_path=module_index.file_path,
                line=getattr(child, 'lineno', None),
                column=(
                    getattr(child, 'col_offset', 0) + 1
                    if getattr(child, 'col_offset', None) is not None
                    else None
                ),
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


def _runtime_callable_member_items(
    *,
    owner_classes: list[type[object]],
    workspace_files: set[str],
    receiver_kind: str,
    model_label: str,
    manager_name: str | None,
    default_return_kind: str,
) -> list[OrmMemberItem]:
    items: list[OrmMemberItem] = []
    seen_names: set[str] = set()
    resolved_path_cache: dict[str, str | None] = {}

    def _resolve_source_path(source_file: str) -> str | None:
        cached = resolved_path_cache.get(source_file)
        if cached is not None:
            return cached
        resolved = str(Path(source_file).resolve())
        result = resolved if resolved in workspace_files else None
        resolved_path_cache[source_file] = result or ''
        return result

    for owner_class in owner_classes:
        for class_in_mro in owner_class.mro():
            if class_in_mro is object:
                continue

            for name, raw_member in inspect.getmembers_static(class_in_mro):
                if name.startswith('_') or name in seen_names:
                    continue

                callable_member, member_kind, member_detail = _callable_member_target(
                    raw_member
                )
                if callable_member is None:
                    continue

                try:
                    source_file = inspect.getsourcefile(callable_member)
                except (OSError, TypeError):
                    source_file = None
                if source_file is None:
                    continue
                resolved_path = _resolve_source_path(source_file)
                if resolved_path is None:
                    continue

                # Use __code__.co_firstlineno for O(1) line lookup instead of
                # inspect.getsourcelines which reads and parses the source file.
                code = getattr(callable_member, '__code__', None)
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

    class_node = _parse_class_node(module_index.file_path, class_name)
    if class_node is None:
        return None

    for base in class_node.bases:
        if isinstance(base, ast.Call) and _expression_text(base.func).endswith('.from_queryset'):
            if not base.args:
                continue
            queryset_symbol = _expression_text(base.args[0]).split('.')[-1]
            if not queryset_symbol:
                continue
            queryset_module, queryset_class_name = _resolve_symbol_source(
                symbol_name=queryset_symbol,
                module_name=module_name,
                module_index=module_index,
                static_index=static_index,
            )
            return queryset_module, queryset_class_name

        base_symbol = _expression_text(base).split('.')[-1]
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


def _workspace_files(static_index: StaticIndex) -> set[str]:
    global _workspace_files_cache_owner, _workspace_files_cache_value
    owner = id(static_index)
    with _workspace_files_cache_lock:
        if owner == _workspace_files_cache_owner and _workspace_files_cache_value is not None:
            return _workspace_files_cache_value

    files = {
        str(Path(module.file_path).resolve())
        for module in static_index.modules.values()
    }
    with _workspace_files_cache_lock:
        _workspace_files_cache_owner = owner
        _workspace_files_cache_value = files
    return files


def _manager_names(
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    model_label: str,
) -> list[str]:
    runtime_model = next(
        (candidate for candidate in runtime.model_catalog if candidate.label == model_label),
        None,
    )
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
    class_node = _parse_class_node(candidate.file_path, candidate.object_name)
    if module_index is None or class_node is None:
        return {}

    definitions: dict[str, dict[str, object]] = {}
    for child in class_node.body:
        target_name: str | None = None
        value_node: ast.expr | None = None
        if isinstance(child, ast.Assign) and len(child.targets) == 1 and isinstance(child.targets[0], ast.Name):
            target_name = child.targets[0].id
            value_node = child.value
        elif isinstance(child, ast.AnnAssign) and isinstance(child.target, ast.Name):
            target_name = child.target.id
            value_node = child.value

        if target_name is None or value_node is None:
            continue
        manager_metadata = _manager_assignment_metadata(
            value_node,
            module_index,
            static_index,
        )
        if manager_metadata is None:
            continue

        definitions[target_name] = {
            'filePath': candidate.file_path,
            'line': getattr(child, 'lineno', None),
            'column': getattr(child, 'col_offset', 0) + 1 if getattr(child, 'col_offset', None) is not None else None,
            **manager_metadata,
        }

    return definitions


def _manager_assignment_metadata(
    value_node: ast.expr,
    module_index: ModuleIndex,
    static_index: StaticIndex,
) -> dict[str, object] | None:
    if not isinstance(value_node, ast.Call):
        return None

    if isinstance(value_node.func, ast.Call):
        nested_call = value_node.func
        nested_function_text = _expression_text(nested_call.func)
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
            if nested_call.args:
                queryset_symbol = _expression_text(nested_call.args[0]).split('.')[-1]
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

    function_text = _expression_text(value_node.func)
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


def _parse_class_node(file_path: str, class_name: str) -> ast.ClassDef | None:
    try:
        mtime_ns = os.stat(file_path).st_mtime_ns
    except OSError:
        return None
    return _parse_class_node_cached(file_path, class_name, mtime_ns)


@lru_cache(maxsize=8192)
def _parse_class_node_cached(
    file_path: str,
    class_name: str,
    mtime_ns: int,
) -> ast.ClassDef | None:
    try:
        parsed_module = ast.parse(Path(file_path).read_text(encoding='utf-8'))
    except (OSError, SyntaxError, UnicodeDecodeError):
        return None

    return next(
        (
            node
            for node in parsed_module.body
            if isinstance(node, ast.ClassDef) and node.name == class_name
        ),
        None,
    )


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
