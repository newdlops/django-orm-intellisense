"""Private, full-value static module records for static cache format 2."""
from ..static_index.class_members import SourceMemberDeclarations
from ..static_index.indexer import (
    DefinitionLocation, ImportBinding, ModelCandidate, ModuleIndex,
    PendingFieldCandidate, _string_or_none,
)

# These fixed positions belong to static format 2. Changing their order or
# dropping any value requires another format version.
MODULE_ROW_KEYS = (
    'moduleName', 'filePath', 'isPackageInit', 'definedSymbols', 'symbolDefinitions',
    'importBindings', 'explicitAll', 'modelCandidates', 'pendingFields',
    'classBaseRefs', 'fieldClassNames', 'fieldAliases', 'constructorImports',
    'sourceMemberDeclarations',
)
PENDING_ROW_KEYS = (
    'modelLabel', 'modelModule', 'appLabel', 'name', 'filePath', 'line', 'column',
    'fieldCallRef', 'fieldKind', 'isRelation', 'relatedModelRefKind',
    'relatedModelRefValue', 'relatedName', 'relatedQueryName',
    'constructorFingerprint', 'constructorImports', 'hasPrimaryKeyOption',
)
_PENDING_STRING_POSITIONS = (0, 1, 2, 3, 4, 7, 8, 10, 11, 14)


def module_to_row(module):
    return [module.module_name, module.file_path, module.is_package_init,
        sorted(module.defined_symbols),
        {symbol: location.to_dict() for symbol, location in module.symbol_definitions.items()},
        [binding.to_dict() for binding in module.import_bindings],
        list(module.explicit_all) if module.explicit_all is not None else None,
        [candidate.to_dict() for candidate in module.model_candidates],
        [[field.model_label, field.model_module, field.app_label, field.name,
            field.file_path, field.line, field.column, field.field_call_ref,
            field.field_kind, field.is_relation, field.related_model_ref_kind,
            field.related_model_ref_value, field.related_name, field.related_query_name,
            field.constructor_fingerprint, list(field.constructor_imports),
            field.has_primary_key_option] for field in module.pending_fields],
        {name: list(values) for name, values in module.class_base_refs.items()},
        list(module.field_class_names), dict(module.field_aliases), list(module.constructor_imports),
        module.source_member_declarations.to_dict() if module.source_member_declarations is not None else None]


def _validate_module_row(row):
    if not isinstance(row, list) or len(row) != len(MODULE_ROW_KEYS):
        raise ValueError('invalid static module cache row')


def _validate_pending_row(row):
    if len(row) != len(PENDING_ROW_KEYS):
        raise ValueError('invalid static pending field cache row')


def _share_positions(row, positions, share):
    for position in positions:
        item = row[position]
        if type(item) is str:
            row[position] = share(item, item)


def _pending_from_row(row, share):
    _validate_pending_row(row)
    if share is not None:
        _share_positions(row, _PENDING_STRING_POSITIONS, share)
    return PendingFieldCandidate(
        str(row[0]), str(row[1]), str(row[2]),
        str(row[3]), str(row[4]), int(row[5]), int(row[6]),
        str(row[7]), str(row[8]), bool(row[9]),
        _string_or_none(row[10]),
        _string_or_none(row[11]),
        _string_or_none(row[12]), _string_or_none(row[13]),
        _string_or_none(row[14]),
        tuple(str(value) for value in row[15]),
        bool(row[16]),
    )


def module_from_row(row, share):
    _validate_module_row(row)
    if share is not None:
        _share_positions(row, (0, 1), share)
    definitions, aliases = row[4] or {}, row[11] or {}
    if not isinstance(definitions, dict):
        raise ValueError('Invalid static index cache payload: symbolDefinitions.')
    if not isinstance(aliases, dict):
        raise ValueError('Invalid static index cache payload: fieldAliases.')
    pending_fields = row[8]
    if not isinstance(pending_fields, list):
        raise ValueError('invalid static pending fields cache container')
    return ModuleIndex(
        str(row[0]), str(row[1]), bool(row[2]),
        {str(symbol) for symbol in row[3]},
        {str(symbol): DefinitionLocation.from_dict(dict(location))
            for symbol, location in definitions.items() if isinstance(location, dict)},
        [ImportBinding.from_dict(dict(binding)) for binding in (row[5] or [])
            if isinstance(binding, dict)],
        [str(symbol) for symbol in row[6]] if isinstance(row[6], list) else None,
        [ModelCandidate.from_dict(dict(candidate)) for candidate in (row[7] or [])
            if isinstance(candidate, dict)],
        [_pending_from_row(field, share) if isinstance(field, list)
            else PendingFieldCandidate.from_dict(dict(field)) for field in pending_fields],
        {str(name): tuple(str(value) for value in values)
            for name, values in (row[9] or {}).items() if isinstance(values, list)},
        tuple(str(name) for name in row[10]),
        {str(alias): str(kind) for alias, kind in aliases.items()},
        tuple(str(value) for value in row[12]),
        SourceMemberDeclarations.from_dict(row[13]),
    )


def module_row_to_dict(row, share):
    _validate_module_row(row)
    result = dict(zip(MODULE_ROW_KEYS, row))
    for position in (0, 1):
        item = row[position]
        if type(item) is str:
            result[MODULE_ROW_KEYS[position]] = share(item, item)
    if isinstance(row[8], list):
        fields = []
        for field in row[8]:
            if isinstance(field, list) and len(field) == len(PENDING_ROW_KEYS):
                value = dict(zip(PENDING_ROW_KEYS, field))
                for position in _PENDING_STRING_POSITIONS:
                    item = field[position]
                    if type(item) is str:
                        value[PENDING_ROW_KEYS[position]] = share(item, item)
                fields.append(value)
            else:
                fields.append(field)
        result['pendingFields'] = fields
    if row[13] is None:
        result.pop('sourceMemberDeclarations')
    return result


def pool_static_row_strings(value, share):
    # This changes only immutable string identity, never JSON shapes or
    # hydration. A C-decoded row must share with dictionary metadata in the
    # same read before the decoder's pool is released.
    rows = value.get('moduleRows')
    values = rows.values() if isinstance(rows, dict) else (value.get('moduleRow'),)
    for row in values:
        if not isinstance(row, list) or len(row) != len(MODULE_ROW_KEYS):
            continue
        _share_positions(row, (0, 1), share)
        if isinstance(row[8], list):
            for field in row[8]:
                if isinstance(field, list) and len(field) == len(PENDING_ROW_KEYS):
                    _share_positions(field, _PENDING_STRING_POSITIONS, share)


def expand_static_rows(payload, *, full):
    metadata, cached = payload.get('metadata'), payload.get('payload')
    if not (isinstance(metadata, dict) and metadata.get('staticIndexVersion') == 2
            and isinstance(cached, dict)):
        return
    strings = {}
    try:
        if full and isinstance(cached.get('moduleRows'), dict):
            cached['modules'] = {name: module_row_to_dict(value, strings.setdefault)
                if isinstance(value, list) and len(value) == len(MODULE_ROW_KEYS) else value
                for name, value in cached.pop('moduleRows').items()}
        elif not full and isinstance(cached.get('moduleEntries'), dict):
            for entry in cached['moduleEntries'].values():
                if isinstance(entry, dict) and 'moduleRow' in entry:
                    value = entry.pop('moduleRow')
                    entry['moduleIndex'] = (module_row_to_dict(value, strings.setdefault)
                        if isinstance(value, list) and len(value) == len(MODULE_ROW_KEYS) else value)
    finally:
        strings.clear()
