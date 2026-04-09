from __future__ import annotations

import ast
import inspect
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, get_args, get_origin, get_type_hints

from ..runtime.inspector import RuntimeInspection
from ..static_index.indexer import FieldCandidate, ModelCandidate, ModuleIndex, StaticIndex


class _MemberSurfaceCache:
    """(model_label, receiver_kind, manager_name) → {name: OrmMemberItem} 캐시.
    surface 리스트 구성을 1회만 수행하고 이후 O(1) 조회.
    static_index/runtime 인스턴스가 바뀌면 자동 무효화."""

    def __init__(self) -> None:
        self._owner: tuple[int, int] = (0, 0)
        self._list_cache: dict[
            tuple[str, str, str | None], list[OrmMemberItem]
        ] = {}
        self._dict_cache: dict[
            tuple[str, str, str | None], dict[str, OrmMemberItem]
        ] = {}
        self._hits = 0
        self._misses = 0

    def _check_owner(
        self, static_index: StaticIndex, runtime: RuntimeInspection
    ) -> None:
        owner = (id(static_index), id(runtime))
        if owner != self._owner:
            self._list_cache.clear()
            self._dict_cache.clear()
            self._owner = owner

    def get_list(
        self,
        static_index: StaticIndex,
        runtime: RuntimeInspection,
        model_label: str,
        receiver_kind: str,
        manager_name: str | None,
    ) -> list[OrmMemberItem]:
        self._check_owner(static_index, runtime)
        key = (model_label, receiver_kind, manager_name)
        cached = self._list_cache.get(key)
        if cached is not None:
            self._hits += 1
            return cached
        self._misses += 1
        surface = _member_surface(
            static_index=static_index,
            runtime=runtime,
            model_label=model_label,
            receiver_kind=receiver_kind,
            manager_name=manager_name,
        )
        self._list_cache[key] = surface
        self._dict_cache[key] = {item.name: item for item in surface}
        return surface

    def find(
        self,
        static_index: StaticIndex,
        runtime: RuntimeInspection,
        model_label: str,
        receiver_kind: str,
        name: str,
        manager_name: str | None,
    ) -> OrmMemberItem | None:
        self._check_owner(static_index, runtime)
        key = (model_label, receiver_kind, manager_name)
        name_dict = self._dict_cache.get(key)
        if name_dict is not None:
            self._hits += 1
            return name_dict.get(name)
        self._misses += 1
        self.get_list(
            static_index, runtime, model_label, receiver_kind, manager_name
        )
        return self._dict_cache[key].get(name)


_surface_cache = _MemberSurfaceCache()

BUILTIN_QUERYSET_METHODS: dict[str, tuple[str, str]] = {
    'all': ('Django queryset method', 'queryset'),
    'alias': ('Django queryset method', 'queryset'),
    'annotate': ('Django queryset method', 'queryset'),
    'count': ('Django queryset method', 'scalar'),
    'create': ('Django queryset method', 'instance'),
    'defer': ('Django queryset method', 'queryset'),
    'distinct': ('Django queryset method', 'queryset'),
    'exclude': ('Django queryset method', 'queryset'),
    'exists': ('Django queryset method', 'scalar'),
    'filter': ('Django queryset method', 'queryset'),
    'first': ('Django queryset method', 'instance'),
    'get': ('Django queryset method', 'instance'),
    'last': ('Django queryset method', 'instance'),
    'only': ('Django queryset method', 'queryset'),
    'order_by': ('Django queryset method', 'queryset'),
    'prefetch_related': ('Django queryset method', 'queryset'),
    'select_related': ('Django queryset method', 'queryset'),
    'update': ('Django queryset method', 'scalar'),
    'values': ('Django queryset method', 'unknown'),
    'values_list': ('Django queryset method', 'unknown'),
}

BUILTIN_MANAGER_METHODS: dict[str, tuple[str, str]] = {
    **BUILTIN_QUERYSET_METHODS,
    'bulk_create': ('Django manager method', 'scalar'),
    'get_queryset': ('Django manager method', 'queryset'),
    'get_or_create': ('Django manager method', 'unknown'),
    'update_or_create': ('Django manager method', 'unknown'),
}


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

    def to_dict(self) -> dict[str, object]:
        return {
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


def build_surface_index(
    static_index: StaticIndex,
    runtime: RuntimeInspection,
) -> dict[str, object]:
    """전체 model surface를 경량 dict로 빌드. TS에 전송하여 로컬 O(1) 해석."""
    index: dict[str, dict[str, dict[str, list[str | None]]]] = {}
    receiver_kinds = ['instance', 'model_class', 'manager', 'queryset', 'related_manager']
    for candidate in static_index.model_candidates:
        if candidate.is_abstract:
            continue
        model_entry: dict[str, dict[str, list[str | None]]] = {}
        for kind in receiver_kinds:
            surface = _surface_cache.get_list(
                static_index, runtime,
                candidate.label, kind, None,
            )
            kind_entry: dict[str, list[str | None]] = {}
            for item in surface:
                if item.return_kind:
                    kind_entry[item.name] = [
                        item.return_kind,
                        item.return_model_label or item.model_label,
                    ]
            if kind_entry:
                model_entry[kind] = kind_entry
        if model_entry:
            index[candidate.label] = model_entry
    return index


def prebuild_member_surface_cache(
    static_index: StaticIndex,
    runtime: RuntimeInspection,
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
                static_index, runtime,
                candidate.label, kind, None,
            )
            count += 1
    surface_index = build_surface_index(static_index, runtime)
    elapsed = time.perf_counter() - started
    print(
        f'[PERF] prebuild_member_surface_cache: {count} surfaces '
        f'{elapsed:.2f}s '
        f'cache={_surface_cache._hits}hit/{_surface_cache._misses}miss '
        f'surfaceIndex={len(surface_index)} models',
        file=__import__("sys").stderr,
    )
    return surface_index


def resolve_orm_member_chain(
    *,
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    model_label: str,
    receiver_kind: str,
    chain: list[str],
    manager_name: str | None = None,
) -> dict[str, object]:
    """멤버 체인을 한 번에 해석. IPC 1회로 여러 단계 해석."""
    current_label = model_label
    current_kind = receiver_kind
    current_manager = manager_name

    for name in chain:
        item = _surface_cache.find(
            static_index, runtime,
            current_label, current_kind, name, current_manager,
        )
        if item is None:
            return {
                'resolved': False,
                'reason': 'not_found',
                'failedAt': name,
                'modelLabel': current_label,
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
        current_label = return_label
        current_kind = return_kind
        current_manager = (
            item.manager_name or item.name
            if return_kind == 'manager'
            else item.manager_name
        )

    return {
        'resolved': True,
        'modelLabel': current_label,
        'receiverKind': current_kind,
        'managerName': current_manager,
    }


def list_orm_member_completions(
    *,
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    model_label: str,
    receiver_kind: str,
    prefix: str | None = None,
    manager_name: str | None = None,
) -> dict[str, object]:
    items = _surface_cache.get_list(
        static_index, runtime, model_label, receiver_kind, manager_name,
    )

    return {
        'resolved': True,
        'items': [item.to_dict() for item in items],
        'receiverKind': receiver_kind,
        'modelLabel': model_label,
        'managerName': manager_name,
    }


def resolve_orm_member(
    *,
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    model_label: str,
    receiver_kind: str,
    name: str,
    manager_name: str | None = None,
) -> dict[str, object]:
    normalized_name = name.strip()
    if not normalized_name:
        return {'resolved': False, 'reason': 'empty'}

    item = _surface_cache.find(
        static_index, runtime, model_label, receiver_kind,
        normalized_name, manager_name,
    )
    if item is None:
        return {
            'resolved': False,
            'reason': 'not_found',
        }

    return {
        'resolved': True,
        'item': item.to_dict(),
    }


def _member_surface(
    *,
    static_index: StaticIndex,
    runtime: RuntimeInspection,
    model_label: str,
    receiver_kind: str,
    manager_name: str | None,
) -> list[OrmMemberItem]:
    if receiver_kind == 'instance':
        return _instance_surface(static_index, runtime, model_label)
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
    model_label: str,
) -> list[OrmMemberItem]:
    items: list[OrmMemberItem] = []
    seen_names: set[str] = set()

    for field in static_index.fields_for_model(model_label):
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

    return items


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
        )
        for name, (detail, return_kind) in sorted(definitions.items())
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
                if source_file is None or str(Path(source_file).resolve()) not in workspace_files:
                    continue

                try:
                    _, line = inspect.getsourcelines(callable_member)
                except (OSError, TypeError):
                    line = None

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
                        file_path=str(Path(source_file).resolve()),
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
    return {
        str(Path(module.file_path).resolve())
        for module in static_index.modules.values()
    }


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
