from __future__ import annotations

import ast
from dataclasses import dataclass
from pathlib import Path

from ..discovery.workspace import iter_python_files


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
    field_kind: str
    is_relation: bool
    related_model_ref_kind: str | None
    related_model_ref_value: str | None
    related_name: str | None

    def to_dict(self) -> dict[str, object]:
        return {
            'modelLabel': self.model_label,
            'modelModule': self.model_module,
            'appLabel': self.app_label,
            'name': self.name,
            'filePath': self.file_path,
            'line': self.line,
            'column': self.column,
            'fieldKind': self.field_kind,
            'isRelation': self.is_relation,
            'relatedModelRefKind': self.related_model_ref_kind,
            'relatedModelRefValue': self.related_model_ref_value,
            'relatedName': self.related_name,
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
            field_kind=str(payload['fieldKind']),
            is_relation=bool(payload['isRelation']),
            related_model_ref_kind=_string_or_none(payload.get('relatedModelRefKind')),
            related_model_ref_value=_string_or_none(payload.get('relatedModelRefValue')),
            related_name=_string_or_none(payload.get('relatedName')),
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
        }

    @classmethod
    def from_dict(cls, payload: dict[str, object]) -> ModuleIndex:
        raw_symbol_definitions = payload.get('symbolDefinitions') or {}
        raw_import_bindings = payload.get('importBindings') or []
        raw_model_candidates = payload.get('modelCandidates') or []
        raw_pending_fields = payload.get('pendingFields') or []
        raw_explicit_all = payload.get('explicitAll')

        if not isinstance(raw_symbol_definitions, dict):
            raise ValueError('Invalid static index cache payload: symbolDefinitions.')

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
        self.fields: list[FieldCandidate] = self._resolve_fields()
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
                    )
                )

        return forward_fields + reverse_fields

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

    for python_file in source_files:
        relative_path = python_file.relative_to(root).as_posix()
        module_name = _module_name_from_path(root, python_file)
        cached_module = cached_modules.get(relative_path)
        if cached_module is not None:
            modules[module_name] = cached_module
            continue

        try:
            file_text = python_file.read_text(encoding='utf-8')
            parsed_module = ast.parse(file_text)
        except (OSError, SyntaxError, UnicodeDecodeError):
            continue

        module_index = _build_module_index(root, python_file, module_name, parsed_module)
        modules[module_name] = module_index

    return _static_index_from_modules(
        python_file_count=len(source_files),
        modules=modules,
    )


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
    pending_fields: list[PendingFieldCandidate] = []
    is_package_init = python_file.name == '__init__.py'

    for node in _iter_indexable_module_nodes(parsed_module.body):
        if isinstance(node, ast.ClassDef):
            defined_symbols.add(node.name)
            symbol_definitions.setdefault(
                node.name,
                _definition_location(str(python_file), node.lineno, node.col_offset),
            )

            if _looks_like_model_candidate(node):
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
                        app_label=module_name.split('.', 1)[0],
                        model_name=node.name,
                        class_node=node,
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
    app_label = module_name.split('.', 1)[0]
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

        field_kind = _field_kind_name(value_node.func)
        if field_kind is None:
            continue

        is_relation = field_kind in {'ForeignKey', 'OneToOneField', 'ManyToManyField'}
        related_model_ref_kind: str | None = None
        related_model_ref_value: str | None = None

        if is_relation and value_node.args:
            related_model_ref_kind, related_model_ref_value = _extract_related_model_reference(
                value_node.args[0],
                app_label=app_label,
            )

        related_name = _extract_keyword_string(value_node, 'related_name')
        fields.append(
            PendingFieldCandidate(
                model_label=model_label,
                model_module=module_name,
                app_label=app_label,
                name=target_name,
                file_path=str(python_file),
                line=node.lineno,
                column=node.col_offset + 1,
                field_kind=field_kind,
                is_relation=is_relation,
                related_model_ref_kind=related_model_ref_kind,
                related_model_ref_value=related_model_ref_value,
                related_name=related_name,
            )
        )

    return fields


def _field_kind_name(function_node: ast.expr) -> str | None:
    name = _dotted_name(function_node)
    if not name:
        return None

    field_name = name.split('.')[-1]
    if field_name.endswith('Field') or field_name == 'ForeignKey':
        return field_name

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


def _is_abstract_model_class(node: ast.ClassDef) -> bool:
    for child in node.body:
        if not isinstance(child, ast.ClassDef) or child.name != 'Meta':
            continue

        for meta_node in child.body:
            value: ast.expr | None = None
            if isinstance(meta_node, ast.Assign):
                for target in meta_node.targets:
                    if isinstance(target, ast.Name) and target.id == 'abstract':
                        value = meta_node.value
                        break
            elif isinstance(meta_node, ast.AnnAssign) and isinstance(meta_node.target, ast.Name):
                if meta_node.target.id == 'abstract':
                    value = meta_node.value

            if isinstance(value, ast.Constant) and value.value is True:
                return True

    return False


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
        or dotted_name.endswith('BaseModel')
        or dotted_name.endswith('JobModel')
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


def _string_or_none(value: object) -> str | None:
    if value is None:
        return None

    return str(value)


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
        source=field.source,
    )


def _static_index_from_modules(
    *,
    python_file_count: int,
    modules: dict[str, ModuleIndex],
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

    return StaticIndex(
        python_file_count=python_file_count,
        package_init_count=package_init_count,
        reexport_module_count=reexport_module_count,
        star_import_count=star_import_count,
        explicit_all_count=explicit_all_count,
        modules=modules,
        model_candidates=model_candidates,
    )
