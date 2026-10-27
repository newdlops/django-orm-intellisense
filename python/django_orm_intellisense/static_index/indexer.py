from __future__ import annotations

import ast
import os
import hashlib
import dataclasses
from dataclasses import dataclass
from pathlib import Path
from queue import Empty, SimpleQueue
from concurrent.futures import ThreadPoolExecutor

from ..discovery.workspace import iter_python_files
from .class_members import SourceMemberDeclarations
from .source_coordinates import prepare_source_columns, source_column
from .field_declarations import (DeclarationContext, class_declaration_contexts, class_field_contexts,
    normalize_declaration, imported_references, resolve_imported_constant)

RELATION_FIELD_KINDS = {
    'ForeignKey',
    'OneToOneField',
    'ManyToManyField',
    'ParentalKey',
    'ParentalManyToManyField',
}

DJANGO_FIELD_CLASS_NAMES = {
    'AutoField',
    'BigAutoField',
    'BigIntegerField',
    'BinaryField',
    'BooleanField',
    'CharField',
    'CommaSeparatedIntegerField',
    'CompositePrimaryKey',
    'DateField',
    'DateTimeField',
    'DecimalField',
    'DurationField',
    'EmailField',
    'Field',
    'FileField',
    'FilePathField',
    'FloatField',
    'ForeignKey',
    'GeneratedField',
    'GenericIPAddressField',
    'IPAddressField',
    'ImageField',
    'IntegerField',
    'JSONField',
    'ManyToManyField',
    'NullBooleanField',
    'OneToOneField',
    'PositiveBigIntegerField',
    'PositiveIntegerField',
    'PositiveSmallIntegerField',
    'SlugField',
    'SmallAutoField',
    'SmallIntegerField',
    'TextField',
    'TimeField',
    'URLField',
    'UUIDField',
}

KNOWN_EXTERNAL_FIELD_CLASS_NAMES = {
    'ParentalKey',
    'ParentalManyToManyField',
}


@dataclass(frozen=True, slots=True)
class DefinitionLocation:
    file_path: str
    line: int
    column: int

    def __getstate__(self):
        return (
            self.file_path, self.line, self.column,
        )

    def __setstate__(self, state):
        (
            file_path, line, column,
        ) = state
        assign = object.__setattr__
        assign(self, 'file_path', file_path)
        assign(self, 'line', line)
        assign(self, 'column', column)

    def to_dict(self) -> dict[str, int | str]:
        return {
            'filePath': self.file_path,
            'line': self.line,
            'column': self.column,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, object]) -> DefinitionLocation:
        return cls(
            file_path=str(payload['filePath']),
            line=int(payload['line']),
            column=int(payload['column']),
        )


@dataclass(frozen=True, slots=True)
class ModelCandidate:
    app_label: str
    object_name: str
    label: str
    module: str
    file_path: str
    line: int
    column: int
    is_abstract: bool = False
    base_class_refs: tuple[str, ...] = ()
    source: str = 'static'

    def __getstate__(self):
        return (
            self.app_label, self.object_name, self.label, self.module,
            self.file_path, self.line, self.column, self.is_abstract,
            self.base_class_refs, self.source,
        )

    def __setstate__(self, state):
        (
            app_label, object_name, label, module,
            file_path, line, column, is_abstract,
            base_class_refs, source,
        ) = state
        assign = object.__setattr__
        assign(self, 'app_label', app_label)
        assign(self, 'object_name', object_name)
        assign(self, 'label', label)
        assign(self, 'module', module)
        assign(self, 'file_path', file_path)
        assign(self, 'line', line)
        assign(self, 'column', column)
        assign(self, 'is_abstract', is_abstract)
        assign(self, 'base_class_refs', base_class_refs)
        assign(self, 'source', source)

    def to_dict(self) -> dict[str, str | int | bool | list[str]]:
        return {
            'appLabel': self.app_label,
            'objectName': self.object_name,
            'label': self.label,
            'module': self.module,
            'filePath': self.file_path,
            'line': self.line,
            'column': self.column,
            'isAbstract': self.is_abstract,
            'baseClassRefs': list(self.base_class_refs),
            'source': self.source,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, object]) -> ModelCandidate:
        return cls(
            app_label=str(payload['appLabel']),
            object_name=str(payload['objectName']),
            label=str(payload['label']),
            module=str(payload['module']),
            file_path=str(payload['filePath']),
            line=int(payload['line']),
            column=int(payload['column']),
            is_abstract=bool(payload.get('isAbstract', False)),
            base_class_refs=tuple(
                str(base_ref) for base_ref in payload.get('baseClassRefs', [])
            ),
            source=str(payload.get('source', 'static')),
        )


@dataclass(frozen=True, slots=True)
class PendingFieldCandidate:
    model_label: str
    model_module: str
    app_label: str
    name: str
    file_path: str
    line: int
    column: int
    field_call_ref: str
    field_kind: str
    is_relation: bool
    related_model_ref_kind: str | None
    related_model_ref_value: str | None
    related_name: str | None
    related_query_name: str | None
    constructor_fingerprint: str | None = None
    constructor_imports: tuple[str, ...] = ()
    has_primary_key_option: bool = False

    def __getstate__(self):
        return (
            self.model_label, self.model_module, self.app_label, self.name,
            self.file_path, self.line, self.column, self.field_call_ref,
            self.field_kind, self.is_relation, self.related_model_ref_kind, self.related_model_ref_value,
            self.related_name, self.related_query_name, self.constructor_fingerprint, self.constructor_imports,
            self.has_primary_key_option,
        )

    def __setstate__(self, state):
        (
            model_label, model_module, app_label, name,
            file_path, line, column, field_call_ref,
            field_kind, is_relation, related_model_ref_kind, related_model_ref_value,
            related_name, related_query_name, constructor_fingerprint, constructor_imports,
            has_primary_key_option,
        ) = state
        assign = object.__setattr__
        assign(self, 'model_label', model_label)
        assign(self, 'model_module', model_module)
        assign(self, 'app_label', app_label)
        assign(self, 'name', name)
        assign(self, 'file_path', file_path)
        assign(self, 'line', line)
        assign(self, 'column', column)
        assign(self, 'field_call_ref', field_call_ref)
        assign(self, 'field_kind', field_kind)
        assign(self, 'is_relation', is_relation)
        assign(self, 'related_model_ref_kind', related_model_ref_kind)
        assign(self, 'related_model_ref_value', related_model_ref_value)
        assign(self, 'related_name', related_name)
        assign(self, 'related_query_name', related_query_name)
        assign(self, 'constructor_fingerprint', constructor_fingerprint)
        assign(self, 'constructor_imports', constructor_imports)
        assign(self, 'has_primary_key_option', has_primary_key_option)

    def to_dict(self) -> dict[str, object]:
        return {
            'modelLabel': self.model_label,
            'modelModule': self.model_module,
            'appLabel': self.app_label,
            'name': self.name,
            'filePath': self.file_path,
            'line': self.line,
            'column': self.column,
            'fieldCallRef': self.field_call_ref,
            'fieldKind': self.field_kind,
            'isRelation': self.is_relation,
            'relatedModelRefKind': self.related_model_ref_kind,
            'relatedModelRefValue': self.related_model_ref_value,
            'relatedName': self.related_name,
            'relatedQueryName': self.related_query_name,
            'constructorFingerprint': self.constructor_fingerprint,
            'constructorImports': list(self.constructor_imports),
            'hasPrimaryKeyOption': self.has_primary_key_option,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, object]) -> PendingFieldCandidate:
        return cls(
            model_label=str(payload['modelLabel']),
            model_module=str(payload['modelModule']),
            app_label=str(payload['appLabel']),
            name=str(payload['name']),
            file_path=str(payload['filePath']),
            line=int(payload['line']),
            column=int(payload['column']),
            field_call_ref=str(payload.get('fieldCallRef', payload['fieldKind'])),
            field_kind=str(payload['fieldKind']),
            is_relation=bool(payload['isRelation']),
            related_model_ref_kind=_string_or_none(payload.get('relatedModelRefKind')),
            related_model_ref_value=_string_or_none(payload.get('relatedModelRefValue')),
            related_name=_string_or_none(payload.get('relatedName')),
            related_query_name=_string_or_none(payload.get('relatedQueryName')),
            constructor_fingerprint=_string_or_none(payload.get('constructorFingerprint')),
            constructor_imports=tuple(str(value) for value in payload.get('constructorImports', [])),
            has_primary_key_option=bool(payload.get('hasPrimaryKeyOption', False)),
        )


@dataclass(frozen=True, slots=True)
class FieldCandidate:
    model_label: str
    name: str
    file_path: str
    line: int
    column: int
    field_kind: str
    is_relation: bool
    relation_direction: str | None
    related_model_label: str | None
    declared_model_label: str | None = None
    related_name: str | None = None
    related_query_name: str | None = None
    source: str = 'static'
    constructor_fingerprint: str | None = None
    imported_constants: tuple[tuple[str, str], ...] = ()
    declaration_module: str | None = None

    def __getstate__(self):
        return (
            self.model_label, self.name, self.file_path, self.line,
            self.column, self.field_kind, self.is_relation, self.relation_direction,
            self.related_model_label, self.declared_model_label, self.related_name, self.related_query_name,
            self.source, self.constructor_fingerprint, self.imported_constants, self.declaration_module,
        )

    def __setstate__(self, state):
        (
            model_label, name, file_path, line,
            column, field_kind, is_relation, relation_direction,
            related_model_label, declared_model_label, related_name, related_query_name,
            source, constructor_fingerprint, imported_constants, declaration_module,
        ) = state
        assign = object.__setattr__
        assign(self, 'model_label', model_label)
        assign(self, 'name', name)
        assign(self, 'file_path', file_path)
        assign(self, 'line', line)
        assign(self, 'column', column)
        assign(self, 'field_kind', field_kind)
        assign(self, 'is_relation', is_relation)
        assign(self, 'relation_direction', relation_direction)
        assign(self, 'related_model_label', related_model_label)
        assign(self, 'declared_model_label', declared_model_label)
        assign(self, 'related_name', related_name)
        assign(self, 'related_query_name', related_query_name)
        assign(self, 'source', source)
        assign(self, 'constructor_fingerprint', constructor_fingerprint)
        assign(self, 'imported_constants', imported_constants)
        assign(self, 'declaration_module', declaration_module)

    def to_dict(self) -> dict[str, str | int | bool | None]:
        return {
            'modelLabel': self.model_label,
            'name': self.name,
            'filePath': self.file_path,
            'line': self.line,
            'column': self.column,
            'fieldKind': self.field_kind,
            'isRelation': self.is_relation,
            'relationDirection': self.relation_direction,
            'relatedModelLabel': self.related_model_label,
            'source': self.source,
            'constructorFingerprint': self.constructor_fingerprint,
        }


@dataclass(frozen=True, slots=True)
class ImportBinding:
    module: str
    symbol: str | None
    alias: str
    is_star: bool

    def __getstate__(self):
        return (
            self.module, self.symbol, self.alias, self.is_star,
        )

    def __setstate__(self, state):
        (
            module, symbol, alias, is_star,
        ) = state
        assign = object.__setattr__
        assign(self, 'module', module)
        assign(self, 'symbol', symbol)
        assign(self, 'alias', alias)
        assign(self, 'is_star', is_star)

    def to_dict(self) -> dict[str, object]:
        return {
            'module': self.module,
            'symbol': self.symbol,
            'alias': self.alias,
            'isStar': self.is_star,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, object]) -> ImportBinding:
        return cls(
            module=str(payload['module']),
            symbol=_string_or_none(payload.get('symbol')),
            alias=str(payload['alias']),
            is_star=bool(payload['isStar']),
        )


@dataclass(frozen=True)
class ModuleIndex:
    module_name: str
    file_path: str
    is_package_init: bool
    defined_symbols: set[str]
    symbol_definitions: dict[str, DefinitionLocation]
    import_bindings: list[ImportBinding]
    explicit_all: list[str] | None
    model_candidates: list[ModelCandidate]
    pending_fields: list[PendingFieldCandidate]
    class_base_refs: dict[str, tuple[str, ...]] = dataclasses.field(default_factory=dict)
    field_class_names: tuple[str, ...] = ()
    field_aliases: dict[str, str] = dataclasses.field(default_factory=dict)
    constructor_imports: tuple[str, ...] = ()
    source_member_declarations: SourceMemberDeclarations | None = dataclasses.field(default=None, compare=False)

    def to_dict(self) -> dict[str, object]:
        payload = {
            'moduleName': self.module_name,
            'filePath': self.file_path,
            'isPackageInit': self.is_package_init,
            'definedSymbols': sorted(self.defined_symbols),
            'symbolDefinitions': {
                symbol: location.to_dict()
                for symbol, location in self.symbol_definitions.items()
            },
            'importBindings': [binding.to_dict() for binding in self.import_bindings],
            'explicitAll': list(self.explicit_all) if self.explicit_all is not None else None,
            'modelCandidates': [candidate.to_dict() for candidate in self.model_candidates],
            'pendingFields': [field.to_dict() for field in self.pending_fields],
            'classBaseRefs': {k: list(v) for k, v in self.class_base_refs.items()},
            'fieldClassNames': list(self.field_class_names),
            'fieldAliases': dict(self.field_aliases),
            'constructorImports': list(self.constructor_imports),
        }
        if self.source_member_declarations is not None:
            payload['sourceMemberDeclarations'] = self.source_member_declarations.to_dict()
        return payload

    @classmethod
    def from_dict(cls, payload: dict[str, object]) -> ModuleIndex:
        raw_symbol_definitions = payload.get('symbolDefinitions') or {}
        raw_import_bindings = payload.get('importBindings') or []
        raw_model_candidates = payload.get('modelCandidates') or []
        raw_pending_fields = payload.get('pendingFields') or []
        raw_explicit_all = payload.get('explicitAll')
        raw_field_aliases = payload.get('fieldAliases') or {}

        if not isinstance(raw_symbol_definitions, dict):
            raise ValueError('Invalid static index cache payload: symbolDefinitions.')
        if not isinstance(raw_field_aliases, dict):
            raise ValueError('Invalid static index cache payload: fieldAliases.')

        return cls(
            module_name=str(payload['moduleName']),
            file_path=str(payload['filePath']),
            is_package_init=bool(payload['isPackageInit']),
            defined_symbols={str(symbol) for symbol in payload.get('definedSymbols', [])},
            symbol_definitions={
                str(symbol): DefinitionLocation.from_dict(dict(location))
                for symbol, location in raw_symbol_definitions.items()
                if isinstance(location, dict)
            },
            import_bindings=[
                ImportBinding.from_dict(dict(binding))
                for binding in raw_import_bindings
                if isinstance(binding, dict)
            ],
            explicit_all=[
                str(symbol)
                for symbol in raw_explicit_all
            ]
            if isinstance(raw_explicit_all, list)
            else None,
            model_candidates=[
                ModelCandidate.from_dict(dict(candidate))
                for candidate in raw_model_candidates
                if isinstance(candidate, dict)
            ],
            pending_fields=[
                PendingFieldCandidate.from_dict(dict(field))
                for field in raw_pending_fields
                if isinstance(field, dict)
            ],
            class_base_refs={
                str(k): tuple(str(v) for v in vs)
                for k, vs in (payload.get('classBaseRefs') or {}).items()
                if isinstance(vs, list)
            },
            field_class_names=tuple(
                str(name) for name in payload.get('fieldClassNames', [])
            ),
            field_aliases={
                str(alias): str(kind)
                for alias, kind in raw_field_aliases.items()
            },
            constructor_imports=tuple(str(value) for value in payload.get('constructorImports', [])),
            source_member_declarations=SourceMemberDeclarations.from_dict(payload.get('sourceMemberDeclarations')),
        )


@dataclass(frozen=True)
class ExportResolution:
    requested_module: str
    symbol: str
    resolved: bool
    origin_module: str | None
    origin_symbol: str | None
    origin_file_path: str | None
    origin_line: int | None
    origin_column: int | None
    via_modules: list[str]
    resolution_kind: str

    def to_dict(self) -> dict[str, object]:
        return {
            'requestedModule': self.requested_module,
            'symbol': self.symbol,
            'resolved': self.resolved,
            'originModule': self.origin_module,
            'originSymbol': self.origin_symbol,
            'originFilePath': self.origin_file_path,
            'originLine': self.origin_line,
            'originColumn': self.origin_column,
            'viaModules': list(self.via_modules),
            'resolutionKind': self.resolution_kind,
        }


@dataclass(frozen=True)
class ModuleResolution:
    requested_module: str
    resolved: bool
    file_path: str | None
    line: int | None
    column: int | None

    def to_dict(self) -> dict[str, object]:
        return {
            'requestedModule': self.requested_module,
            'resolved': self.resolved,
            'filePath': self.file_path,
            'line': self.line,
            'column': self.column,
        }


@dataclass
class _ImportDependencyCache:
    dependents: dict[str, frozenset[str]] | None = None


@dataclass
class _InheritanceCache:
    bases: dict[str, tuple[str, ...]] = dataclasses.field(default_factory=dict)
    children: dict[str, frozenset[str]] | None = None


@dataclass
class StaticIndex:
    python_file_count: int
    package_init_count: int
    reexport_module_count: int
    star_import_count: int
    explicit_all_count: int
    modules: dict[str, ModuleIndex]
    model_candidates: list[ModelCandidate]
    # Files visited by the source snapshot whose AST parse failed. Tracked
    # explicitly so the cache can preserve the "we tried, it didn't parse"
    # state — silently dropping these from `modules` causes the full cache
    # to look complete (`rootTreeFingerprint` matches the snapshot) while
    # missing models from those files forever, which is what manifested as
    # "db.Company not in surfaceIndex" in #captain. Maps relative path →
    # short error kind (e.g. "SyntaxError").
    unparseable_files: dict[str, str] = dataclasses.field(default_factory=dict)
    # Source files whose `module_name` collides with another file that won
    # the slot (`pkg/mod.py` is shadowed by `pkg/mod/__init__.py` per
    # Python import semantics). These parsed fine but their ModuleIndex is
    # discarded by `_should_replace_module_index`. Tracked separately so
    # the invariant `python_file_count == len(modules) + len(unparseable_files)
    # + len(shadowed_files)` can be verified at cache load.
    shadowed_files: dict[str, str] = dataclasses.field(default_factory=dict)

    _cached_fields: dataclasses.InitVar[list[FieldCandidate] | None] = dataclasses.field(default=None, kw_only=True)
    _cached_direct_fields: dataclasses.InitVar[dict[str, list[FieldCandidate]] | None] = dataclasses.field(default=None, kw_only=True)
    _cached_index: dataclasses.InitVar[StaticIndex | None] = dataclasses.field(default=None, kw_only=True)
    _scalar_add_module: dataclasses.InitVar[str | frozenset[str] | None] = dataclasses.field(default=None, kw_only=True)
    _scalar_field_source: dataclasses.InitVar[StaticIndex | None] = dataclasses.field(default=None, kw_only=True)
    _constructor_files: dataclasses.InitVar[dict[str, tuple[str, bool]] | None] = dataclasses.field(default=None, kw_only=True)

    def __post_init__(self, _cached_fields: list[FieldCandidate] | None, _cached_direct_fields: dict[str, list[FieldCandidate]] | None, _cached_index: StaticIndex | None, _scalar_add_module: str | frozenset[str] | None, _scalar_field_source: StaticIndex | None, _constructor_files: dict[str, tuple[str, bool]] | None) -> None:
        field_map_source = _cached_index or _scalar_field_source
        self._workspace_source_paths: frozenset[str] | None = None
        self._workspace_source_paths_by_module: dict[str, str] | None = None
        self._workspace_source_path_counts: dict[str, int] | None = None
        self._runtime_member_snapshot = None
        self._runtime_source_epoch = None
        self._reindexed_source_fingerprint = None
        self._import_dependency_cache = _ImportDependencyCache()
        self._inheritance_cache = _InheritanceCache()
        self._runtime_graph_map_cache: object | None = None
        self._changed_field_labels: frozenset[str] | None = None
        self._scalar_fields_by_model_label: dict[str, list[FieldCandidate]] | None = None
        self._scalar_field_source = _scalar_field_source
        self._module_export_cache: dict[str, dict[str, ExportResolution]] = {}
        # captain 옵션 6+ — resolve_export_origin 의 top-level (module, symbol)
        # 캐시. 같은 (mod, sym) 페어가 receiver tracer chain 안에서 반복 호출
        # 되는데 매번 _resolve_module_exports + _resolve_direct_module_attribute
        # 두 단계 수행. 캡틴 측정: 56건/7480ms (1건 134ms 평균). 페어 캐시로
        # cache hit 은 dict lookup 비용 (수십 ns) 로 단축.
        self._export_origin_cache: dict[tuple[str, str], ExportResolution] = {}
        self._field_class_cache: dict[tuple[str, str], bool] = {}
        # 0: not a field, 1: resolved through other modules, 2: local metadata.
        # Only local metadata is stable when model coverage elsewhere changes.
        self._field_reference_cache: dict[tuple[str, str], int] = {}
        self._constructor_import_cache: dict[str, tuple[tuple[str, str], ...]] = {}
        self._constructor_module_files = _constructor_files
        self._constructor_dependency_cache = None
        if _cached_index is not None and self.model_candidates == _cached_index.model_candidates:
            # Candidate lookup maps are read-only and candidates are frozen.
            # Reusing them avoids thousands of GC-tracked tuples/lists per edit.
            for name in ('_concrete_model_candidates', '_model_candidates_by_label',
                         '_model_candidates_by_module_and_name', '_model_candidates_by_app_and_name',
                         '_model_candidates_by_name', '_model_labels_by_module'):
                setattr(self, name, getattr(_cached_index, name))
            self._inheritance_cache = _cached_index._inheritance_cache
            self._runtime_graph_map_cache = _cached_index._runtime_graph_map_cache
        else:
            self._concrete_model_candidates = [candidate for candidate in self.model_candidates if not candidate.is_abstract]
            self._model_candidates_by_label = {candidate.label: candidate for candidate in self.model_candidates}
            self._model_candidates_by_module_and_name = {
                (candidate.module, candidate.object_name): candidate for candidate in self.model_candidates
            }
            self._model_candidates_by_app_and_name: dict[tuple[str, str], list[ModelCandidate]] = {}
            self._model_candidates_by_name: dict[str, list[ModelCandidate]] = {}
            labels_by_module: dict[str, set[str]] = {}
            for candidate in self.model_candidates:
                self._model_candidates_by_app_and_name.setdefault((candidate.app_label, candidate.object_name), []).append(candidate)
                self._model_candidates_by_name.setdefault(candidate.object_name, []).append(candidate)
                labels_by_module.setdefault(candidate.module, set()).add(candidate.label)
            self._model_labels_by_module = {name: frozenset(labels) for name, labels in labels_by_module.items()}
        # Reuse immutable results only when import/model resolution is unchanged.
        self._direct_fields_by_module = dict(_cached_direct_fields or {})
        self._independent_field_modules = (
            _cached_index._independent_field_modules.intersection(self._direct_fields_by_module)
            if _cached_index is not None else set())
        self.fields: list[FieldCandidate] = list(_cached_fields) if _cached_fields is not None else self._resolve_fields(_cached_index, _scalar_add_module)
        if _cached_fields is not None:
            if _cached_index is not None:
                self._forward_field_groups = _cached_index._forward_field_groups
                self._reverse_fields = _cached_index._reverse_fields
            else:
                self._set_field_partitions(
                    [field for field in self.fields if field.relation_direction != 'reverse'],
                    [field for field in self.fields if field.relation_direction == 'reverse'])
        # The old index is needed only during construction, never retained by
        # the new index or its caches after the edit commits.
        self._scalar_field_source = None
        if _cached_index is not None and _cached_fields is not None:
            # These maps are private and read-only after construction. Sharing
            # them avoids allocating a tuple for every field on a helper edit.
            self._fields_by_model_label = _cached_index._fields_by_model_label
            self._fields_by_model_and_name = _cached_index._fields_by_model_and_name
            self._relation_sources_by_target = _cached_index._relation_sources_by_target
            self._changed_field_labels = frozenset()
            return
        if _cached_index is not None and self._scalar_fields_by_model_label is not None:
            # The scalar shortcut has already proved that inheritance and
            # relations are unchanged. Keep unrelated field groups intact
            # instead of grouping and comparing every field in the workspace.
            self._fields_by_model_label = dict(_cached_index._fields_by_model_label)
            self._fields_by_model_and_name = dict(_cached_index._fields_by_model_and_name)
            self._relation_sources_by_target = _cached_index._relation_sources_by_target
            changed_labels = set()
            for label, fields in self._scalar_fields_by_model_label.items():
                previous = _cached_index._fields_by_model_label.get(label, [])
                if fields == previous:
                    continue
                changed_labels.add(label)
                if fields:
                    self._fields_by_model_label[label] = fields
                else:
                    self._fields_by_model_label.pop(label, None)
                for field in previous:
                    self._fields_by_model_and_name.pop((label, field.name), None)
                for field in fields:
                    self._fields_by_model_and_name[(label, field.name)] = field
            self._scalar_fields_by_model_label = None
            self._changed_field_labels = frozenset(changed_labels)
            return
        if _cached_fields is not None:
            # Preserve the supplied cache payload's exact per-model ordering.
            self._fields_by_model_label: dict[str, list[FieldCandidate]] = {}
            for field in self.fields:
                self._fields_by_model_label.setdefault(field.model_label, []).append(field)
        else:
            # General resolution has already partitioned the forward fields.
            # Copy each group in C rather than regrouping every scalar field.
            self._fields_by_model_label = {
                label: list(fields) for label, fields in self._forward_field_groups.items()}
            for field in self._reverse_fields:
                self._fields_by_model_label.setdefault(field.model_label, []).append(field)
        if field_map_source is None:
            self._fields_by_model_and_name = {(field.model_label, field.name): field for field in self.fields}
            self._relation_sources_by_target: dict[str, set[str]] = {}
            for label, fields in self._fields_by_model_label.items():
                candidate = self._model_candidates_by_label.get(label)
                if candidate is None or candidate.is_abstract:
                    continue
                for field in fields:
                    if field.is_relation and field.related_model_label:
                        self._relation_sources_by_target.setdefault(field.related_model_label, set()).add(label)
        else:
            self._fields_by_model_and_name = dict(field_map_source._fields_by_model_and_name)
            self._relation_sources_by_target = dict(field_map_source._relation_sources_by_target)
            removed_labels = field_map_source._fields_by_model_label.keys() - self._fields_by_model_label.keys()
            changed_labels = set(removed_labels)
            relation_changed_labels = set(removed_labels)
            for label in removed_labels:
                for field in field_map_source._fields_by_model_label[label]:
                    self._fields_by_model_and_name.pop((label, field.name), None)
            for label, fields in self._fields_by_model_label.items():
                previous = field_map_source._fields_by_model_label.get(label, [])
                old_candidate = field_map_source._model_candidates_by_label.get(label)
                new_candidate = self._model_candidates_by_label.get(label)
                if bool(old_candidate and not old_candidate.is_abstract) != bool(new_candidate and not new_candidate.is_abstract):
                    relation_changed_labels.add(label)
                if fields == previous:
                    self._fields_by_model_label[label] = previous
                    continue
                changed_labels.add(label)
                relation_changed_labels.add(label)
                for field in previous:
                    self._fields_by_model_and_name.pop((label, field.name), None)
                for field in fields:
                    self._fields_by_model_and_name[(label, field.name)] = field
            for label in relation_changed_labels:
                old_targets = {f.related_model_label for f in field_map_source._fields_by_model_label.get(label, [])
                               if f.is_relation and f.related_model_label}
                candidate = self._model_candidates_by_label.get(label)
                new_targets = {f.related_model_label for f in self._fields_by_model_label.get(label, [])
                               if f.is_relation and f.related_model_label} if candidate and not candidate.is_abstract else set()
                for target in old_targets | new_targets:
                    sources = set(self._relation_sources_by_target.get(target, ()))
                    sources.discard(label)
                    if target in new_targets:
                        sources.add(label)
                    if sources:
                        self._relation_sources_by_target[target] = sources
                    else:
                        self._relation_sources_by_target.pop(target, None)
            self._changed_field_labels = frozenset(changed_labels)

    @property
    def model_candidate_count(self) -> int:
        return len(self._concrete_model_candidates)

    @property
    def concrete_model_candidates(self) -> list[ModelCandidate]:
        return list(self._concrete_model_candidates)

    def to_dict(self) -> dict[str, int]:
        return {
            'pythonFileCount': self.python_file_count,
            'packageInitCount': self.package_init_count,
            'reexportModuleCount': self.reexport_module_count,
            'starImportCount': self.star_import_count,
            'explicitAllCount': self.explicit_all_count,
            'modelCandidateCount': self.model_candidate_count,
        }

    def to_cache_dict(self) -> dict[str, object]:
        return {
            'pythonFileCount': self.python_file_count,
            'packageInitCount': self.package_init_count,
            'reexportModuleCount': self.reexport_module_count,
            'starImportCount': self.star_import_count,
            'explicitAllCount': self.explicit_all_count,
            'modules': {
                module_name: module.to_dict()
                for module_name, module in self.modules.items()
            },
            'modelCandidates': [
                candidate.to_dict() for candidate in self.model_candidates
            ],
            'unparseableFiles': dict(self.unparseable_files),
            'shadowedFiles': dict(self.shadowed_files),
        }

    @classmethod
    def from_cache_dict(cls, payload: dict[str, object], *, _restored_modules: bool = False,
                        _module_row_loader=None) -> StaticIndex:
        module_rows = _module_row_loader is not None and 'moduleRows' in payload
        raw_modules = payload.get('moduleRows' if module_rows else 'modules') or {}
        raw_model_candidates = payload.get('modelCandidates') or []
        raw_unparseable = payload.get('unparseableFiles') or {}
        raw_shadowed = payload.get('shadowedFiles') or {}

        if not isinstance(raw_modules, dict):
            raise ValueError('Invalid static index cache payload: modules.')
        if not isinstance(raw_unparseable, dict):
            raise ValueError('Invalid static index cache payload: unparseableFiles.')
        if not isinstance(raw_shadowed, dict):
            raise ValueError('Invalid static index cache payload: shadowedFiles.')

        return cls(
            python_file_count=int(payload['pythonFileCount']),
            package_init_count=int(payload['packageInitCount']),
            reexport_module_count=int(payload['reexportModuleCount']),
            star_import_count=int(payload['starImportCount']),
            explicit_all_count=int(payload['explicitAllCount']),
            # Keep row hydration here, after root validation and all count
            # coercions, so malformed caches retain dictionary error ordering.
            modules={
                str(module_name): (module_payload
                                  if _restored_modules and type(module_payload) is ModuleIndex
                                  else _module_row_loader(module_payload)
                                  if module_rows and isinstance(module_payload, list)
                                  else ModuleIndex.from_dict(dict(module_payload)))
                for module_name, module_payload in raw_modules.items()
                if isinstance(module_payload, dict)
                or (_restored_modules and type(module_payload) is ModuleIndex)
                or (module_rows and isinstance(module_payload, list))
            },
            model_candidates=[
                ModelCandidate.from_dict(dict(candidate))
                for candidate in raw_model_candidates
                if isinstance(candidate, dict)
            ],
            unparseable_files={
                str(rel): str(kind) for rel, kind in raw_unparseable.items()
            },
            shadowed_files={
                str(rel): str(winner) for rel, winner in raw_shadowed.items()
            },
        )

    def _module_for_import_name(self, module_name: str) -> ModuleIndex | None:
        module = self.modules.get(module_name)
        if module is not None:
            return module
        roots = getattr(self, '_source_import_roots', ())
        parts = module_name.split('.')
        if not roots or any(not part or '/' in part or '\\' in part for part in parts):
            return None
        # A physical source is indexed once, but overlapping declared roots
        # can give it multiple import names. Probe only already indexed source
        # paths; never read or import another file, or duplicate model records.
        paths = tuple(Path(root) for root in roots)
        for import_root in paths:
            base = import_root.joinpath(*parts)
            for source in (base / '__init__.py', base.with_suffix('.py')):
                for indexed_root in paths:
                    try:
                        relative = source.relative_to(indexed_root)
                    except ValueError:
                        continue
                    names = (relative.parent.parts if source.name == '__init__.py'
                        else relative.with_suffix('').parts)
                    indexed = self.modules.get('.'.join(names))
                    if indexed is not None and indexed.file_path == str(source):
                        return indexed
        return None

    def resolve_export_origin(
        self,
        module_name: str,
        symbol: str,
    ) -> ExportResolution:
        # captain 옵션 6+ — (module, symbol) 페어 캐시. cache hit 은 dict
        # lookup 비용. miss 시 builds + measures + emits slow log if >threshold.
        key = (module_name, symbol)
        cached = self._export_origin_cache.get(key)
        if cached is not None:
            return cached

        import time as _time
        import os as _os
        import sys as _sys
        _slow_threshold_ms = int(
            _os.environ.get('DJLS_EXPORT_ORIGIN_SLOW_LOG_MS', '50') or '50'
        )
        _started = _time.perf_counter()

        result = self._resolve_export_origin_uncached(module_name, symbol)
        self._export_origin_cache[key] = result

        elapsed_ms = (_time.perf_counter() - _started) * 1000
        if _slow_threshold_ms > 0 and elapsed_ms >= _slow_threshold_ms:
            print(
                f'[export-origin:slow] module={module_name} symbol={symbol} '
                f'elapsed={elapsed_ms:.0f}ms via={len(result.via_modules)} '
                f'resolved={result.resolved} kind={result.resolution_kind}',
                file=_sys.stderr, flush=True,
            )
        return result

    def _resolve_export_origin_uncached(
        self,
        module_name: str,
        symbol: str,
    ) -> ExportResolution:
        exports = self._resolve_module_exports(module_name, stack=())
        if symbol in exports:
            return exports[symbol]

        direct_resolution = self._resolve_direct_module_attribute(
            module_name,
            symbol,
            stack=(),
        )
        if direct_resolution is not None:
            return direct_resolution

        return ExportResolution(
            requested_module=module_name,
            symbol=symbol,
            resolved=False,
            origin_module=None,
            origin_symbol=None,
            origin_file_path=None,
            origin_line=None,
            origin_column=None,
            via_modules=[module_name],
            resolution_kind='unresolved',
        )

    def _resolve_direct_module_attribute(
        self,
        module_name: str,
        symbol: str,
        stack: tuple[tuple[str, str], ...],
    ) -> ExportResolution | None:
        key = (module_name, symbol)
        if key in stack:
            return None

        module = self._module_for_import_name(module_name)
        if module is None:
            return None

        location = module.symbol_definitions.get(symbol)
        if symbol in module.defined_symbols:
            return ExportResolution(
                requested_module=module_name,
                symbol=symbol,
                resolved=True,
                origin_module=module_name,
                origin_symbol=symbol,
                origin_file_path=location.file_path if location else module.file_path,
                origin_line=location.line if location else 1,
                origin_column=location.column if location else 1,
                via_modules=[module_name],
                resolution_kind='direct_defined',
            )

        next_stack = stack + (key,)
        for binding in module.import_bindings:
            if binding.is_star:
                star_exports = self._resolve_module_exports(binding.module, stack=())
                nested_resolution = star_exports.get(symbol)
                if nested_resolution is not None and nested_resolution.resolved:
                    return _prepend_module(
                        nested_resolution,
                        requested_module=module_name,
                        module_name=module_name,
                        resolution_kind='direct_star_import',
                        symbol=symbol,
                    )
                continue

            if binding.alias != symbol:
                continue

            if binding.symbol is None:
                location = self.locate_symbol(binding.module, None)
                return ExportResolution(
                    requested_module=module_name,
                    symbol=symbol,
                    resolved=True,
                    origin_module=binding.module,
                    origin_symbol=None,
                    origin_file_path=location.file_path if location else None,
                    origin_line=location.line if location else None,
                    origin_column=location.column if location else None,
                    via_modules=[module_name, binding.module],
                    resolution_kind='direct_module_import',
                )

            nested_resolution = self._resolve_direct_module_attribute(
                binding.module,
                binding.symbol,
                next_stack,
            )
            if nested_resolution is not None and nested_resolution.resolved:
                return _prepend_module(
                    nested_resolution,
                    requested_module=module_name,
                    module_name=module_name,
                    resolution_kind='direct_imported',
                    symbol=symbol,
                )

            location = self.locate_symbol(binding.module, binding.symbol)
            if location is not None:
                return ExportResolution(
                    requested_module=module_name,
                    symbol=symbol,
                    resolved=True,
                    origin_module=binding.module,
                    origin_symbol=binding.symbol,
                    origin_file_path=location.file_path,
                    origin_line=location.line,
                    origin_column=location.column,
                    via_modules=[module_name, binding.module],
                    resolution_kind='direct_imported_fallback',
                )

        return None

    def resolve_module(self, module_name: str) -> ModuleResolution:
        location = self.locate_symbol(module_name, None)
        return ModuleResolution(
            requested_module=module_name,
            resolved=location is not None,
            file_path=location.file_path if location else None,
            line=location.line if location else None,
            column=location.column if location else None,
        )

    def locate_symbol(
        self,
        module_name: str,
        symbol: str | None,
    ) -> DefinitionLocation | None:
        module = self._module_for_import_name(module_name)
        if module is None:
            return None

        if symbol is None:
            return DefinitionLocation(
                file_path=module.file_path,
                line=1,
                column=1,
            )

        return module.symbol_definitions.get(symbol)

    def find_model_candidate(self, label: str) -> ModelCandidate | None:
        return self._model_candidates_by_label.get(label)

    def find_model_candidate_by_module_and_name(
        self,
        module_name: str,
        object_name: str,
    ) -> ModelCandidate | None:
        return self._model_candidates_by_module_and_name.get((module_name, object_name))

    def resolve_model_label_reference(
        self,
        *,
        module_name: str,
        app_label: str,
        reference: str,
    ) -> str | None:
        return self._resolve_model_base_label(
            module_name=module_name,
            app_label=app_label,
            base_ref=reference,
        )

    def fields_for_model(self, model_label: str) -> list[FieldCandidate]:
        return list(self._fields_by_model_label.get(model_label, []))

    def find_field(self, model_label: str, field_name: str) -> FieldCandidate | None:
        return self._fields_by_model_and_name.get((model_label, field_name))

    def primary_key_option_fields(self) -> frozenset[tuple[str, str]]:
        """Limit source option reads to declarations that may specify a key."""
        options = getattr(self, '_primary_key_option_fields', None)
        if options is None:
            options = frozenset((field.model_label, field.name)
                for module in self.modules.values() for field in module.pending_fields
                if field.has_primary_key_option)
            self._primary_key_option_fields = options
        return options

    def _resolve_module_exports(
        self,
        module_name: str,
        stack: tuple[str, ...],
    ) -> dict[str, ExportResolution]:
        cached = self._module_export_cache.get(module_name)
        if cached is not None:
            return cached

        if module_name in stack:
            return {}

        module = self._module_for_import_name(module_name)
        if module is None:
            return {}

        exports: dict[str, ExportResolution] = {}
        next_stack = stack + (module_name,)

        for symbol in module.defined_symbols:
            location = module.symbol_definitions.get(symbol)
            exports[symbol] = ExportResolution(
                requested_module=module_name,
                symbol=symbol,
                resolved=True,
                origin_module=module_name,
                origin_symbol=symbol,
                origin_file_path=location.file_path if location else module.file_path,
                origin_line=location.line if location else 1,
                origin_column=location.column if location else 1,
                via_modules=[module_name],
                resolution_kind='defined',
            )

        for binding in module.import_bindings:
            if binding.is_star:
                star_exports = self._resolve_module_exports(binding.module, next_stack)
                for export_name, export_resolution in star_exports.items():
                    if export_name.startswith('_'):
                        continue

                    exports.setdefault(
                        export_name,
                        _prepend_module(
                            export_resolution,
                            requested_module=module_name,
                            module_name=module_name,
                            resolution_kind='star_import',
                        ),
                    )
                continue

            if binding.symbol is None:
                location = self.locate_symbol(binding.module, None)
                exports[binding.alias] = ExportResolution(
                    requested_module=module_name,
                    symbol=binding.alias,
                    resolved=True,
                    origin_module=binding.module,
                    origin_symbol=None,
                    origin_file_path=location.file_path if location else None,
                    origin_line=location.line if location else None,
                    origin_column=location.column if location else None,
                    via_modules=[module_name, binding.module],
                    resolution_kind='module_import',
                )
                continue

            nested_exports = self._resolve_module_exports(binding.module, next_stack)
            nested_resolution = nested_exports.get(binding.symbol)
            if nested_resolution is not None and nested_resolution.resolved:
                exports[binding.alias] = _prepend_module(
                    nested_resolution,
                    requested_module=module_name,
                    module_name=module_name,
                    resolution_kind='imported',
                    symbol=binding.alias,
                )
            else:
                location = self.locate_symbol(binding.module, binding.symbol)
                exports[binding.alias] = ExportResolution(
                    requested_module=module_name,
                    symbol=binding.alias,
                    resolved=True,
                    origin_module=binding.module,
                    origin_symbol=binding.symbol,
                    origin_file_path=location.file_path if location else None,
                    origin_line=location.line if location else None,
                    origin_column=location.column if location else None,
                    via_modules=[module_name, binding.module],
                    resolution_kind='imported_fallback',
                )

        if module.explicit_all is not None:
            exports = {
                name: exports[name]
                for name in module.explicit_all
                if name in exports
            }
        else:
            exports = {
                name: resolution
                for name, resolution in exports.items()
                if not name.startswith('_')
            }

        self._module_export_cache[module_name] = exports
        return exports

    def _resolve_fields(self, cached_index: StaticIndex | None = None, scalar_add_module: str | frozenset[str] | None = None) -> list[FieldCandidate]:
        if cached_index is not None and scalar_add_module is not None:
            module_names = (scalar_add_module,) if isinstance(scalar_add_module, str) else scalar_add_module
            modules = [self.modules[name] for name in module_names]
            labels = {candidate.label for module in modules for candidate in module.model_candidates}
            # Adding/changing a scalar on a standalone model cannot change other
            # forward field or reverse relation. Inheritance always uses the
            # general resolver so descendants and collision rules stay intact.
            has_inheritance = any(
                (candidate.label in labels and (candidate.is_abstract or cached_index._resolve_model_base_labels(candidate)))
                or any(base in labels for base in cached_index._resolve_model_base_labels(candidate))
                for candidate in cached_index.model_candidates
            )
            old_relation_names = {f.name for label in labels for f in cached_index.fields_for_model(label) if f.is_relation}
            added_names = {pending.name for module in modules for pending in module.pending_fields
                           if (old := cached_index.find_field(pending.model_label, pending.name)) is None
                           or (old.is_relation and not pending.is_relation)}
            unique_labels = len(self.model_candidates) == len(self._model_candidates_by_label)
            if unique_labels and not has_inheritance and not (old_relation_names & added_names):
                direct = [field for module in modules for field in self._resolve_direct_module_fields(module)]
                if not isinstance(scalar_add_module, str):
                    # Helper edits can change fields indirectly. Verify the
                    # actual resolved relation/PK fields before reusing reverse
                    # partitions; syntax alone cannot prove a custom field safe.
                    before = {(field.model_label, field.name): field
                              for label in labels for field in cached_index._forward_field_groups.get(label, ())}
                    after = {(field.model_label, field.name): field for field in direct}
                    changed = before.keys() ^ after.keys() | {
                        key for key in before.keys() & after.keys() if before[key] != after[key]}
                    if any((field := after.get(key) or before.get(key)).is_relation
                           or field.name in {'id', 'pk'} for key in changed):
                        direct = None
                if direct is None:
                    # Direct caches are already refreshed and remain valid
                    # for the general inheritance/reverse resolver below.
                    return self._resolve_fields(cached_index)
                own = {label: [] for label in labels}
                for field in direct:
                    if field.model_label in own:
                        own[field.model_label].append(field)
                forward = []
                changed_fields_by_label = {label: [] for label in labels}
                for candidate in self.model_candidates:
                    if candidate.label in labels:
                        forward.extend(own[candidate.label])
                        changed_fields_by_label[candidate.label].extend(own[candidate.label])
                    else:
                        forward.extend(cached_index._forward_field_groups.get(candidate.label, ()))
                self._forward_field_groups = dict(cached_index._forward_field_groups)
                for label, fields in changed_fields_by_label.items():
                    if fields:
                        self._forward_field_groups[label] = tuple(fields)
                    else:
                        self._forward_field_groups.pop(label, None)
                    fields.extend(f for f in cached_index.fields_for_model(label)
                                  if f.relation_direction == 'reverse')
                self._reverse_fields = cached_index._reverse_fields
                self._scalar_fields_by_model_label = changed_fields_by_label
                forward.extend(self._reverse_fields)
                return forward

        expanded_forward_fields = expanded_reverse_fields = None
        try:
            direct_fields_by_model: dict[str, list[FieldCandidate]] = {}
            for module in self.modules.values():
                if not module.pending_fields:
                    continue
                for field in self._resolve_direct_module_fields(module):
                    direct_fields_by_model.setdefault(field.model_label, []).append(field)

            inherited_forward_cache: dict[str, list[FieldCandidate]] = {}

            def expanded_forward_fields(
                model_label: str,
                stack: tuple[str, ...] = (),
            ) -> list[FieldCandidate]:
                cached = inherited_forward_cache.get(model_label)
                if cached is not None:
                    return cached

                if model_label in stack:
                    return []

                candidate = self._model_candidates_by_label.get(model_label)
                direct_fields = direct_fields_by_model.get(model_label, [])
                base_labels = self._resolve_model_base_labels(candidate) if candidate is not None else []
                if not base_labels:
                    inherited_forward_cache[model_label] = direct_fields
                    return direct_fields
                direct_names = {field.name for field in direct_fields}
                inherited_fields: list[FieldCandidate] = []
                inherited_names: set[str] = set()

                if candidate is not None:
                    for base_model_label in base_labels:
                        for base_field in expanded_forward_fields(
                            base_model_label,
                            stack + (model_label,),
                        ):
                            if (
                                base_field.name in direct_names
                                or base_field.name in inherited_names
                            ):
                                continue

                            inherited_names.add(base_field.name)
                            inherited_fields.append(
                                _clone_field_for_model(base_field, model_label)
                            )

                resolved_fields = direct_fields + inherited_fields
                inherited_forward_cache[model_label] = resolved_fields
                return resolved_fields

            forward_fields: list[FieldCandidate] = []
            for candidate in self.model_candidates:
                forward_fields.extend(expanded_forward_fields(candidate.label))

            direct_reverse_fields: list[FieldCandidate] = []
            reverse_keys: set[tuple[str, str, str]] = set()
            for candidate in self._concrete_model_candidates:
                for field in expanded_forward_fields(candidate.label):
                    if not field.is_relation or field.related_model_label is None:
                        continue

                    reverse_related_model_label = _preferred_reverse_related_model_label(
                        self,
                        source_model_label=candidate.label,
                        declared_model_label=field.declared_model_label,
                    )
                    reverse_name = field.related_name or _default_reverse_name(
                        field.field_kind,
                        reverse_related_model_label,
                    )
                    if _is_hidden_related_name(reverse_name):
                        continue

                    reverse_query_name = _reverse_query_name(
                        field=field,
                        source_model_label=reverse_related_model_label,
                    )
                    reverse_key = (
                        field.related_model_label,
                        reverse_name,
                        reverse_related_model_label,
                    )
                    if reverse_key in reverse_keys:
                        continue

                    reverse_keys.add(reverse_key)
                    previous_reverse = (self._scalar_field_source.find_field(field.related_model_label, reverse_name)
                        if self._scalar_field_source is not None else None)
                    if (previous_reverse is not None
                            and previous_reverse.file_path == field.file_path
                            and previous_reverse.line == field.line and previous_reverse.column == field.column
                            and previous_reverse.field_kind == f'reverse_{field.field_kind}'
                            and previous_reverse.is_relation and previous_reverse.relation_direction == 'reverse'
                            and previous_reverse.related_model_label == reverse_related_model_label
                            and previous_reverse.declared_model_label == field.declared_model_label
                            and previous_reverse.related_name == field.related_name
                            and previous_reverse.related_query_name == reverse_query_name
                            and previous_reverse.source == 'static'
                            and previous_reverse.constructor_fingerprint is None):
                        direct_reverse_fields.append(previous_reverse)
                    else:
                        direct_reverse_fields.append(FieldCandidate(
                            model_label=field.related_model_label,
                            name=reverse_name,
                            file_path=field.file_path,
                            line=field.line,
                            column=field.column,
                            field_kind=f'reverse_{field.field_kind}',
                            is_relation=True,
                            relation_direction='reverse',
                            related_model_label=reverse_related_model_label,
                            declared_model_label=field.declared_model_label,
                            related_name=field.related_name,
                            related_query_name=reverse_query_name,
                        ))

            direct_reverse_fields_by_model: dict[str, list[FieldCandidate]] = {}
            for field in direct_reverse_fields:
                direct_reverse_fields_by_model.setdefault(field.model_label, []).append(
                    field
                )

            inherited_reverse_cache: dict[str, list[FieldCandidate]] = {}

            def expanded_reverse_fields(
                model_label: str,
                stack: tuple[str, ...] = (),
            ) -> list[FieldCandidate]:
                cached = inherited_reverse_cache.get(model_label)
                if cached is not None:
                    return cached

                if model_label in stack:
                    return []

                candidate = self._model_candidates_by_label.get(model_label)
                direct_fields = direct_reverse_fields_by_model.get(model_label, [])
                base_labels = self._resolve_model_base_labels(candidate) if candidate is not None else []
                if not base_labels:
                    inherited_reverse_cache[model_label] = direct_fields
                    return direct_fields
                direct_names = {
                    field.name
                    for field in [
                        *expanded_forward_fields(model_label),
                        *direct_fields,
                    ]
                }
                inherited_fields: list[FieldCandidate] = []
                inherited_names: set[str] = set()

                if candidate is not None:
                    for base_model_label in base_labels:
                        for base_field in expanded_reverse_fields(
                            base_model_label,
                            stack + (model_label,),
                        ):
                            if (
                                base_field.name in direct_names
                                or base_field.name in inherited_names
                            ):
                                continue

                            inherited_names.add(base_field.name)
                            inherited_fields.append(
                                _clone_field_for_model(base_field, model_label)
                            )

                resolved_fields = direct_fields + inherited_fields
                inherited_reverse_cache[model_label] = resolved_fields
                return resolved_fields

            reverse_fields: list[FieldCandidate] = []
            for candidate in self.model_candidates:
                reverse_fields.extend(expanded_reverse_fields(candidate.label))

            # Duplicate labels intentionally append the same expanded declaration
            # more than once. Keep the flat regrouping path for that ordering rule.
            forward_groups = ({candidate.label: inherited_forward_cache[candidate.label]
                               for candidate in self.model_candidates
                               if inherited_forward_cache[candidate.label]}
                              if len(self.model_candidates) == len(self._model_candidates_by_label)
                              else None)
            self._set_field_partitions(forward_fields, reverse_fields, forward_groups=forward_groups)
            forward_fields.extend(reverse_fields)
            return forward_fields
        finally:
            # Both recursive closures capture this index. A completed build
            # must not keep a replaced workspace snapshot alive until cyclic GC.
            expanded_forward_fields = expanded_reverse_fields = None

    def _set_field_partitions(self, forward: list[FieldCandidate], reverse: list[FieldCandidate],
                              *, forward_groups: dict[str, list[FieldCandidate]] | None = None) -> None:
        groups = forward_groups
        if groups is None:
            groups = {}
            for field in forward:
                groups.setdefault(field.model_label, []).append(field)
        source = self._scalar_field_source
        previous_groups = source._forward_field_groups if source is not None else {}
        self._forward_field_groups = {}
        for label, fields in groups.items():
            values = tuple(fields)
            previous = previous_groups.get(label)
            self._forward_field_groups[label] = previous if previous == values else values
        values = tuple(reverse)
        self._reverse_fields = source._reverse_fields if source is not None and source._reverse_fields == values else values

    def _resolve_direct_module_fields(self, module: ModuleIndex) -> list[FieldCandidate]:
        cached = self._direct_fields_by_module.get(module.module_name)
        if cached is not None:
            return cached
        self._independent_field_modules.discard(module.module_name)
        reusable: dict[tuple[str, str], tuple[PendingFieldCandidate, FieldCandidate]] = {}
        source = self._scalar_field_source
        previous = source.modules.get(module.module_name) if source is not None else None
        if module is previous:
            previous_fields = source._direct_fields_by_module.get(module.module_name)
            if previous_fields is not None and module.module_name in source._independent_field_modules:
                # The source index already proved every declaration local and
                # every relation target literal/self. The module object is
                # unchanged, so model coverage cannot invalidate that proof.
                self._direct_fields_by_module[module.module_name] = previous_fields
                self._independent_field_modules.add(module.module_name)
                return previous_fields
            local_refs: dict[str, bool] = {}
            if previous_fields is not None and len(previous_fields) == len(module.pending_fields):
                for pending, field in zip(module.pending_fields, previous_fields):
                    if pending.model_label != field.model_label or pending.name != field.name:
                        break
                    ref = pending.field_call_ref
                    if ref not in local_refs:
                        key = (module.module_name, ref)
                        local_refs[ref] = (source._field_reference_cache.get(key) == 2
                            or bool(_field_ref_kind_for_module(ref, module)))
                    if (any(not value.startswith('django.') for value in pending.constructor_imports)
                            or not local_refs[ref] or (pending.is_relation and pending.related_model_ref_kind not in {'label', 'self'})):
                        break
                else:
                    # Local field kinds and literal/self target labels do not
                    # depend on model coverage elsewhere. Inherited fields and
                    # reverse relations are still rebuilt by the general path.
                    self._direct_fields_by_module[module.module_name] = previous_fields
                    self._independent_field_modules.add(module.module_name)
                    for ref in local_refs:
                        self._field_reference_cache[(module.module_name, ref)] = 2
                    return previous_fields
        if (previous is not None
                and previous.import_bindings == module.import_bindings
                and previous.field_aliases == module.field_aliases
                and previous.field_class_names == module.field_class_names):
            old_pending = {(pending.model_label, pending.name): pending for pending in previous.pending_fields}
            for field in source._direct_fields_by_module.get(module.module_name, ()):
                key = (field.model_label, field.name)
                pending = old_pending.get(key)
                if (pending is not None and not field.is_relation
                        and not any(not value.startswith('django.') for value in pending.constructor_imports)):
                    reusable[key] = (pending, field)
        fields = []
        for pending in module.pending_fields:
            old = reusable.get((pending.model_label, pending.name))
            if (old is not None and (old[0] is pending or old[0] == pending) and not pending.is_relation
                    and _field_ref_kind_for_module(pending.field_call_ref, module)):
                # Explicit Django field imports/namespaces cannot change when
                # another model is added/removed. Symbol relations and custom
                # field references still resolve against the current index.
                fields.append(old[1])
                continue
            if not self._is_django_field_candidate(pending):
                continue
            constants = []
            import_signatures = []
            for reference in pending.constructor_imports:
                if reference.startswith('django.'):
                    continue
                cached_constants = self._constructor_import_cache.get(reference)
                if cached_constants is None:
                    if self._constructor_module_files is None:
                        self._constructor_module_files = {name: (value.file_path, value.is_package_init)
                                                          for name, value in self.modules.items()}
                    resolved = resolve_imported_constant(reference, self._constructor_module_files)
                    try:
                        if resolved is not None:
                            ast.literal_eval(resolved)
                        cached_constants = ((reference, ast.unparse(resolved)),) if resolved is not None else ()
                    except (ValueError, TypeError):
                        cached_constants = ()
                    self._constructor_import_cache[reference] = cached_constants
                constants.extend(cached_constants)
                import_signatures.append((reference, cached_constants))
            fingerprint = pending.constructor_fingerprint
            if import_signatures:
                fingerprint = hashlib.blake2s(repr((fingerprint, import_signatures)).encode(), digest_size=16).hexdigest()
            fields.append(FieldCandidate(
                model_label=pending.model_label, name=pending.name, file_path=pending.file_path,
                line=pending.line, column=pending.column, field_kind=pending.field_kind,
                is_relation=pending.is_relation, relation_direction='forward' if pending.is_relation else None,
                related_model_label=self._resolve_related_model_label(pending) if pending.is_relation else None,
                declared_model_label=pending.model_label, related_name=pending.related_name,
                related_query_name=pending.related_query_name,
                constructor_fingerprint=fingerprint,
                imported_constants=tuple(constants),
                declaration_module=module.module_name if import_signatures else None,
            ))
        self._direct_fields_by_module[module.module_name] = fields
        if len(fields) == len(module.pending_fields):
            local_refs = {}
            for pending in module.pending_fields:
                reference = pending.field_call_ref
                if reference not in local_refs:
                    local_refs[reference] = (self._field_reference_cache.get((module.module_name, reference)) == 2
                        or bool(_field_ref_kind_for_module(reference, module)))
                if (any(not value.startswith('django.') for value in pending.constructor_imports)
                        or not local_refs[reference] or (pending.is_relation and pending.related_model_ref_kind not in {'label', 'self'})):
                    break
            else:
                self._independent_field_modules.add(module.module_name)
        return fields

    def _is_django_field_candidate(
        self,
        pending: PendingFieldCandidate,
    ) -> bool:
        key = (pending.model_module, pending.field_call_ref)
        cached = self._field_reference_cache.get(key)
        if cached is not None:
            return bool(cached)
        module = self.modules.get(pending.model_module)
        if module is not None and _field_ref_kind_for_module(
            pending.field_call_ref,
            module,
        ):
            self._field_reference_cache[key] = 2
            return True

        result = self._field_ref_resolves_to_field_class(
            module_name=pending.model_module,
            field_ref=pending.field_call_ref,
            stack=(),
        )
        self._field_reference_cache[key] = int(result)
        return result

    def _field_ref_resolves_to_field_class(
        self,
        *,
        module_name: str,
        field_ref: str,
        stack: tuple[tuple[str, str], ...],
    ) -> bool:
        if not field_ref:
            return False

        field_ref = field_ref.strip()
        if '.' in field_ref:
            container_ref, class_name = field_ref.rsplit('.', 1)
            if _is_django_model_namespace_ref(
                container_ref,
                self.modules.get(module_name),
            ):
                return _is_potential_field_class_name(class_name)

            if container_ref in self.modules:
                return self._is_field_class(
                    module_name=container_ref,
                    class_name=class_name,
                    stack=stack,
                )

            resolution = self.resolve_export_origin(module_name, container_ref)
            if resolution.resolved and resolution.origin_module is not None:
                origin_module = resolution.origin_module
                if resolution.origin_symbol is None:
                    return self._is_field_class(
                        module_name=origin_module,
                        class_name=class_name,
                        stack=stack,
                    )

                nested_module_name = f'{origin_module}.{resolution.origin_symbol}'
                if nested_module_name in self.modules:
                    return self._is_field_class(
                        module_name=nested_module_name,
                        class_name=class_name,
                        stack=stack,
                    )

            return False

        return self._is_field_class(
            module_name=module_name,
            class_name=field_ref,
            stack=stack,
        )

    def _is_field_class(
        self,
        *,
        module_name: str,
        class_name: str,
        stack: tuple[tuple[str, str], ...],
    ) -> bool:
        if _is_django_model_module(module_name):
            return _is_potential_field_class_name(class_name)

        key = (module_name, class_name)
        cached = self._field_class_cache.get(key)
        if cached is not None:
            return cached

        if key in stack:
            return False

        module = self.modules.get(module_name)
        if module is None:
            return False

        if class_name in module.field_aliases or class_name in module.field_class_names:
            self._field_class_cache[key] = True
            return True

        bases = module.class_base_refs.get(class_name, ())
        if bases:
            next_stack = stack + (key,)
            for base_ref in bases:
                if self._field_ref_resolves_to_field_class(
                    module_name=module_name,
                    field_ref=base_ref,
                    stack=next_stack,
                ):
                    self._field_class_cache[key] = True
                    return True

        resolution = self.resolve_export_origin(module_name, class_name)
        if (
            resolution.resolved
            and resolution.origin_module is not None
            and resolution.origin_symbol is not None
            and (resolution.origin_module, resolution.origin_symbol) != key
        ):
            result = self._is_field_class(
                module_name=resolution.origin_module,
                class_name=resolution.origin_symbol,
                stack=stack + (key,),
            )
            self._field_class_cache[key] = result
            return result

        self._field_class_cache[key] = False
        return False

    def _resolve_model_base_labels(self, candidate: ModelCandidate) -> tuple[str, ...]:
        cached = self._inheritance_cache.bases.get(candidate.label)
        if cached is not None:
            return cached
        resolved_labels: list[str] = []
        for base_ref in candidate.base_class_refs:
            resolved_label = self._resolve_model_base_label(
                module_name=candidate.module,
                app_label=candidate.app_label,
                base_ref=base_ref,
            )
            if resolved_label is None or resolved_label in resolved_labels:
                continue
            resolved_labels.append(resolved_label)

        result = tuple(resolved_labels)
        self._inheritance_cache.bases[candidate.label] = result
        return result

    def inheritance_dependents(self, labels: set[str]) -> set[str]:
        children = self._inheritance_cache.children
        if children is None:
            by_base: dict[str, set[str]] = {}
            for candidate in self.model_candidates:
                for base in self._resolve_model_base_labels(candidate):
                    by_base.setdefault(base, set()).add(candidate.label)
            children = {base: frozenset(values) for base, values in by_base.items()}
            self._inheritance_cache.children = children
        affected = set(labels)
        pending = list(labels)
        while pending:
            for label in children.get(pending.pop(), ()):
                if label not in affected:
                    affected.add(label)
                    pending.append(label)
        return affected - labels

    def _import_dependents(self) -> dict[str, frozenset[str]]:
        dependents = self._import_dependency_cache.dependents
        if dependents is None:
            by_source: dict[str, set[str]] = {}
            for name, module in self.modules.items():
                for binding in module.import_bindings:
                    by_source.setdefault(binding.module, set()).add(name)
                    if binding.symbol:
                        by_source.setdefault(f'{binding.module}.{binding.symbol}', set()).add(name)
            dependents = {name: frozenset(values) for name, values in by_source.items()}
            self._import_dependency_cache.dependents = dependents
        return dependents

    def source_dependents(self, modules: set[str]) -> set[str]:
        dependents = self._import_dependents()
        affected = set(modules)
        pending = list(modules)
        while pending:
            for name in dependents.get(pending.pop(), ()):
                if name not in affected:
                    affected.add(name)
                    pending.append(name)
        return {label for name in affected for label in self._model_labels_by_module.get(name, ())}

    def constructor_dependents(self, changed_module: str) -> set[str]:
        cache = getattr(self, '_constructor_dependency_cache', None)
        if cache is None:
            # Both queries traverse the same explicit imports. Reuse their
            # immutable adjacency; copy only keys gaining constructor edges.
            imports = self._import_dependents()
            by_source: dict[str, set[str]] = {}
            for name, module in self.modules.items():
                for reference in module.constructor_imports:
                    origin = reference.rpartition('.')[0]
                    # Keep unresolved origins: adding their source later can
                    # reuse this adjacency and must still reach the importer.
                    by_source.setdefault(origin, set()).add(name)
            cache = dict(imports)
            for name, values in by_source.items():
                cache[name] = imports.get(name, frozenset()) | values
            self._constructor_dependency_cache = cache
        affected = {changed_module}
        pending = [changed_module]
        while pending:
            for name in cache.get(pending.pop(), ()):
                if name not in affected:
                    affected.add(name)
                    pending.append(name)
        return {name for name in affected if name != changed_module
                and name in self.modules and self.modules[name].constructor_imports}

    def _resolve_model_base_label(
        self,
        *,
        module_name: str,
        app_label: str,
        base_ref: str,
    ) -> str | None:
        if not base_ref or _is_builtin_model_base_name(base_ref):
            return None

        local_candidate = self._model_candidates_by_module_and_name.get(
            (module_name, base_ref)
        )
        if local_candidate is not None:
            return local_candidate.label

        if '.' in base_ref:
            base_parts = base_ref.split('.')
            symbol_name = base_parts[-1]
            container_name = '.'.join(base_parts[:-1])

            direct_candidate = self._model_candidates_by_module_and_name.get(
                (container_name, symbol_name)
            )
            if direct_candidate is not None:
                return direct_candidate.label

            resolution = self.resolve_export_origin(module_name, container_name)
            if resolution.resolved and resolution.origin_module is not None:
                imported_candidate = self._model_candidates_by_module_and_name.get(
                    (resolution.origin_module, symbol_name)
                )
                if imported_candidate is not None:
                    return imported_candidate.label

        resolution = self.resolve_export_origin(module_name, base_ref)
        if (
            resolution.resolved
            and resolution.origin_module is not None
            and resolution.origin_symbol is not None
        ):
            imported_candidate = self._model_candidates_by_module_and_name.get(
                (resolution.origin_module, resolution.origin_symbol)
            )
            if imported_candidate is not None:
                return imported_candidate.label

        same_app_matches = self._model_candidates_by_app_and_name.get(
            (app_label, base_ref),
            [],
        )
        if len(same_app_matches) == 1:
            return same_app_matches[0].label

        global_matches = self._model_candidates_by_name.get(base_ref, [])
        if len(global_matches) == 1:
            return global_matches[0].label

        return None

    def _resolve_related_model_label(
        self,
        pending: PendingFieldCandidate,
    ) -> str | None:
        ref_kind = pending.related_model_ref_kind
        ref_value = pending.related_model_ref_value

        if ref_kind is None or ref_value is None:
            return None

        if ref_kind == 'self':
            return pending.model_label

        if ref_kind == 'label':
            candidate = self._model_candidates_by_label.get(ref_value)
            return candidate.label if candidate else ref_value

        if ref_kind == 'same_app_name':
            matches = self._model_candidates_by_app_and_name.get(
                (pending.app_label, ref_value),
                [],
            )
            if len(matches) == 1:
                return matches[0].label
            if matches:
                return matches[0].label
            return f'{pending.app_label}.{ref_value}'

        if ref_kind == 'symbol':
            local_candidate = self._model_candidates_by_module_and_name.get(
                (pending.model_module, ref_value)
            )
            if local_candidate is not None:
                return local_candidate.label

            resolution = self.resolve_export_origin(pending.model_module, ref_value)
            if (
                resolution.resolved
                and resolution.origin_module is not None
                and resolution.origin_symbol is not None
            ):
                imported_candidate = self._model_candidates_by_module_and_name.get(
                    (resolution.origin_module, resolution.origin_symbol)
                )
                if imported_candidate is not None:
                    return imported_candidate.label

            same_app_matches = self._model_candidates_by_app_and_name.get(
                (pending.app_label, ref_value),
                [],
            )
            if len(same_app_matches) == 1:
                return same_app_matches[0].label

            global_matches = self._model_candidates_by_name.get(ref_value, [])
            if len(global_matches) == 1:
                return global_matches[0].label

        return None


def build_static_index(
    root: Path,
    python_files: list[Path] | tuple[Path, ...] | None = None,
    cached_module_indices: dict[str, ModuleIndex] | None = None,
    cached_unparseable_files: dict[str, str] | None = None,
    *,
    import_roots: tuple[str, ...] = (),
) -> StaticIndex:
    modules: dict[str, ModuleIndex] = {}
    unparseable_files: dict[str, str] = {}
    # relative_path → relative_path of the file that won the module slot.
    # Tracked so the invariant len(modules) + len(unparseable_files) +
    # len(shadowed_files) == python_file_count holds even when sibling
    # `pkg/mod.py` and `pkg/mod/__init__.py` exist (only one wins the
    # `pkg.mod` slot per Python import semantics).
    shadowed_files: dict[str, str] = {}
    # Track which relative_path is currently occupying each module_name
    # slot so we know which file becomes shadowed when a replacement wins.
    module_slot_owner: dict[str, str] = {}
    root_parts = root.parts if os.name == 'posix' else None
    source_files = list(python_files) if python_files is not None else iter_python_files(root)
    cached_modules = cached_module_indices or {}
    cached_unparseable = cached_unparseable_files or {}
    has_fresh_modules = False

    def _record_slot(module_name: str, candidate: ModuleIndex, relative_path: str) -> None:
        existing = modules.get(module_name)
        if existing is None:
            modules[module_name] = candidate
            module_slot_owner[module_name] = relative_path
            return
        if _should_replace_module_index(existing, candidate):
            previous_owner = module_slot_owner.get(module_name)
            if previous_owner is not None and previous_owner != relative_path:
                shadowed_files[previous_owner] = relative_path
            modules[module_name] = candidate
            module_slot_owner[module_name] = relative_path
        else:
            current_owner = module_slot_owner.get(module_name, '')
            shadowed_files[relative_path] = current_owner

    def _parse_file(python_file: Path) -> tuple[str, str, ModuleIndex | None, str | None]:
        # Reuse lexical path components for both identities. Preserve '..' and
        # symlink spelling; external packages still use their __init__.py chain.
        parts = python_file.parts
        if (root_parts is not None and len(parts) > len(root_parts) and parts[:len(root_parts)] == root_parts
                and (root_parts or not python_file.anchor)):
            relative_parts = parts[len(root_parts):]
            relative_path = '/'.join(relative_parts) or '.'
            module_parts = relative_parts[:-1]
            if python_file.name != '__init__.py':
                module_parts += (python_file.stem,)
            module_name = '.'.join(module_parts)
        else:
            try:
                relative_path = python_file.relative_to(root).as_posix()
            except ValueError:
                relative_path = str(python_file)
            module_name = _module_name_from_path(root, python_file, import_roots=import_roots)
        cached_module = cached_modules.get(relative_path)
        if cached_module is not None:
            return relative_path, module_name, cached_module, None

        try:
            file_text = python_file.read_text(encoding='utf-8')
            parsed_module = ast.parse(file_text)
        except (OSError, SyntaxError, UnicodeDecodeError) as parse_error:
            print(
                f'[static_index] parse_failed file={relative_path} '
                f'error={type(parse_error).__name__}: {parse_error}',
                file=__import__('sys').stderr,
            )
            return relative_path, module_name, None, type(parse_error).__name__

        module_index = _build_module_index(root, python_file, module_name, parsed_module, source_text=file_text)
        return relative_path, module_name, module_index, None

    def _record_result(result: tuple[str, str, ModuleIndex | None, str | None]) -> None:
        nonlocal has_fresh_modules
        relative_path, module_name, module_index, error = result
        has_fresh_modules |= relative_path not in cached_modules
        if module_index is not None:
            _record_slot(module_name, module_index, relative_path)
        else:
            unparseable_files[relative_path] = error or 'OSError'

    if len(source_files) >= 128 and not cached_modules:
        # Overlap file reads on large cold scans. Consume in source order so
        # package/file collision winners and candidate ordering stay stable.
        # Keep at most 64 files pending. Eight tasks claim work from one queue,
        # avoiding per-file Futures while keeping slow files evenly assigned.
        with ThreadPoolExecutor(max_workers=8, thread_name_prefix='static-index') as executor:
            for offset in range(0, len(source_files), 64):
                paths = source_files[offset:offset + 64]
                pending = SimpleQueue()
                for ordinal, path in enumerate(paths):
                    pending.put((ordinal, path))
                results = [None] * len(paths)

                def _parse_remaining(_worker):
                    while True:
                        try:
                            ordinal, path = pending.get_nowait()
                        except Empty:
                            return
                        try:
                            results[ordinal] = _parse_file(path)
                        except BaseException as error:
                            results[ordinal] = error

                for _ in executor.map(_parse_remaining, range(min(8, len(paths)))):
                    pass
                for result in results:
                    if isinstance(result, BaseException):
                        raise result
                    _record_result(result)
    else:
        for python_file in source_files:
            _record_result(_parse_file(python_file))

    # Carry over previously-known unparseable entries for files that we did
    # not visit fresh and that still aren't represented in `modules`. This
    # keeps the count invariant stable across partial-cache reloads even
    # when a persistent failure already exists in the cache.
    for relative_path, error_kind in cached_unparseable.items():
        if relative_path in unparseable_files:
            continue
        if relative_path in shadowed_files:
            continue
        module_name = _module_name_from_relative_path(relative_path)
        if module_name in modules:
            continue
        unparseable_files[relative_path] = error_kind

    index = _static_index_from_modules(
        python_file_count=len(source_files),
        modules=modules,
        expand_inheritance=has_fresh_modules,
        unparseable_files=unparseable_files,
        shadowed_files=shadowed_files,
    )
    if import_roots:
        index._source_import_roots = tuple(import_roots)
    return index


def _module_name_from_relative_path(relative_path: str) -> str:
    if Path(relative_path).is_absolute():
        return _module_name_from_path(Path('.'), Path(relative_path))
    parts = relative_path.split('/')
    if not parts:
        return ''
    if parts[-1].endswith('.py'):
        parts[-1] = parts[-1][:-3]
    if parts and parts[-1] == '__init__':
        parts.pop()
    return '.'.join(p for p in parts if p)


def _module_models_unchanged(
    old_module: ModuleIndex | None,
    new_module: ModuleIndex | None,
) -> bool:
    """Check if model definitions are unchanged between two versions of a module.

    Compares model_candidates, pending_fields, class_base_refs, field-class
    metadata, and import_bindings (imports affect cross-module inheritance and
    field resolution).
    """
    if old_module is None and new_module is None:
        return True
    if old_module is None or new_module is None:
        remaining = old_module or new_module
        # Pure helpers cannot change field/inheritance/import resolution.
        return not (remaining.model_candidates or remaining.pending_fields or remaining.class_base_refs
                    or remaining.field_class_names or remaining.field_aliases or remaining.import_bindings)
    return (
        old_module.model_candidates == new_module.model_candidates
        and old_module.pending_fields == new_module.pending_fields
        and old_module.class_base_refs == new_module.class_base_refs
        and old_module.field_class_names == new_module.field_class_names
        and old_module.field_aliases == new_module.field_aliases
        and old_module.import_bindings == new_module.import_bindings
        and old_module.explicit_all == new_module.explicit_all
    )


def _module_resolution_unchanged(old_module: ModuleIndex | None, new_module: ModuleIndex | None) -> bool:
    """Field edits can reuse other modules' direct fields, never derived reverses.

    Imports, model identities, bases and custom field metadata can affect any
    module, so changes to them deliberately take the full resolution path.
    """
    if old_module is None or new_module is None:
        return _module_models_unchanged(old_module, new_module)
    return (
        old_module.model_candidates == new_module.model_candidates
        and old_module.class_base_refs == new_module.class_base_refs
        and old_module.field_class_names == new_module.field_class_names
        and old_module.field_aliases == new_module.field_aliases
        and old_module.import_bindings == new_module.import_bindings
        and old_module.explicit_all == new_module.explicit_all
    )


def reindex_single_file(
    root: Path,
    file_path: Path,
    existing_static_index: StaticIndex,
) -> tuple[StaticIndex, set[str], set[str]]:
    """Re-parse a single file and return an updated StaticIndex.

    Returns:
        (new_static_index, old_labels, new_labels)
        - old_labels: model labels from the previous version of this file
        - new_labels: model labels from the new version of this file
    """
    module_name = _module_name_for_reindex(root, file_path, existing_static_index)
    try:
        relative_path = file_path.relative_to(root).as_posix()
    except ValueError:
        relative_path = None

    # Collect old model labels from this module
    old_labels: set[str] = set()
    old_module = existing_static_index.modules.get(module_name)
    if old_module is not None:
        old_labels = {c.label for c in old_module.model_candidates}

    # Copy existing modules + unparseable + shadowed so that updates here
    # don't mutate the previously-returned StaticIndex (callers may keep a
    # reference).
    modules = dict(existing_static_index.modules)
    unparseable_files = dict(existing_static_index.unparseable_files)
    shadowed_files = dict(existing_static_index.shadowed_files)

    new_module: ModuleIndex | None = None
    source_fingerprint = None
    new_labels: set[str] = set()
    parse_failed = False
    sibling = (Path(str(file_path.parent) + '.py') if file_path.name == '__init__.py'
               else file_path.with_suffix('') / '__init__.py')
    has_collision = sibling.is_relative_to(root) and (
        sibling.exists() or (old_module is not None and old_module.file_path != str(file_path))
    )
    if has_collision:
        # Only the two files in this module slot need inspection. Preserve the
        # package winner on shadow edits, and promote the sibling on deletion.
        choices = []
        for candidate_path in sorted((file_path, sibling)):
            candidate_relative = candidate_path.relative_to(root).as_posix()
            unparseable_files.pop(candidate_relative, None)
            shadowed_files.pop(candidate_relative, None)
            if not candidate_path.exists():
                continue
            if old_module is not None and old_module.file_path == str(candidate_path) and candidate_path != file_path:
                choices.append(old_module)
                continue
            try:
                candidate_text = candidate_path.read_text(encoding='utf-8')
                parsed = ast.parse(candidate_text)
                if candidate_path == file_path:
                    parsed_module = parsed
                choices.append(_build_module_index(root, candidate_path, module_name, parsed, source_text=candidate_text))
            except (OSError, SyntaxError, UnicodeDecodeError) as error:
                unparseable_files[candidate_relative] = type(error).__name__
        for candidate in choices:
            if new_module is None or _should_replace_module_index(new_module, candidate):
                new_module = candidate
        if new_module is not None:
            modules[module_name] = new_module
            for candidate in choices:
                if candidate is not new_module:
                    shadowed_files[Path(candidate.file_path).relative_to(root).as_posix()] = Path(new_module.file_path).relative_to(root).as_posix()
        else:
            modules.pop(module_name, None)
        if new_module is old_module and old_module.file_path != str(file_path):
            old_labels = set()
        else:
            new_labels = {candidate.label for candidate in new_module.model_candidates} if new_module else set()
    elif file_path.exists():
        try:
            source_bytes = file_path.read_bytes()
            file_text = source_bytes.decode('utf-8')
            parsed_module = ast.parse(file_text)
        except (OSError, SyntaxError, UnicodeDecodeError) as parse_error:
            parse_failed = True
            if relative_path is not None:
                unparseable_files[relative_path] = type(parse_error).__name__
                print(
                    f'[static_index] reindex_parse_failed file={relative_path} '
                    f'error={type(parse_error).__name__}: {parse_error}',
                    file=__import__('sys').stderr,
                )
            modules.pop(module_name, None)

        if not parse_failed:
            source_fingerprint = (str(file_path), hashlib.sha256(source_bytes).digest())
            new_module = _build_module_index(root, file_path, module_name, parsed_module, source_text=file_text)
            modules[module_name] = new_module
            new_labels = {c.label for c in new_module.model_candidates}
            if relative_path is not None:
                unparseable_files.pop(relative_path, None)
    else:
        # File deleted
        modules.pop(module_name, None)
        if relative_path is not None:
            unparseable_files.pop(relative_path, None)

    # Drop any prior shadow record for this file — the reindex either
    # reaffirms it (caller will reissue) or is now obsolete.
    if relative_path is not None and not has_collision:
        shadowed_files.pop(relative_path, None)

    # Recompute python_file_count from the post-update sets so the
    # invariant `python_file_count == len(modules) + len(unparseable_files)
    # + len(shadowed_files)` survives add/modify/delete reindex outcomes
    # equally. This is what the cache validator at load time relies on to
    # detect silent drift.
    new_python_file_count = (
        len(modules) + len(unparseable_files) + len(shadowed_files)
    )

    # Fast path: if model definitions are unchanged, skip expensive
    # _expand_model_candidates_via_imports and _resolve_fields.
    # This covers the common case of editing views, utils, tests, etc.
    constructor_dependents = existing_static_index.constructor_dependents(module_name)
    if not parse_failed and not constructor_dependents and _module_models_unchanged(old_module, new_module):
        new_static_index = _static_index_from_modules(
            python_file_count=new_python_file_count,
            modules=modules,
            expand_inheritance=False,
            cached_fields=existing_static_index.fields,
            cached_direct_fields=existing_static_index._direct_fields_by_module,
            cached_index=existing_static_index,
            changed_module_name=module_name,
            source_index=existing_static_index,
            unparseable_files=unparseable_files,
            shadowed_files=shadowed_files,
        )
        new_static_index._reindexed_source_fingerprint = source_fingerprint
        return new_static_index, old_labels, new_labels

    # Direct fields in untouched modules remain valid for a field-only edit.
    # Inherited fields and reverse relations are still recomputed globally.
    reusable_direct_fields = None
    scalar_add_module = None
    if not parse_failed and _module_resolution_unchanged(old_module, new_module):
        reusable_direct_fields = {
            name: fields for name, fields in existing_static_index._direct_fields_by_module.items()
            if name != module_name and name not in constructor_dependents and name in modules
        }
        if old_module is not None and new_module is not None:
            previous = {(p.model_label, p.name): p for p in old_module.pending_fields}
            current = {(p.model_label, p.name): p for p in new_module.pending_fields}
            scalar_changes = [p for key, p in current.items() if previous.get(key) != p]
            scalar_removals = [p for key, p in previous.items() if key not in current]
            old_relations = {key: pending for key, pending in previous.items() if pending.is_relation}
            new_relations = {key: pending for key, pending in current.items() if pending.is_relation}
            if (scalar_changes or scalar_removals) and old_relations == new_relations and all(
                not p.is_relation and p.name not in {'id', 'pk'} for p in scalar_changes
                + scalar_removals
            ) and not any(isinstance(node, ast.keyword) and node.arg == 'primary_key' for node in ast.walk(parsed_module)):
                scalar_add_module = module_name if not constructor_dependents else None
        if (constructor_dependents and _module_models_unchanged(old_module, new_module)
                and all(not pending.is_relation and pending.name not in {'id', 'pk'} and not pending.has_primary_key_option
                        for name in constructor_dependents for pending in modules[name].pending_fields
                        if pending.constructor_imports)):
            scalar_add_module = frozenset(constructor_dependents)
    new_static_index = _static_index_from_modules(
        python_file_count=new_python_file_count,
        modules=modules,
        expand_inheritance=True,
        cached_direct_fields=reusable_direct_fields,
        cached_index=existing_static_index if reusable_direct_fields is not None else None,
        changed_module_name=module_name,
        source_index=existing_static_index,
        scalar_add_module=scalar_add_module,
        unparseable_files=unparseable_files,
        shadowed_files=shadowed_files,
    )
    new_static_index._reindexed_source_fingerprint = source_fingerprint
    return new_static_index, old_labels, new_labels


def _should_replace_module_index(existing: ModuleIndex, candidate: ModuleIndex) -> bool:
    if existing.is_package_init == candidate.is_package_init:
        return False

    # Match Python import semantics when both `pkg/mod.py` and `pkg/mod/__init__.py`
    # exist: importing `pkg.mod` resolves to the package, not the sibling module file.
    return candidate.is_package_init


def _build_module_index(
    root: Path,
    python_file: Path,
    module_name: str,
    parsed_module: ast.Module,
    *,
    source_text: str | None = None,
) -> ModuleIndex:
    prepare_source_columns(parsed_module, source_text)
    defined_symbols: set[str] = set()
    symbol_definitions: dict[str, DefinitionLocation] = {}
    import_bindings: list[ImportBinding] = []
    explicit_all: list[str] | None = None
    model_candidates: list[ModelCandidate] = []
    class_base_refs: dict[str, tuple[str, ...]] = {}
    field_alias_refs: dict[str, str] = {}
    pending_fields: list[PendingFieldCandidate] = []
    is_package_init = python_file.name == '__init__.py'

    class_nodes: list[ast.ClassDef] = []
    for node in _iter_indexable_module_nodes(parsed_module.body):
        if isinstance(node, ast.ClassDef):
            defined_symbols.add(node.name)
            symbol_definitions.setdefault(
                node.name,
                _definition_location(str(python_file), node),
            )
            class_nodes.append(node)
            bases = tuple(b for b in (_dotted_name(base) for base in node.bases) if b)
            if bases:
                class_base_refs[node.name] = bases

            if _looks_like_model_candidate(node):
                model_candidates.append(
                    _model_candidate_from_class(
                        python_file=python_file,
                        module_name=module_name,
                        node=node,
                    )
                )

        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            defined_symbols.add(node.name)
            symbol_definitions.setdefault(
                node.name,
                _definition_location(str(python_file), node),
            )

        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    defined_symbols.add(target.id)
                    symbol_definitions.setdefault(
                        target.id,
                        _definition_location(
                            str(python_file),
                            target,
                        ),
                    )

            maybe_all = _extract_string_sequence(node.value)
            if maybe_all is not None and any(
                isinstance(target, ast.Name) and target.id == '__all__'
                for target in node.targets
            ):
                explicit_all = maybe_all

            value_ref = _dotted_name(node.value)
            if value_ref:
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        field_alias_refs[target.id] = value_ref

        elif isinstance(node, ast.AnnAssign):
            if isinstance(node.target, ast.Name):
                defined_symbols.add(node.target.id)
                symbol_definitions.setdefault(
                    node.target.id,
                    _definition_location(
                        str(python_file),
                        node.target,
                    ),
                )

                if node.target.id == '__all__' and node.value is not None:
                    maybe_all = _extract_string_sequence(node.value)
                    if maybe_all is not None:
                        explicit_all = maybe_all

                if node.value is not None:
                    value_ref = _dotted_name(node.value)
                    if value_ref:
                        field_alias_refs[node.target.id] = value_ref

        elif isinstance(node, ast.Import):
            for alias in node.names:
                binding_alias = alias.asname or alias.name.split('.')[0]
                import_bindings.append(
                    ImportBinding(
                        module=alias.name,
                        symbol=None,
                        alias=binding_alias,
                        is_star=False,
                    )
                )

        elif isinstance(node, ast.ImportFrom):
            imported_module = _resolve_imported_module(
                current_module=module_name,
                imported_module=node.module,
                level=node.level,
                is_package_init=is_package_init,
            )
            if imported_module is None:
                continue

            for alias in node.names:
                import_bindings.append(
                    ImportBinding(
                        module=imported_module,
                        symbol=None if alias.name == '*' else alias.name,
                        alias=alias.asname or alias.name,
                        is_star=alias.name == '*',
                    )
                )

    field_aliases = _resolve_field_aliases(
        field_alias_refs=field_alias_refs,
        import_bindings=import_bindings,
    )
    field_class_names = _discover_local_field_class_names(
        class_base_refs=class_base_refs,
        import_bindings=import_bindings,
        field_aliases=field_aliases,
    )
    class_node_by_name = {node.name: node for node in class_nodes}
    known_class_names = set(class_node_by_name)
    # Only seeded models and their same-module subclasses consume these
    # snapshots. Imported-model promotion prepares its own source contexts.
    declaration_contexts = (
        class_declaration_contexts(parsed_module, module_name=module_name,
                                   is_package_init=is_package_init)
        if model_candidates else {}
    )

    for candidate in model_candidates:
        node = class_node_by_name.get(candidate.object_name)
        if node is None:
            continue
        pending_fields.extend(
            _extract_pending_fields_from_model_class(
                python_file=python_file,
                module_name=module_name,
                app_label=candidate.app_label,
                model_name=candidate.object_name,
                class_node=node,
                import_bindings=import_bindings,
                field_class_names=field_class_names,
                field_aliases=field_aliases,
                known_class_names=known_class_names,
                declaration_context=declaration_contexts.get(node),
            )
        )

    # 2차 패스: 같은 모듈 내 model candidate를 상속하는 클래스도 model candidate로 등록
    registered_names = {c.object_name for c in model_candidates}
    changed = True
    while changed:
        changed = False
        for node in class_nodes:
            if node.name in registered_names:
                continue
            base_names = [_dotted_name(base) for base in node.bases]
            if any(
                base_name in registered_names
                or base_name.rsplit('.', 1)[-1] in registered_names
                for base_name in base_names
                if base_name
            ):
                model_app_label = _model_app_label(
                    module_name=module_name,
                    node=node,
                )
                model_candidates.append(
                    _model_candidate_from_class(
                        python_file=python_file,
                        module_name=module_name,
                        node=node,
                    )
                )
                pending_fields.extend(
                    _extract_pending_fields_from_model_class(
                        python_file=python_file,
                        module_name=module_name,
                        app_label=model_app_label,
                        model_name=node.name,
                        class_node=node,
                        import_bindings=import_bindings,
                        field_class_names=field_class_names,
                        field_aliases=field_aliases,
                        known_class_names=known_class_names,
                        declaration_context=declaration_contexts.get(node),
                    )
                )
                registered_names.add(node.name)
                changed = True

    return ModuleIndex(
        module_name=module_name,
        file_path=str(python_file),
        is_package_init=is_package_init,
        defined_symbols=defined_symbols,
        symbol_definitions=symbol_definitions,
        import_bindings=import_bindings,
        explicit_all=explicit_all,
        model_candidates=model_candidates,
        pending_fields=pending_fields,
        class_base_refs=class_base_refs,
        field_class_names=tuple(sorted(field_class_names)),
        field_aliases=field_aliases,
        constructor_imports=tuple(sorted({reference for field in pending_fields
                                         for reference in field.constructor_imports
                                         if not reference.startswith('django.')})),
        source_member_declarations=SourceMemberDeclarations.from_source(parsed_module, source_text),
    )


def _iter_indexable_module_nodes(
    nodes: list[ast.stmt],
) -> list[ast.stmt]:
    collected: list[ast.stmt] = []

    for node in nodes:
        collected.append(node)
        if isinstance(node, ast.If) and _is_type_checking_guard(node.test):
            collected.extend(_iter_indexable_module_nodes(node.body))

    return collected


def _is_type_checking_guard(node: ast.expr) -> bool:
    if isinstance(node, ast.Name):
        return node.id == 'TYPE_CHECKING'

    if isinstance(node, ast.Attribute):
        return (
            isinstance(node.value, ast.Name)
            and node.value.id == 'typing'
            and node.attr == 'TYPE_CHECKING'
        )

    return False


def _model_candidate_from_class(
    *,
    python_file: Path,
    module_name: str,
    node: ast.ClassDef,
) -> ModelCandidate:
    app_label = _model_app_label(module_name=module_name, node=node)
    return ModelCandidate(
        app_label=app_label,
        object_name=node.name,
        label=f'{app_label}.{node.name}',
        module=module_name,
        file_path=str(python_file),
        line=node.lineno,
        column=source_column(node),
        is_abstract=_is_abstract_model_class(node),
        base_class_refs=tuple(
            base_name
            for base_name in (_dotted_name(base) for base in node.bases)
            if base_name
        ),
    )


def _extract_string_sequence(node: ast.expr) -> list[str] | None:
    if not isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return None

    values: list[str] = []
    for element in node.elts:
        if not isinstance(element, ast.Constant) or not isinstance(element.value, str):
            return None
        values.append(element.value)

    return values


def _extract_pending_fields_from_model_class(
    *,
    python_file: Path,
    module_name: str,
    app_label: str,
    model_name: str,
    class_node: ast.ClassDef,
    import_bindings: list[ImportBinding],
    field_class_names: set[str],
    field_aliases: dict[str, str],
    known_class_names: set[str],
    declaration_context: DeclarationContext | None = None,
) -> list[PendingFieldCandidate]:
    fields: list[PendingFieldCandidate] = []
    model_label = f'{app_label}.{model_name}'

    for node, field_context in class_field_contexts(class_node, declaration_context or DeclarationContext({}, {})):
        target_name: str | None = None
        value_node: ast.expr | None = None

        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target = node.targets[0]
            if isinstance(target, ast.Name):
                target_name = target.id
                value_node = node.value
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            target_name = node.target.id
            value_node = node.value

        if target_name is None or value_node is None or not isinstance(value_node, ast.Call):
            continue

        field_kind = _field_kind_name(
            value_node.func,
            import_bindings=import_bindings,
            field_class_names=field_class_names,
            field_aliases=field_aliases,
            known_class_names=known_class_names,
        )
        if field_kind is None:
            continue

        is_relation = field_kind in RELATION_FIELD_KINDS
        field_call_ref = _dotted_name(value_node.func)
        related_model_ref_kind: str | None = None
        related_model_ref_value: str | None = None

        related_model_node = _extract_related_model_reference_node(value_node)
        if is_relation and related_model_node is not None:
            related_model_ref_kind, related_model_ref_value = _extract_related_model_reference(
                related_model_node,
                app_label=app_label,
            )

        related_name = _extract_keyword_string(value_node, 'related_name')
        related_query_name = _extract_keyword_string(value_node, 'related_query_name')
        normalized_constructor = normalize_declaration(value_node, field_context)
        fields.append(
            PendingFieldCandidate(
                model_label=model_label,
                model_module=module_name,
                app_label=app_label,
                name=target_name,
                file_path=str(python_file),
                line=node.lineno,
                column=source_column(node),
                field_call_ref=field_call_ref,
                field_kind=field_kind,
                is_relation=is_relation,
                related_model_ref_kind=related_model_ref_kind,
                related_model_ref_value=related_model_ref_value,
                related_name=related_name,
                related_query_name=related_query_name,
                constructor_fingerprint=hashlib.blake2s(ast.dump(
                    normalized_constructor,
                    include_attributes=False).encode(), digest_size=16).hexdigest(),
                constructor_imports=tuple(reference for reference in imported_references(value_node, field_context)
                                          if not reference.startswith('django.')),
                has_primary_key_option=any(isinstance(value, ast.keyword) and value.arg in {None, 'primary_key'}
                                          for value in ast.walk(normalized_constructor)),
            )
        )

    return fields


def _field_kind_name(
    function_node: ast.expr,
    *,
    import_bindings: list[ImportBinding],
    field_class_names: set[str],
    field_aliases: dict[str, str],
    known_class_names: set[str],
) -> str | None:
    name = _dotted_name(function_node)
    if not name:
        return None

    module_stub = ModuleIndex(
        module_name='',
        file_path='',
        is_package_init=False,
        defined_symbols=set(),
        symbol_definitions={},
        import_bindings=import_bindings,
        explicit_all=None,
        model_candidates=[],
        pending_fields=[],
        class_base_refs={},
        field_class_names=tuple(field_class_names),
        field_aliases=field_aliases,
    )
    resolved_kind = _field_ref_kind_for_module(name, module_stub)
    if resolved_kind is not None:
        return resolved_kind

    field_name = name.split('.')[-1]
    if '.' not in name and field_name in known_class_names:
        return None

    if _is_potential_field_class_name(field_name):
        return field_name

    return None


def _resolve_field_aliases(
    *,
    field_alias_refs: dict[str, str],
    import_bindings: list[ImportBinding],
) -> dict[str, str]:
    aliases: dict[str, str] = {}
    module_stub = ModuleIndex(
        module_name='',
        file_path='',
        is_package_init=False,
        defined_symbols=set(),
        symbol_definitions={},
        import_bindings=import_bindings,
        explicit_all=None,
        model_candidates=[],
        pending_fields=[],
        class_base_refs={},
    )

    for alias, field_ref in field_alias_refs.items():
        field_kind = _field_ref_kind_for_module(field_ref, module_stub)
        if field_kind is not None:
            aliases[alias] = field_kind

    return aliases


def _discover_local_field_class_names(
    *,
    class_base_refs: dict[str, tuple[str, ...]],
    import_bindings: list[ImportBinding],
    field_aliases: dict[str, str],
) -> set[str]:
    field_class_names: set[str] = set()
    changed = True

    while changed:
        changed = False
        module_stub = ModuleIndex(
            module_name='',
            file_path='',
            is_package_init=False,
            defined_symbols=set(),
            symbol_definitions={},
            import_bindings=import_bindings,
            explicit_all=None,
            model_candidates=[],
            pending_fields=[],
            class_base_refs=class_base_refs,
            field_class_names=tuple(field_class_names),
            field_aliases=field_aliases,
        )

        for class_name, base_refs in class_base_refs.items():
            if class_name in field_class_names:
                continue
            if any(
                _field_ref_kind_for_module(base_ref, module_stub) is not None
                for base_ref in base_refs
            ):
                field_class_names.add(class_name)
                changed = True

    return field_class_names


def _field_ref_kind_for_module(
    field_ref: str,
    module: ModuleIndex,
) -> str | None:
    if not field_ref:
        return None

    field_ref = field_ref.strip()
    field_name = field_ref.rsplit('.', 1)[-1]

    if '.' not in field_ref:
        if field_ref in module.field_aliases:
            return module.field_aliases[field_ref]
        if field_ref in module.field_class_names:
            return field_ref
        if _is_direct_django_field_import(field_ref, module.import_bindings):
            return field_ref
        if _is_direct_known_external_field_import(field_ref, module.import_bindings):
            return field_ref
        return None

    container_ref, field_name = field_ref.rsplit('.', 1)
    if (
        _is_django_model_namespace_ref(container_ref, module)
        and _is_potential_field_class_name(field_name)
    ):
        return field_name

    if field_name in module.field_class_names and container_ref in {'self', module.module_name}:
        return field_name

    return None


def _is_direct_django_field_import(
    field_name: str,
    import_bindings: list[ImportBinding],
) -> bool:
    if not _is_potential_field_class_name(field_name):
        return False

    for binding in import_bindings:
        if binding.alias != field_name or binding.symbol is None:
            continue
        if _is_django_model_module(binding.module):
            return True

    return False


def _is_direct_known_external_field_import(
    field_name: str,
    import_bindings: list[ImportBinding],
) -> bool:
    if not _is_known_external_field_class_name(field_name):
        return False

    return any(
        binding.alias == field_name and binding.symbol == field_name
        for binding in import_bindings
    )


def _is_django_model_namespace_ref(
    container_ref: str,
    module: ModuleIndex | None,
) -> bool:
    if _is_django_model_module(container_ref):
        return True

    if module is None or not container_ref:
        return False

    root_name = container_ref.split('.', 1)[0]
    for binding in module.import_bindings:
        if binding.alias != root_name:
            continue
        if binding.symbol is None and _is_django_model_module(binding.module):
            return True
        if binding.module in {'django.db', 'django.contrib.gis.db'} and binding.symbol == 'models':
            return True

    return False


def _is_django_model_module(module_name: str | None) -> bool:
    if not module_name:
        return False

    return (
        module_name == 'django.db.models'
        or module_name.startswith('django.db.models.')
        or module_name == 'django.contrib.postgres.fields'
        or module_name.startswith('django.contrib.postgres.fields.')
        or module_name == 'django.contrib.gis.db.models'
        or module_name.startswith('django.contrib.gis.db.models.')
    )


def _is_potential_field_class_name(name: str) -> bool:
    return (
        name in DJANGO_FIELD_CLASS_NAMES
        or name in KNOWN_EXTERNAL_FIELD_CLASS_NAMES
        or name.endswith('Field')
    )


def _is_known_external_field_class_name(name: str) -> bool:
    return name in KNOWN_EXTERNAL_FIELD_CLASS_NAMES


def _extract_related_model_reference_node(
    call_node: ast.Call,
) -> ast.expr | None:
    if call_node.args:
        return call_node.args[0]

    for keyword in call_node.keywords:
        if keyword.arg == 'to':
            return keyword.value

    return None


def _extract_related_model_reference(
    node: ast.expr,
    *,
    app_label: str,
) -> tuple[str | None, str | None]:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        if node.value == 'self':
            return 'self', node.value

        if '.' in node.value:
            return 'label', node.value

        return 'same_app_name', node.value

    if isinstance(node, ast.Name):
        return 'symbol', node.id

    return None, None


def _extract_keyword_string(call_node: ast.Call, keyword_name: str) -> str | None:
    for keyword in call_node.keywords:
        if keyword.arg != keyword_name:
            continue
        if isinstance(keyword.value, ast.Constant) and isinstance(keyword.value.value, str):
            return keyword.value.value
    return None


def _resolve_imported_module(
    *,
    current_module: str,
    imported_module: str | None,
    level: int,
    is_package_init: bool,
) -> str | None:
    if level == 0:
        return imported_module

    base_parts = current_module.split('.')
    package_parts = base_parts if is_package_init else base_parts[:-1]

    if level > 1:
        if level - 1 > len(package_parts):
            return None
        package_parts = package_parts[: len(package_parts) - (level - 1)]

    suffix_parts = imported_module.split('.') if imported_module else []
    full_parts = [part for part in (*package_parts, *suffix_parts) if part]
    return '.'.join(full_parts) if full_parts else None


def _looks_like_model_candidate(node: ast.ClassDef) -> bool:
    return any(_is_model_base(base) for base in node.bases)


def _model_app_label(
    *,
    module_name: str,
    node: ast.ClassDef,
) -> str:
    return _extract_model_meta_string(node, 'app_label') or module_name.split('.', 1)[0]


def _is_abstract_model_class(node: ast.ClassDef) -> bool:
    value = _extract_model_meta_value(node, 'abstract')
    return isinstance(value, ast.Constant) and value.value is True


def _extract_model_meta_string(
    node: ast.ClassDef,
    attribute_name: str,
) -> str | None:
    value = _extract_model_meta_value(node, attribute_name)
    if (
        isinstance(value, ast.Constant)
        and isinstance(value.value, str)
        and value.value
    ):
        return value.value
    return None


def _extract_model_meta_value(
    node: ast.ClassDef,
    attribute_name: str,
) -> ast.expr | None:
    for child in node.body:
        if not isinstance(child, ast.ClassDef) or child.name != 'Meta':
            continue

        for meta_node in child.body:
            if isinstance(meta_node, ast.Assign):
                for target in meta_node.targets:
                    if isinstance(target, ast.Name) and target.id == attribute_name:
                        return meta_node.value
            elif isinstance(meta_node, ast.AnnAssign) and isinstance(meta_node.target, ast.Name):
                if meta_node.target.id == attribute_name:
                    return meta_node.value

    return None


def _is_model_base(expression: ast.expr) -> bool:
    dotted_name = _dotted_name(expression)
    return _is_model_base_name(dotted_name)


def _is_builtin_model_base_name(dotted_name: str) -> bool:
    return (
        dotted_name.endswith('models.Model')
        or dotted_name.endswith('.Model')
        or dotted_name == 'Model'
    )


# Django/주요 라이브러리가 제공하는 추상 베이스 클래스들 — `*Model` suffix 가 없어
# suffix 휴리스틱으로는 인식 안 됨. captain 의 `db.User(AbstractUser)` 같은 패턴이
# 영원히 graph-only 로 빠지는 원인.
_KNOWN_ABSTRACT_BASE_SUFFIXES: tuple[str, ...] = (
    'AbstractUser',           # django.contrib.auth.models.AbstractUser
    'AbstractBaseUser',       # django.contrib.auth.models.AbstractBaseUser
    'AbstractBaseSession',    # django.contrib.sessions.base_session
    'AbstractPage',           # wagtail.models.AbstractPage
    'Page',                   # wagtail.models.Page (구체이지만 widely subclassed)
    'PolymorphicModel',       # django-polymorphic (필드 명 'Model' 로 안 끝남? — 'Model'로 끝남, but 명시)
    'TranslatableModel',      # django-parler
)


def _is_model_base_name(dotted_name: str) -> bool:
    if _is_builtin_model_base_name(dotted_name):
        return True
    if (
        dotted_name.endswith('Model')
        or dotted_name.endswith('BaseModel')
        or dotted_name.endswith('JobModel')
        or dotted_name.endswith('Orderable')
    ):
        return True
    for suffix in _KNOWN_ABSTRACT_BASE_SUFFIXES:
        if dotted_name == suffix or dotted_name.endswith(f'.{suffix}'):
            return True
    return False


def _dotted_name(expression: ast.expr) -> str:
    if isinstance(expression, ast.Name):
        return expression.id

    if isinstance(expression, ast.Attribute):
        prefix = _dotted_name(expression.value)
        return f'{prefix}.{expression.attr}' if prefix else expression.attr

    if isinstance(expression, ast.Subscript):
        return _dotted_name(expression.value)

    return ''


def _module_name_for_reindex(root: Path, file_path: Path, index: StaticIndex) -> str:
    if not file_path.is_relative_to(root):
        # Deleted package directories no longer have an __init__.py chain.
        # Probe only this path's possible import names, retaining the indexed
        # identity when its source matches. This avoids scanning every module
        # and cannot select an unrelated module with the same file name.
        parts = file_path.parent.parts
        if file_path.name != '__init__.py':
            parts += (file_path.stem,)
        canonical_path = None
        for offset in range(len(parts) - 1, -1, -1):
            name = '.'.join(parts[offset:])
            module = index.modules.get(name)
            if module is None:
                continue
            if module.file_path == str(file_path):
                return name
            if canonical_path is None:
                canonical_path = file_path.resolve()
            if Path(module.file_path).resolve() == canonical_path:
                return name
    return _module_name_from_path(root, file_path,
        import_roots=getattr(index, '_source_import_roots', ()))


def _module_name_from_path(root: Path, file_path: Path, *, import_roots=()) -> str:
    try:
        relative_path = file_path.relative_to(root)
    except ValueError:
        # Explicit editable import roots also cover namespace packages, whose
        # parents need not contain __init__.py. Preserve lexical source paths.
        for import_root in import_roots:
            try:
                relative = file_path.relative_to(Path(import_root))
            except ValueError:
                continue
            parts = relative.parent.parts if file_path.name == '__init__.py' else relative.with_suffix('').parts
            return '.'.join(parts)
        # A standard editable package may live outside the workspace (including
        # a src layout). Its contiguous __init__.py chain gives the import name.
        parts = [] if file_path.name == '__init__.py' else [file_path.stem]
        directory = file_path.parent
        while (directory / '__init__.py').is_file():
            parts.insert(0, directory.name)
            directory = directory.parent
        return '.'.join(parts) or file_path.parent.name

    if file_path.name == '__init__.py':
        return '.'.join(relative_path.parent.parts)

    return '.'.join(relative_path.with_suffix('').parts)


def _definition_location(file_path: str, node: ast.AST) -> DefinitionLocation:
    return DefinitionLocation(
        file_path=file_path,
        line=node.lineno,
        column=source_column(node),
    )


def _prepend_module(
    resolution: ExportResolution,
    *,
    requested_module: str,
    module_name: str,
    resolution_kind: str,
    symbol: str | None = None,
) -> ExportResolution:
    via_modules = [module_name]
    for name in resolution.via_modules:
        if name != module_name:
            via_modules.append(name)

    return ExportResolution(
        requested_module=requested_module,
        symbol=symbol or resolution.symbol,
        resolved=resolution.resolved,
        origin_module=resolution.origin_module,
        origin_symbol=resolution.origin_symbol,
        origin_file_path=resolution.origin_file_path,
        origin_line=resolution.origin_line,
        origin_column=resolution.origin_column,
        via_modules=via_modules,
        resolution_kind=resolution_kind,
    )


def _default_reverse_name(field_kind: str, source_model_label: str) -> str:
    source_model_name = source_model_label.split('.', 1)[1]
    source_model_name_lower = source_model_name.lower()

    if field_kind == 'OneToOneField':
        return source_model_name_lower

    return f'{source_model_name_lower}_set'


def _default_reverse_query_name(source_model_label: str) -> str:
    source_model_name = source_model_label.split('.', 1)[1]
    return source_model_name.lower()


def _reverse_query_name(
    *,
    field: FieldCandidate,
    source_model_label: str,
) -> str | None:
    if _is_hidden_related_name(field.related_name) or _is_hidden_related_name(
        field.related_query_name
    ):
        return None

    if field.related_query_name:
        return field.related_query_name

    if field.related_name:
        return field.related_name

    return _default_reverse_query_name(source_model_label)


def _string_or_none(value: object) -> str | None:
    if value is None:
        return None

    return str(value)


def _is_hidden_related_name(value: str | None) -> bool:
    return bool(value) and value.endswith('+')


def _clone_field_for_model(field: FieldCandidate, model_label: str) -> FieldCandidate:
    return dataclasses.replace(field, model_label=model_label)


def _preferred_reverse_related_model_label(
    static_index: StaticIndex,
    *,
    source_model_label: str,
    declared_model_label: str | None,
) -> str:
    if not declared_model_label or declared_model_label == source_model_label:
        return source_model_label

    declared_candidate = static_index.find_model_candidate(declared_model_label)
    if declared_candidate is None or declared_candidate.is_abstract:
        return source_model_label

    return declared_model_label


def _expand_model_candidates_via_imports(
    *,
    modules: dict[str, ModuleIndex],
    initial_candidates: list[ModelCandidate],
) -> list[ModelCandidate]:
    """등록된 model candidate를 import해서 상속하는 클래스를 추가 등록.
    class_base_refs + 역방향 import 인덱스로 파일 재파싱 없이 O(1) 조회."""
    registered: set[tuple[str, str]] = {
        (c.module, c.object_name) for c in initial_candidates
    }
    all_candidates = list(initial_candidates)

    names_by_module: dict[str, set[str]] = {}
    for c in initial_candidates:
        names_by_module.setdefault(c.module, set()).add(c.object_name)

    # 역방향 import 인덱스: (source_module, symbol) → [(importing_module, alias)]
    reverse_imports: dict[tuple[str, str], list[tuple[str, str]]] = {}
    # `from source_module import *` 바인딩: source_module이 export하는
    # 모든 심볼을 importing_module이 같은 이름으로 재노출하므로
    # seed 전파가 이 체인을 따라가야 한다.
    star_re_exporters: dict[str, list[str]] = {}
    for module_name, module_index in modules.items():
        for binding in module_index.import_bindings:
            if binding.is_star:
                star_re_exporters.setdefault(binding.module, []).append(
                    module_name
                )
                continue
            if binding.symbol is None:
                continue
            key = (binding.module, binding.symbol)
            reverse_imports.setdefault(key, []).append(
                (module_name, binding.alias)
            )

    def importers_of(
        seed_module: str, seed_symbol: str
    ) -> list[tuple[str, str]]:
        """seed (origin_module, origin_symbol)을 직접·간접(__init__.py
        star re-export, explicit same-name re-export)으로 import하는
        (importing_module, local_alias) 목록. 임의 깊이의 chain 추적."""
        out: list[tuple[str, str]] = []
        seen: set[tuple[str, str]] = set()
        stack: list[tuple[str, str]] = [(seed_module, seed_symbol)]
        while stack:
            src_mod, sym = stack.pop()
            if (src_mod, sym) in seen:
                continue
            seen.add((src_mod, sym))
            direct_importers = reverse_imports.get((src_mod, sym), ())
            out.extend(direct_importers)
            # Captain regression — `zuzu/db/models/company/__init__.py` 가
            # `from .company import Company` (explicit, non-star) 로 같은 이름
            # 재노출 시, 그 패키지 모듈을 다시 import 한 곳까지 BFS 가 도달
            # 해야 `Captable(Company)` 같은 transitive subclass 가 expand 에서
            # 잡힘. star 만 push 하던 옛 로직은 explicit re-export chain 을
            # 끊어버렸음.
            for importing_module, alias in direct_importers:
                if alias == sym:
                    stack.append((importing_module, alias))
            for re_mod in star_re_exporters.get(src_mod, ()):
                # star-importer는 같은 이름으로 sym을 노출하므로
                # 그 자체가 importer이고, 이후 체인도 추적한다.
                out.append((re_mod, sym))
                stack.append((re_mod, sym))
        return out

    # importers: model candidate를 import하는 모듈 → {local_alias}
    importers: dict[str, set[str]] = {}
    for c in initial_candidates:
        for importing_module, alias in importers_of(c.module, c.object_name):
            importers.setdefault(importing_module, set()).add(alias)

    pending_parse_queue: list[tuple[str, ModuleIndex, str, str]] = []
    copied_modules: set[str] = set()

    # BFS: 처리할 모듈 큐
    queue = list(importers.keys())
    visited_modules: set[str] = set()
    while queue:
        module_name = queue.pop(0)
        if module_name in visited_modules:
            continue
        visited_modules.add(module_name)

        module_index = modules[module_name]
        local_names = names_by_module.get(module_name, set())
        known = local_names | importers.get(module_name, set())

        for class_name, bases in module_index.class_base_refs.items():
            if (module_name, class_name) in registered:
                continue
            if not any(
                b in known or b.rsplit('.', 1)[-1] in known
                for b in bases
            ):
                continue

            app_label = module_name.split('.', 1)[0]
            candidate = ModelCandidate(
                app_label=app_label,
                object_name=class_name,
                label=f'{app_label}.{class_name}',
                module=module_name,
                file_path=module_index.file_path,
                line=0,
                column=0,
                is_abstract=False,
                base_class_refs=bases,
                source='static_inheritance',
            )
            all_candidates.append(candidate)
            if module_name not in copied_modules:
                module_index = dataclasses.replace(module_index,
                    model_candidates=list(module_index.model_candidates),
                    pending_fields=list(module_index.pending_fields))
                modules[module_name] = module_index
                copied_modules.add(module_name)
            module_index.model_candidates.append(candidate)
            pending_parse_queue.append(
                (module_name, module_index, app_label, class_name)
            )
            registered.add((module_name, class_name))
            names_by_module.setdefault(module_name, set()).add(
                class_name
            )
            # 새로 발견된 candidate를 (간접) import하는 모듈 — star
            # re-export 체인 포함 — 을 모두 큐에 추가.
            for importing_module, alias in importers_of(
                module_name, class_name
            ):
                importers.setdefault(importing_module, set()).add(alias)
                if importing_module not in visited_modules:
                    queue.append(importing_module)

    # 새로 발견된 candidate의 pending fields만 개별 재파싱
    files_to_parse: dict[str, list[tuple[str, ModuleIndex, str, str]]] = {}
    for item in pending_parse_queue:
        files_to_parse.setdefault(item[1].file_path, []).append(item)

    for file_path, items in files_to_parse.items():
        class_nodes, declaration_contexts = _parse_class_nodes(file_path, items[0][0])
        node_by_name = {n.name: n for n in class_nodes}
        for module_name, module_index, app_label, class_name in items:
            node = node_by_name.get(class_name)
            if node is None:
                continue
            # app_label, is_abstract, line 정보를 AST에서 보정
            real_app_label = (
                _extract_model_meta_string(node, 'app_label')
                or app_label
            )
            is_abstract = _is_abstract_model_class(node)
            # model_candidates에서 해당 candidate 업데이트
            for i, c in enumerate(all_candidates):
                if c.module == module_name and c.object_name == class_name:
                    corrected = ModelCandidate(
                        app_label=real_app_label,
                        object_name=class_name,
                        label=f'{real_app_label}.{class_name}',
                        module=module_name,
                        file_path=file_path,
                        line=node.lineno,
                        column=source_column(node),
                        is_abstract=is_abstract,
                        base_class_refs=tuple(
                            b for b in (
                                _dotted_name(base) for base in node.bases
                            ) if b
                        ),
                        source='static_inheritance',
                    )
                    all_candidates[i] = corrected
                    module_index.model_candidates[:] = [
                        corrected if item.object_name == class_name else item
                        for item in module_index.model_candidates
                    ]
                    break
            module_index.pending_fields.extend(
                _extract_pending_fields_from_model_class(
                    python_file=Path(file_path),
                    module_name=module_name,
                    app_label=real_app_label,
                    model_name=class_name,
                    class_node=node,
                    import_bindings=module_index.import_bindings,
                    field_class_names=set(module_index.field_class_names),
                    field_aliases=module_index.field_aliases,
                    known_class_names=module_index.defined_symbols,
                    declaration_context=declaration_contexts.get(node),
                )
            )

            imports = tuple(sorted({reference for field in module_index.pending_fields
                                    for reference in field.constructor_imports
                                    if not reference.startswith('django.')}))
            if imports != module_index.constructor_imports:
                updated = dataclasses.replace(module_index, constructor_imports=imports)
                modules[module_name] = updated
                # Remaining promotions for this file still append to the same
                # pending list; its final imports are derived again per class.

    return all_candidates


def _parse_class_nodes(file_path: str, module_name: str = '') -> tuple[list[ast.ClassDef], dict[ast.ClassDef, DeclarationContext]]:
    try:
        text = Path(file_path).read_text(encoding='utf-8')
        parsed = ast.parse(text)
        prepare_source_columns(parsed, text)
    except (OSError, SyntaxError, UnicodeDecodeError):
        return [], {}
    return [
        n for n in _iter_indexable_module_nodes(parsed.body)
        if isinstance(n, ast.ClassDef)
    ], class_declaration_contexts(parsed, module_name=module_name or _module_name_from_path(Path('.'), Path(file_path)),
                                 is_package_init=Path(file_path).name == '__init__.py')


def _build_expanded_candidate(
    module_index: ModuleIndex,
    module_name: str,
    app_label: str,
    node: ast.ClassDef,
) -> ModelCandidate:
    return ModelCandidate(
        app_label=app_label,
        object_name=node.name,
        label=f'{app_label}.{node.name}',
        module=module_name,
        file_path=module_index.file_path,
        line=node.lineno,
        column=source_column(node),
        is_abstract=_is_abstract_model_class(node),
        base_class_refs=tuple(
            b for b in (_dotted_name(base) for base in node.bases) if b
        ),
    )


def _static_index_from_modules(
    *,
    python_file_count: int,
    modules: dict[str, ModuleIndex],
    expand_inheritance: bool = True,
    cached_fields: list[FieldCandidate] | None = None,
    cached_direct_fields: dict[str, list[FieldCandidate]] | None = None,
    cached_index: StaticIndex | None = None,
    scalar_add_module: str | frozenset[str] | None = None,
    changed_module_name: str | None = None,
    source_index: StaticIndex | None = None,
    unparseable_files: dict[str, str] | None = None,
    shadowed_files: dict[str, str] | None = None,
) -> StaticIndex:
    if cached_index is None and expand_inheritance:
        # Expansion appends candidates/fields. Clone module containers and
        # remove previous promotions before deriving them from current bases.
        # line=0 identifies promotions in caches written before the marker.
        copied = {}
        for name, module in modules.items():
            if not module.model_candidates and not module.class_base_refs and not module.pending_fields:
                copied[name] = module
                continue
            derived_names = {candidate.object_name for candidate in module.model_candidates
                             if candidate.source == 'static_inheritance' or candidate.line == 0}
            if not derived_names:
                copied[name] = module
                continue
            copied[name] = dataclasses.replace(module,
                model_candidates=[candidate for candidate in module.model_candidates
                                  if candidate.object_name not in derived_names],
                pending_fields=[field for field in module.pending_fields
                                if field.model_label.rsplit('.', 1)[-1] not in derived_names])
        modules = copied
    package_init_count = 0
    reexport_module_count = 0
    star_import_count = 0
    explicit_all_count = 0
    model_candidates: list[ModelCandidate] = []

    statistics_index = cached_index or source_index
    update_statistics = statistics_index is not None and changed_module_name is not None
    if update_statistics:
        def statistics(module: ModuleIndex | None) -> tuple[int, int, int, int]:
            if module is None:
                return (0, 0, 0, 0)
            stars = sum(binding.is_star for binding in module.import_bindings)
            reexports = any(binding.is_star or binding.symbol is not None for binding in module.import_bindings)
            return (int(module.is_package_init),
                    int(module.is_package_init and (reexports or module.explicit_all is not None)),
                    stars, int(module.explicit_all is not None))
        previous = statistics(statistics_index.modules.get(changed_module_name))
        current = statistics(modules.get(changed_module_name))
        package_init_count, reexport_module_count, star_import_count, explicit_all_count = (
            total + new - old for total, new, old in zip(
                (statistics_index.package_init_count, statistics_index.reexport_module_count,
                 statistics_index.star_import_count, statistics_index.explicit_all_count), current, previous)
        )

    for module_index in (() if cached_index is not None and changed_module_name is not None else modules.values()):
        if update_statistics:
            model_candidates.extend(module_index.model_candidates)
            continue
        if module_index.is_package_init:
            package_init_count += 1

        module_star_imports = sum(
            1 for binding in module_index.import_bindings if binding.is_star
        )
        module_has_reexport = any(
            binding.is_star or binding.symbol is not None
            for binding in module_index.import_bindings
        )

        if module_index.explicit_all is not None:
            explicit_all_count += 1

        if module_index.is_package_init and (
            module_has_reexport or module_index.explicit_all is not None
        ):
            reexport_module_count += 1

        star_import_count += module_star_imports
        model_candidates.extend(module_index.model_candidates)

    # Cross-module 상속: 파일 변경이 있을 때만 확장 (캐시에서 로드 시 이미 확장됨)
    if cached_index is not None:
        model_candidates = list(cached_index.model_candidates)
    elif expand_inheritance:
        import time as _time
        _expand_start = _time.perf_counter()
        _initial_count = len(model_candidates)
        model_candidates = _expand_model_candidates_via_imports(
            modules=modules,
            initial_candidates=model_candidates,
        )
        _expand_elapsed = _time.perf_counter() - _expand_start
        _added = len(model_candidates) - _initial_count
        print(
            f'[PERF] expand_model_candidates: +{_added} models '
            f'{_expand_elapsed:.2f}s '
            f'(total={len(model_candidates)})',
            file=__import__("sys").stderr,
        )

    constructor_files = source_index._constructor_module_files if source_index is not None else None
    if constructor_files is not None and changed_module_name is not None:
        changed = modules.get(changed_module_name)
        location = (changed.file_path, changed.is_package_init) if changed is not None else None
        if constructor_files.get(changed_module_name) != location:
            constructor_files = dict(constructor_files)
            if location is None:
                constructor_files.pop(changed_module_name, None)
            else:
                constructor_files[changed_module_name] = location
    elif changed_module_name is None:
        constructor_files = None
    index = StaticIndex(
        python_file_count=python_file_count,
        package_init_count=package_init_count,
        reexport_module_count=reexport_module_count,
        star_import_count=star_import_count,
        explicit_all_count=explicit_all_count,
        modules=modules,
        model_candidates=model_candidates,
        unparseable_files=dict(unparseable_files) if unparseable_files else {},
        shadowed_files=dict(shadowed_files) if shadowed_files else {},
        _cached_fields=cached_fields,
        _cached_direct_fields=cached_direct_fields,
        _cached_index=cached_index,
        _scalar_add_module=scalar_add_module,
        _scalar_field_source=source_index,
        _constructor_files=constructor_files,
    )
    import_owner = source_index or cached_index
    if import_owner is not None and getattr(import_owner, '_source_import_roots', ()):
        index._source_import_roots = import_owner._source_import_roots
    if source_index is not None and changed_module_name is not None:
        old = source_index.modules.get(changed_module_name)
        new = modules.get(changed_module_name)
        cached_paths = source_index._workspace_source_paths
        cached_by_module = source_index._workspace_source_paths_by_module
        cached_counts = source_index._workspace_source_path_counts
        if cached_paths is not None and cached_by_module is not None and cached_counts is not None:
            old_path = cached_by_module.get(changed_module_name)
            new_path = str(Path(new.file_path).resolve()) if new is not None else None
            if old_path == new_path:
                index._workspace_source_paths = cached_paths
                index._workspace_source_paths_by_module = cached_by_module
                index._workspace_source_path_counts = cached_counts
            else:
                by_module = dict(cached_by_module)
                counts = dict(cached_counts)
                if old_path is not None:
                    by_module.pop(changed_module_name, None)
                    remaining = counts[old_path] - 1
                    if remaining:
                        counts[old_path] = remaining
                    else:
                        counts.pop(old_path)
                if new_path is not None:
                    by_module[changed_module_name] = new_path
                    counts[new_path] = counts.get(new_path, 0) + 1
                index._workspace_source_paths = frozenset(counts)
                index._workspace_source_paths_by_module = by_module
                index._workspace_source_path_counts = counts
        if (old.import_bindings if old else []) == (new.import_bindings if new else []):
            index._import_dependency_cache = source_index._import_dependency_cache
            if ((old.constructor_imports if old else ()) == (new.constructor_imports if new else ())):
                index._constructor_dependency_cache = source_index._constructor_dependency_cache
    return index
