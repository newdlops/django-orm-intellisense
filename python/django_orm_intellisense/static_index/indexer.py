from __future__ import annotations

import ast
import dataclasses
from dataclasses import dataclass
from pathlib import Path

from ..discovery.workspace import iter_python_files

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


@dataclass(frozen=True)
class DefinitionLocation:
    file_path: str
    line: int
    column: int

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


@dataclass(frozen=True)
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


@dataclass(frozen=True)
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
        )


@dataclass(frozen=True)
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
        }


@dataclass(frozen=True)
class ImportBinding:
    module: str
    symbol: str | None
    alias: str
    is_star: bool

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

    def to_dict(self) -> dict[str, object]:
        return {
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
        }

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
class StaticIndex:
    python_file_count: int
    package_init_count: int
    reexport_module_count: int
    star_import_count: int
    explicit_all_count: int
    modules: dict[str, ModuleIndex]
    model_candidates: list[ModelCandidate]

    def __post_init__(self) -> None:
        self._module_export_cache: dict[str, dict[str, ExportResolution]] = {}
        self._field_class_cache: dict[tuple[str, str], bool] = {}
        self._concrete_model_candidates = [
            candidate for candidate in self.model_candidates if not candidate.is_abstract
        ]
        self._model_candidates_by_label = {
            candidate.label: candidate for candidate in self.model_candidates
        }
        self._model_candidates_by_module_and_name = {
            (candidate.module, candidate.object_name): candidate
            for candidate in self.model_candidates
        }
        self._model_candidates_by_app_and_name: dict[
            tuple[str, str], list[ModelCandidate]
        ] = {}
        self._model_candidates_by_name: dict[str, list[ModelCandidate]] = {}
        for candidate in self.model_candidates:
            self._model_candidates_by_app_and_name.setdefault(
                (candidate.app_label, candidate.object_name),
                [],
            ).append(candidate)
            self._model_candidates_by_name.setdefault(candidate.object_name, []).append(
                candidate
            )
        # Allow skipping expensive _resolve_fields() when cached fields are
        # injected via class variable (used by reindex_single_file fast path).
        pre = getattr(StaticIndex, '_pre_resolved_fields', None)
        self.fields: list[FieldCandidate] = list(pre) if pre is not None else self._resolve_fields()
        self._fields_by_model_label: dict[str, list[FieldCandidate]] = {}
        self._fields_by_model_and_name: dict[tuple[str, str], FieldCandidate] = {}
        for field in self.fields:
            self._fields_by_model_label.setdefault(field.model_label, []).append(field)
            self._fields_by_model_and_name[(field.model_label, field.name)] = field

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
        }

    @classmethod
    def from_cache_dict(cls, payload: dict[str, object]) -> StaticIndex:
        raw_modules = payload.get('modules') or {}
        raw_model_candidates = payload.get('modelCandidates') or []

        if not isinstance(raw_modules, dict):
            raise ValueError('Invalid static index cache payload: modules.')

        return cls(
            python_file_count=int(payload['pythonFileCount']),
            package_init_count=int(payload['packageInitCount']),
            reexport_module_count=int(payload['reexportModuleCount']),
            star_import_count=int(payload['starImportCount']),
            explicit_all_count=int(payload['explicitAllCount']),
            modules={
                str(module_name): ModuleIndex.from_dict(dict(module_payload))
                for module_name, module_payload in raw_modules.items()
                if isinstance(module_payload, dict)
            },
            model_candidates=[
                ModelCandidate.from_dict(dict(candidate))
                for candidate in raw_model_candidates
                if isinstance(candidate, dict)
            ],
        )

    def resolve_export_origin(
        self,
        module_name: str,
        symbol: str,
    ) -> ExportResolution:
        exports = self._resolve_module_exports(module_name, stack=())
        if symbol in exports:
            return exports[symbol]

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
        module = self.modules.get(module_name)
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

        module = self.modules.get(module_name)
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

    def _resolve_fields(self) -> list[FieldCandidate]:
        direct_fields_by_model: dict[str, list[FieldCandidate]] = {}
        for module in self.modules.values():
            for pending in module.pending_fields:
                if not self._is_django_field_candidate(pending):
                    continue

                related_model_label = (
                    self._resolve_related_model_label(pending)
                    if pending.is_relation
                    else None
                )
                direct_fields_by_model.setdefault(pending.model_label, []).append(
                    FieldCandidate(
                        model_label=pending.model_label,
                        name=pending.name,
                        file_path=pending.file_path,
                        line=pending.line,
                        column=pending.column,
                        field_kind=pending.field_kind,
                        is_relation=pending.is_relation,
                        relation_direction='forward' if pending.is_relation else None,
                        related_model_label=related_model_label,
                        declared_model_label=pending.model_label,
                        related_name=pending.related_name,
                        related_query_name=pending.related_query_name,
                    )
                )

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
            direct_fields = list(direct_fields_by_model.get(model_label, []))
            direct_names = {field.name for field in direct_fields}
            inherited_fields: list[FieldCandidate] = []
            inherited_names: set[str] = set()

            if candidate is not None:
                for base_model_label in self._resolve_model_base_labels(candidate):
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

        reverse_fields: list[FieldCandidate] = []
        reverse_keys: set[tuple[str, str, str]] = set()
        for candidate in self._concrete_model_candidates:
            for field in expanded_forward_fields(candidate.label):
                if not field.is_relation or field.related_model_label is None:
                    continue

                reverse_name = field.related_name or _default_reverse_name(
                    field.field_kind,
                    candidate.label,
                )
                if _is_hidden_related_name(reverse_name):
                    continue

                reverse_query_name = _reverse_query_name(
                    field=field,
                    source_model_label=candidate.label,
                )
                reverse_key = (
                    field.related_model_label,
                    reverse_name,
                    candidate.label,
                )
                if reverse_key in reverse_keys:
                    continue

                reverse_keys.add(reverse_key)
                reverse_fields.append(
                    FieldCandidate(
                        model_label=field.related_model_label,
                        name=reverse_name,
                        file_path=field.file_path,
                        line=field.line,
                        column=field.column,
                        field_kind=f'reverse_{field.field_kind}',
                        is_relation=True,
                        relation_direction='reverse',
                        related_model_label=candidate.label,
                        declared_model_label=field.declared_model_label,
                        related_name=field.related_name,
                        related_query_name=reverse_query_name,
                    )
                )

        return forward_fields + reverse_fields

    def _is_django_field_candidate(
        self,
        pending: PendingFieldCandidate,
    ) -> bool:
        module = self.modules.get(pending.model_module)
        if module is not None and _field_ref_kind_for_module(
            pending.field_call_ref,
            module,
        ):
            return True

        return self._field_ref_resolves_to_field_class(
            module_name=pending.model_module,
            field_ref=pending.field_call_ref,
            stack=(),
        )

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

    def _resolve_model_base_labels(self, candidate: ModelCandidate) -> list[str]:
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

        return resolved_labels

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
) -> StaticIndex:
    modules: dict[str, ModuleIndex] = {}
    source_files = list(python_files) if python_files is not None else iter_python_files(root)
    cached_modules = cached_module_indices or {}
    has_fresh_modules = False

    for python_file in source_files:
        relative_path = python_file.relative_to(root).as_posix()
        module_name = _module_name_from_path(root, python_file)
        cached_module = cached_modules.get(relative_path)
        if cached_module is not None:
            existing_module = modules.get(module_name)
            if (
                existing_module is None
                or _should_replace_module_index(existing_module, cached_module)
            ):
                modules[module_name] = cached_module
            continue

        has_fresh_modules = True
        try:
            file_text = python_file.read_text(encoding='utf-8')
            parsed_module = ast.parse(file_text)
        except (OSError, SyntaxError, UnicodeDecodeError):
            continue

        module_index = _build_module_index(root, python_file, module_name, parsed_module)
        existing_module = modules.get(module_name)
        if existing_module is None or _should_replace_module_index(
            existing_module,
            module_index,
        ):
            modules[module_name] = module_index

    return _static_index_from_modules(
        python_file_count=len(source_files),
        modules=modules,
        expand_inheritance=has_fresh_modules,
    )


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
        return False
    return (
        old_module.model_candidates == new_module.model_candidates
        and old_module.pending_fields == new_module.pending_fields
        and old_module.class_base_refs == new_module.class_base_refs
        and old_module.field_class_names == new_module.field_class_names
        and old_module.field_aliases == new_module.field_aliases
        and old_module.import_bindings == new_module.import_bindings
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
    module_name = _module_name_from_path(root, file_path)

    # Collect old model labels from this module
    old_labels: set[str] = set()
    old_module = existing_static_index.modules.get(module_name)
    if old_module is not None:
        old_labels = {c.label for c in old_module.model_candidates}

    # Copy existing modules and replace the changed one
    modules = dict(existing_static_index.modules)

    new_module: ModuleIndex | None = None
    new_labels: set[str] = set()
    if file_path.exists():
        try:
            file_text = file_path.read_text(encoding='utf-8')
            parsed_module = ast.parse(file_text)
        except (OSError, SyntaxError, UnicodeDecodeError):
            # Syntax error or unreadable: keep old module, report no changes
            return existing_static_index, set(), set()

        new_module = _build_module_index(root, file_path, module_name, parsed_module)
        modules[module_name] = new_module
        new_labels = {c.label for c in new_module.model_candidates}
    else:
        # File deleted
        modules.pop(module_name, None)

    # Fast path: if model definitions are unchanged, skip expensive
    # _expand_model_candidates_via_imports and _resolve_fields.
    # This covers the common case of editing views, utils, tests, etc.
    if _module_models_unchanged(old_module, new_module):
        new_static_index = _static_index_from_modules(
            python_file_count=existing_static_index.python_file_count,
            modules=modules,
            expand_inheritance=False,
            cached_fields=existing_static_index.fields,
        )
        return new_static_index, old_labels, new_labels

    # Slow path: model definitions changed, full rebuild needed.
    new_static_index = _static_index_from_modules(
        python_file_count=existing_static_index.python_file_count,
        modules=modules,
        expand_inheritance=True,
    )
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
) -> ModuleIndex:
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
                _definition_location(str(python_file), node.lineno, node.col_offset),
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
                _definition_location(str(python_file), node.lineno, node.col_offset),
            )

        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    defined_symbols.add(target.id)
                    symbol_definitions.setdefault(
                        target.id,
                        _definition_location(
                            str(python_file),
                            target.lineno,
                            target.col_offset,
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
                        node.target.lineno,
                        node.target.col_offset,
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
        column=node.col_offset + 1,
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
) -> list[PendingFieldCandidate]:
    fields: list[PendingFieldCandidate] = []
    model_label = f'{app_label}.{model_name}'

    for node in class_node.body:
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
        fields.append(
            PendingFieldCandidate(
                model_label=model_label,
                model_module=module_name,
                app_label=app_label,
                name=target_name,
                file_path=str(python_file),
                line=node.lineno,
                column=node.col_offset + 1,
                field_call_ref=field_call_ref,
                field_kind=field_kind,
                is_relation=is_relation,
                related_model_ref_kind=related_model_ref_kind,
                related_model_ref_value=related_model_ref_value,
                related_name=related_name,
                related_query_name=related_query_name,
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


def _is_model_base_name(dotted_name: str) -> bool:
    return (
        _is_builtin_model_base_name(dotted_name)
        or dotted_name.endswith('Model')
        or dotted_name.endswith('BaseModel')
        or dotted_name.endswith('JobModel')
        or dotted_name.endswith('Orderable')
    )


def _dotted_name(expression: ast.expr) -> str:
    if isinstance(expression, ast.Name):
        return expression.id

    if isinstance(expression, ast.Attribute):
        prefix = _dotted_name(expression.value)
        return f'{prefix}.{expression.attr}' if prefix else expression.attr

    if isinstance(expression, ast.Subscript):
        return _dotted_name(expression.value)

    return ''


def _module_name_from_path(root: Path, file_path: Path) -> str:
    relative_path = file_path.relative_to(root)

    if file_path.name == '__init__.py':
        return '.'.join(relative_path.parent.parts)

    return '.'.join(relative_path.with_suffix('').parts)


def _definition_location(file_path: str, line: int, col_offset: int) -> DefinitionLocation:
    return DefinitionLocation(
        file_path=file_path,
        line=line,
        column=col_offset + 1,
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
    return FieldCandidate(
        model_label=model_label,
        name=field.name,
        file_path=field.file_path,
        line=field.line,
        column=field.column,
        field_kind=field.field_kind,
        is_relation=field.is_relation,
        relation_direction=field.relation_direction,
        related_model_label=field.related_model_label,
        declared_model_label=field.declared_model_label,
        related_name=field.related_name,
        related_query_name=field.related_query_name,
        source=field.source,
    )


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
    for module_name, module_index in modules.items():
        for binding in module_index.import_bindings:
            if binding.symbol is None or binding.is_star:
                continue
            key = (binding.module, binding.symbol)
            reverse_imports.setdefault(key, []).append(
                (module_name, binding.alias)
            )

    # importers: model candidate를 import하는 모듈 → {local_alias}
    importers: dict[str, set[str]] = {}
    for c in initial_candidates:
        for importing_module, alias in reverse_imports.get(
            (c.module, c.object_name), []
        ):
            importers.setdefault(importing_module, set()).add(alias)

    pending_parse_queue: list[tuple[str, ModuleIndex, str, str]] = []

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
            )
            all_candidates.append(candidate)
            module_index.model_candidates.append(candidate)
            pending_parse_queue.append(
                (module_name, module_index, app_label, class_name)
            )
            registered.add((module_name, class_name))
            names_by_module.setdefault(module_name, set()).add(
                class_name
            )
            # O(1) 조회: 이 새 candidate를 import하는 모듈을 큐에 추가
            for importing_module, alias in reverse_imports.get(
                (module_name, class_name), []
            ):
                importers.setdefault(importing_module, set()).add(alias)
                if importing_module not in visited_modules:
                    queue.append(importing_module)

    # 새로 발견된 candidate의 pending fields만 개별 재파싱
    files_to_parse: dict[str, list[tuple[str, ModuleIndex, str, str]]] = {}
    for item in pending_parse_queue:
        files_to_parse.setdefault(item[1].file_path, []).append(item)

    for file_path, items in files_to_parse.items():
        class_nodes = _parse_class_nodes(file_path)
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
                    all_candidates[i] = ModelCandidate(
                        app_label=real_app_label,
                        object_name=class_name,
                        label=f'{real_app_label}.{class_name}',
                        module=module_name,
                        file_path=file_path,
                        line=node.lineno,
                        column=node.col_offset + 1,
                        is_abstract=is_abstract,
                        base_class_refs=tuple(
                            b for b in (
                                _dotted_name(base) for base in node.bases
                            ) if b
                        ),
                    )
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
                )
            )

    return all_candidates


def _parse_class_nodes(file_path: str) -> list[ast.ClassDef]:
    try:
        text = Path(file_path).read_text(encoding='utf-8')
        parsed = ast.parse(text)
    except (OSError, SyntaxError, UnicodeDecodeError):
        return []
    return [
        n for n in _iter_indexable_module_nodes(parsed.body)
        if isinstance(n, ast.ClassDef)
    ]


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
        column=node.col_offset + 1,
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
) -> StaticIndex:
    package_init_count = 0
    reexport_module_count = 0
    star_import_count = 0
    explicit_all_count = 0
    model_candidates: list[ModelCandidate] = []

    for module_index in modules.values():
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
    if expand_inheritance:
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

    # Inject cached fields to skip expensive _resolve_fields() in __post_init__
    StaticIndex._pre_resolved_fields = cached_fields
    try:
        return StaticIndex(
            python_file_count=python_file_count,
            package_init_count=package_init_count,
            reexport_module_count=reexport_module_count,
            star_import_count=star_import_count,
            explicit_all_count=explicit_all_count,
            modules=modules,
            model_candidates=model_candidates,
        )
    finally:
        StaticIndex._pre_resolved_fields = None
