"""Single source of truth for Django field-kind -> Python type mapping,
built-in transform output kinds, and lookup-operand typing.

SINGLE SOURCE OF TRUTH (mirrored verbatim in two other files — keep in sync):
  - src/server/fieldLookups.ts          (FIELD_KIND_PYTHON_TYPE / FIELD_TRANSFORMS)
  - crates/core/src/static_index/types.rs (FIELD_KIND_PYTHON_TYPE)
  - crates/core/src/features/lookup_paths.rs (FIELD_TRANSFORMS)

A parity test (python/tests/test_field_type_table_parity.py) parses the TS and
Rust copies and asserts they stay identical to the tables here.

These static tables make the Rust/TS/Python fast path self-sufficient for
Django built-ins, so terminal-type inference works even when the live runtime
field registry is unavailable (e.g. the registry-build lock timeout window).
Runtime introspection remains the precise override for custom fields and
custom transforms registered via ``Field.register_lookup``.
"""

from __future__ import annotations

# Django field-class name -> concrete Python type (display string).
# Relation kinds map to 'Any'; a relation terminal's type is surfaced via the
# related model, not this table.
FIELD_KIND_PYTHON_TYPE: dict[str, str] = {
    # String-like
    'CharField': 'str',
    'TextField': 'str',
    'SlugField': 'str',
    'URLField': 'str',
    'EmailField': 'str',
    'FilePathField': 'str',
    'GenericIPAddressField': 'str',
    'IPAddressField': 'str',
    'CommaSeparatedIntegerField': 'str',
    'FileField': 'str',
    'ImageField': 'str',
    # Integer-like
    'IntegerField': 'int',
    'BigIntegerField': 'int',
    'SmallIntegerField': 'int',
    'PositiveIntegerField': 'int',
    'PositiveSmallIntegerField': 'int',
    'PositiveBigIntegerField': 'int',
    'AutoField': 'int',
    'BigAutoField': 'int',
    'SmallAutoField': 'int',
    # Real numbers
    'FloatField': 'float',
    'DecimalField': 'decimal.Decimal',
    # Boolean
    'BooleanField': 'bool',
    'NullBooleanField': 'bool',
    # Date/time
    'DateField': 'datetime.date',
    'DateTimeField': 'datetime.datetime',
    'TimeField': 'datetime.time',
    'DurationField': 'datetime.timedelta',
    # Misc scalars
    'UUIDField': 'uuid.UUID',
    'JSONField': 'Any',
    'BinaryField': 'bytes',
    # Computed — value type is the output_field, not statically knowable.
    'GeneratedField': 'Any',
    # Relations
    'ForeignKey': 'Any',
    'OneToOneField': 'Any',
    'ManyToManyField': 'Any',
}

# Built-in transform name -> {output field kind, applicable input field kinds}.
# Mirrors FIELD_TRANSFORMS in src/server/fieldLookups.ts verbatim.
#
# Only DATE/TIME extract transforms are Django built-ins. String transforms
# (lower/upper/length/trim/...) are NOT registered by default — they exist only
# as Func expressions (functions.Lower/Upper/Length) or after an explicit
# Field.register_lookup(...). Listing them here made the static fast path
# FALSELY resolve chains like `name__lower__icontains` that real Django rejects
# with FieldError (verified: CharField().get_transform('lower') is None on
# Django 5.2). Custom-registered ones flow through the runtime path instead.
FIELD_TRANSFORMS: dict[str, dict[str, object]] = {
    'year': {'outputFieldKind': 'IntegerField', 'applicableFieldKinds': ['DateField', 'DateTimeField']},
    'month': {'outputFieldKind': 'IntegerField', 'applicableFieldKinds': ['DateField', 'DateTimeField']},
    'day': {'outputFieldKind': 'IntegerField', 'applicableFieldKinds': ['DateField', 'DateTimeField']},
    'hour': {'outputFieldKind': 'IntegerField', 'applicableFieldKinds': ['TimeField', 'DateTimeField']},
    'minute': {'outputFieldKind': 'IntegerField', 'applicableFieldKinds': ['TimeField', 'DateTimeField']},
    'second': {'outputFieldKind': 'IntegerField', 'applicableFieldKinds': ['TimeField', 'DateTimeField']},
    'date': {'outputFieldKind': 'DateField', 'applicableFieldKinds': ['DateTimeField']},
    'time': {'outputFieldKind': 'TimeField', 'applicableFieldKinds': ['DateTimeField']},
    'week': {'outputFieldKind': 'IntegerField', 'applicableFieldKinds': ['DateField', 'DateTimeField']},
    'week_day': {'outputFieldKind': 'IntegerField', 'applicableFieldKinds': ['DateField', 'DateTimeField']},
    'quarter': {'outputFieldKind': 'IntegerField', 'applicableFieldKinds': ['DateField', 'DateTimeField']},
    'iso_year': {'outputFieldKind': 'IntegerField', 'applicableFieldKinds': ['DateField', 'DateTimeField']},
    'iso_week_day': {'outputFieldKind': 'IntegerField', 'applicableFieldKinds': ['DateField', 'DateTimeField']},
}

_TEXT_OPERAND_LOOKUPS = {
    'contains', 'icontains', 'startswith', 'istartswith',
    'endswith', 'iendswith', 'regex', 'iregex',
    # NOTE: iexact is intentionally NOT here — it is registered on non-text
    # fields too (IntegerField/UUIDField/DecimalField/DateField/...), so its
    # operand is the field's own type, not always str. It falls through.
}
_INT_OPERAND_LOOKUPS = {
    'year', 'month', 'day', 'week', 'week_day', 'iso_year',
    'iso_week_day', 'quarter', 'hour', 'minute', 'second',
}


def python_type_for_kind(field_kind: str | None) -> str:
    """Django field-class name -> Python display type. 'Any' for unknown."""
    if not field_kind:
        return 'Any'
    return FIELD_KIND_PYTHON_TYPE.get(field_kind, 'Any')


def transform_output_kind(transform_name: str, input_kind: str | None) -> str | None:
    """Static output field kind for a built-in transform applied to
    ``input_kind``. Returns None if the transform is unknown or not
    applicable to that input kind."""
    entry = FIELD_TRANSFORMS.get(transform_name)
    if entry is None:
        return None
    applicable = entry.get('applicableFieldKinds') or []
    if input_kind is not None and isinstance(applicable, list) and input_kind not in applicable:
        return None
    output = entry.get('outputFieldKind')
    return str(output) if output else None


def operand_python_type(lookup_operator: str, field_python_type: str) -> str:
    """Python type of the comparison value for ``lookup_operator`` on a field
    whose python type is ``field_python_type``. Advisory only."""
    if lookup_operator == 'isnull':
        return 'bool'
    if lookup_operator == 'in':
        return f'list[{field_python_type}]'
    if lookup_operator == 'range':
        return f'tuple[{field_python_type}, {field_python_type}]'
    # JSONField key lookups: operand is the key name(s), independent of the
    # field's value type.
    if lookup_operator == 'has_key':
        return 'str'
    if lookup_operator in {'has_keys', 'has_any_keys'}:
        return 'list[str]'
    if lookup_operator in _TEXT_OPERAND_LOOKUPS:
        return 'str'
    if lookup_operator in _INT_OPERAND_LOOKUPS:
        return 'int'
    if lookup_operator == 'date':
        return 'datetime.date'
    if lookup_operator == 'time':
        return 'datetime.time'
    # exact / gt / gte / lt / lte and anything else compare against the field.
    return field_python_type
