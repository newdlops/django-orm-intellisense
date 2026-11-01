"""Bounded workspace-owned interning for detached, immutable analysis records."""
from __future__ import annotations

from dataclasses import fields, replace
from pathlib import Path

from ..discovery.workspace import PythonSourceEntry, PythonSourceSnapshot
from ..features.orm_members import OrmMemberItem
from ..runtime.inspector import RuntimeFieldSummary, RuntimeModelSummary, RuntimeRelationSummary
from ..runtime.lookup_catalog import LookupTypeTable
from ..runtime.projects import copy_source_index
from ..semantic.graph import ModelGraphEdge, ModelGraphNode
from ..static_index.indexer import FieldCandidate, ModelCandidate


class _FrozenDict(dict):
    __slots__ = ()

    def _immutable(self, *_args, **_kwargs):
        raise TypeError('Shared project metadata is immutable')

    __setitem__ = __delitem__ = clear = pop = popitem = setdefault = update = __ior__ = _immutable

    def __reduce__(self):
        return type(self), (dict(self),)


_RECORDS = {kind: tuple(item.name for item in fields(kind)) for kind in (
    RuntimeFieldSummary, RuntimeModelSummary, RuntimeRelationSummary, ModelGraphEdge,
    ModelGraphNode, FieldCandidate, ModelCandidate, OrmMemberItem, PythonSourceEntry, PythonSourceSnapshot)}
_TRUE, _FALSE = object(), object()


def _token(value):
    if type(value) is bool:
        return _TRUE if value else _FALSE
    if type(value) is float:
        return float, value
    if type(value) in (str, bytes, int, type(None)):
        return value
    return type(value), id(value)


class ProjectRecordPool:
    def __init__(self):
        # Entries own canonical keys as well as values. Owners store those
        # same key objects, never equal freshly allocated record trees.
        self._entries = {}
        self._owners = {}

    def _intern(self, key, value, seen):
        entry = self._entries.get(key)
        if entry is None:
            entry = [key, value, 0]
            self._entries[key] = entry
        seen.add(entry[0])
        return entry[1]

    def _freeze(self, value, seen):
        kind = type(value)
        if kind in (str, bytes):
            return self._intern((kind, value), value, seen)
        if kind in (int, float, bool, type(None)):
            return value
        if isinstance(value, Path):
            return self._intern((kind, str(value)), value, seen)
        if kind in (list, tuple):
            row = tuple(self._freeze(item, seen) for item in value)
            return self._intern((tuple, tuple(map(_token, row))), row, seen)
        if kind is frozenset:
            row = frozenset(self._freeze(item, seen) for item in value)
            return self._intern((frozenset, frozenset(map(_token, row))), row, seen)
        if kind in (dict, _FrozenDict) or isinstance(value, LookupTypeTable):
            pairs = tuple((self._freeze(key, seen), self._freeze(item, seen)) for key, item in value.items())
            key = _FrozenDict, tuple((_token(name), _token(item)) for name, item in pairs)
            entry = self._entries.get(key)
            return self._intern(key, entry[1] if entry is not None else _FrozenDict(pairs), seen)
        names = _RECORDS.get(kind)
        if names is not None:
            values = {name: self._freeze(getattr(value, name), seen) for name in names}
            key = kind, tuple(_token(values[name]) for name in names)
            entry = self._entries.get(key)
            return self._intern(key, entry[1] if entry is not None else replace(value, **values), seen)
        raise TypeError(f'Unsupported detached project record: {kind.__name__}')

    def _own(self, owner, build):
        seen = set()
        try:
            value = build(lambda item: self._freeze(item, seen))
        except BaseException:
            for key in seen:
                if self._entries[key][2] == 0:
                    del self._entries[key]
            raise
        previous = self._owners.get(owner, set())
        for key in seen - previous:
            self._entries[key][2] += 1
        for key in previous - seen:
            entry = self._entries[key]
            entry[2] -= 1
            if entry[2] == 0:
                del self._entries[key]
        self._owners[owner] = seen
        return value

    def share(self, value):
        def build(freeze):
            runtime = value.inspection
            # Profile owners remain distinct. Their published leaf records
            # are immutable tuples/maps, so sharing cannot cross an edit.
            catalog = {name: {key: freeze(row) for key, row in table.items()}
                for name, table in runtime.lookup_catalog.items()}
            runtime = replace(runtime, model_catalog=freeze(runtime.model_catalog),
                model_preview=[freeze(model) for model in runtime.model_preview], lookup_catalog=catalog,
                custom_lookups={name: freeze(names) for name, names in runtime.custom_lookups.items()})
            graph = value.model_graph
            graph = replace(graph,
                fields_by_model_label={label: freeze(row) for label, row in graph.fields_by_model_label.items()},
                nodes_by_label={label: freeze(node) for label, node in graph.nodes_by_label.items()},
                nodes_by_object_name={name: freeze(nodes) for name, nodes in graph.nodes_by_object_name.items()},
                node_by_import_path={path: freeze(node) for path, node in graph.node_by_import_path.items()},
                edges_by_source_label={label: freeze(edges) for label, edges in graph.edges_by_source_label.items()},
                static_field_overrides={label: freeze(row) for label, row in graph.static_field_overrides.items()})
            members = value.members
            if members is not None:
                members = replace(members, runtime_identity=freeze(members.runtime_identity),
                    items={freeze(key): freeze(rows) for key, rows in members.items.items()},
                    manager_names={name: freeze(names) for name, names in members.manager_names.items()},
                    complete_labels=freeze(members.complete_labels), invalidated_labels=freeze(members.invalidated_labels),
                    models={key: freeze(model) for key, model in members.models.items()})
            static = copy_source_index(value.static_index)
            static._runtime_member_snapshot = members
            return replace(value, static_index=static, inspection=runtime, model_graph=graph, members=members,
                surface={label: freeze(row) for label, row in value.surface.items()},
                source_snapshot=freeze(value.source_snapshot) if value.source_snapshot is not None else None)
        return self._own(('runtime', value.project.namespace), build)

    def share_contribution(self, namespace, tables):
        return self._own(('wire', namespace), lambda freeze:
            tuple({key: freeze(row) for key, row in table.items()} for table in tables))

    def clear(self):
        self._entries.clear()
        self._owners.clear()
