// ============================================================================
// Django ORM Intellisense — Field Lookup & Transform Tables
// ============================================================================

/**
 * Maps Django field class names to their applicable lookup expressions.
 */
export const FIELD_LOOKUPS: Record<string, string[]> = {
  // String fields — Django allows lexicographic ordering via gt/gte/lt/lte
  'CharField': ['exact', 'iexact', 'contains', 'icontains', 'startswith', 'istartswith', 'endswith', 'iendswith', 'in', 'gt', 'gte', 'lt', 'lte', 'range', 'regex', 'iregex', 'isnull'],
  'TextField': ['exact', 'iexact', 'contains', 'icontains', 'startswith', 'istartswith', 'endswith', 'iendswith', 'in', 'gt', 'gte', 'lt', 'lte', 'range', 'regex', 'iregex', 'isnull'],
  'SlugField': ['exact', 'iexact', 'contains', 'icontains', 'startswith', 'istartswith', 'endswith', 'iendswith', 'in', 'gt', 'gte', 'lt', 'lte', 'range', 'regex', 'iregex', 'isnull'],
  'URLField': ['exact', 'iexact', 'contains', 'icontains', 'startswith', 'istartswith', 'endswith', 'iendswith', 'in', 'gt', 'gte', 'lt', 'lte', 'range', 'regex', 'iregex', 'isnull'],
  'EmailField': ['exact', 'iexact', 'contains', 'icontains', 'startswith', 'istartswith', 'endswith', 'iendswith', 'in', 'gt', 'gte', 'lt', 'lte', 'range', 'regex', 'iregex', 'isnull'],
  'FilePathField': ['exact', 'iexact', 'contains', 'icontains', 'startswith', 'istartswith', 'endswith', 'iendswith', 'in', 'gt', 'gte', 'lt', 'lte', 'range', 'regex', 'iregex', 'isnull'],
  'UUIDField': ['exact', 'in', 'isnull'],
  'GenericIPAddressField': ['exact', 'iexact', 'contains', 'icontains', 'startswith', 'istartswith', 'endswith', 'iendswith', 'in', 'gt', 'gte', 'lt', 'lte', 'isnull'],

  // Numeric fields
  'IntegerField': ['exact', 'gt', 'gte', 'lt', 'lte', 'in', 'range', 'isnull'],
  'BigIntegerField': ['exact', 'gt', 'gte', 'lt', 'lte', 'in', 'range', 'isnull'],
  'SmallIntegerField': ['exact', 'gt', 'gte', 'lt', 'lte', 'in', 'range', 'isnull'],
  'PositiveIntegerField': ['exact', 'gt', 'gte', 'lt', 'lte', 'in', 'range', 'isnull'],
  'PositiveSmallIntegerField': ['exact', 'gt', 'gte', 'lt', 'lte', 'in', 'range', 'isnull'],
  'PositiveBigIntegerField': ['exact', 'gt', 'gte', 'lt', 'lte', 'in', 'range', 'isnull'],
  'FloatField': ['exact', 'gt', 'gte', 'lt', 'lte', 'in', 'range', 'isnull'],
  'DecimalField': ['exact', 'gt', 'gte', 'lt', 'lte', 'in', 'range', 'isnull'],
  'AutoField': ['exact', 'gt', 'gte', 'lt', 'lte', 'in', 'range', 'isnull'],
  'BigAutoField': ['exact', 'gt', 'gte', 'lt', 'lte', 'in', 'range', 'isnull'],
  'SmallAutoField': ['exact', 'gt', 'gte', 'lt', 'lte', 'in', 'range', 'isnull'],

  // Date/Time fields
  'DateField': ['exact', 'gt', 'gte', 'lt', 'lte', 'in', 'range', 'year', 'month', 'day', 'week', 'week_day', 'iso_year', 'iso_week_day', 'quarter', 'isnull'],
  'DateTimeField': ['exact', 'gt', 'gte', 'lt', 'lte', 'in', 'range', 'year', 'month', 'day', 'week', 'week_day', 'iso_year', 'iso_week_day', 'quarter', 'hour', 'minute', 'second', 'date', 'time', 'isnull'],
  'TimeField': ['exact', 'gt', 'gte', 'lt', 'lte', 'in', 'range', 'hour', 'minute', 'second', 'isnull'],
  'DurationField': ['exact', 'gt', 'gte', 'lt', 'lte', 'in', 'range', 'isnull'],

  // Boolean
  'BooleanField': ['exact', 'isnull'],
  'NullBooleanField': ['exact', 'isnull'],

  // Relation fields
  'ForeignKey': ['exact', 'in', 'isnull', 'gt', 'gte', 'lt', 'lte'],
  'OneToOneField': ['exact', 'in', 'isnull', 'gt', 'gte', 'lt', 'lte'],
  'ManyToManyField': ['exact', 'in', 'isnull'],

  // JSON
  'JSONField': ['exact', 'isnull', 'contains', 'contained_by', 'has_key', 'has_keys', 'has_any_keys'],

  // Binary
  'BinaryField': ['exact', 'isnull'],

  // File
  'FileField': ['exact', 'iexact', 'contains', 'icontains', 'startswith', 'endswith', 'in', 'isnull'],
  'ImageField': ['exact', 'iexact', 'contains', 'icontains', 'startswith', 'endswith', 'in', 'isnull'],
};

/**
 * Common transforms that can be chained before a final lookup.
 * Each transform converts a field into an output field kind, and is only
 * applicable to certain input field kinds.
 */
// Only DATE/TIME extract transforms are Django built-ins. String transforms
// (lower/upper/length/trim/...) are NOT registered by default — they exist only
// as Func expressions or after an explicit Field.register_lookup(...). Listing
// them made the static fast path FALSELY resolve `name__lower__icontains` etc.
// that real Django rejects with FieldError. Custom-registered ones flow through
// the runtime path instead. (Verified vs Django 5.2.)
export const FIELD_TRANSFORMS: Record<string, { outputFieldKind: string; applicableFieldKinds: string[] }> = {
  'year': { outputFieldKind: 'IntegerField', applicableFieldKinds: ['DateField', 'DateTimeField'] },
  'month': { outputFieldKind: 'IntegerField', applicableFieldKinds: ['DateField', 'DateTimeField'] },
  'day': { outputFieldKind: 'IntegerField', applicableFieldKinds: ['DateField', 'DateTimeField'] },
  'hour': { outputFieldKind: 'IntegerField', applicableFieldKinds: ['TimeField', 'DateTimeField'] },
  'minute': { outputFieldKind: 'IntegerField', applicableFieldKinds: ['TimeField', 'DateTimeField'] },
  'second': { outputFieldKind: 'IntegerField', applicableFieldKinds: ['TimeField', 'DateTimeField'] },
  'date': { outputFieldKind: 'DateField', applicableFieldKinds: ['DateTimeField'] },
  'time': { outputFieldKind: 'TimeField', applicableFieldKinds: ['DateTimeField'] },
  'week': { outputFieldKind: 'IntegerField', applicableFieldKinds: ['DateField', 'DateTimeField'] },
  'week_day': { outputFieldKind: 'IntegerField', applicableFieldKinds: ['DateField', 'DateTimeField'] },
  'quarter': { outputFieldKind: 'IntegerField', applicableFieldKinds: ['DateField', 'DateTimeField'] },
  'iso_year': { outputFieldKind: 'IntegerField', applicableFieldKinds: ['DateField', 'DateTimeField'] },
  'iso_week_day': { outputFieldKind: 'IntegerField', applicableFieldKinds: ['DateField', 'DateTimeField'] },
};

/** Default lookups for unknown or unrecognized field types. */
export const DEFAULT_LOOKUPS = ['exact', 'in', 'isnull', 'gt', 'gte', 'lt', 'lte'];

// ============================================================================
// Field-kind -> Python type mapping
// ----------------------------------------------------------------------------
// SINGLE SOURCE OF TRUTH (mirrored verbatim in two other files — keep in sync):
//   - python/django_orm_intellisense/features/field_types.py  (FIELD_KIND_PYTHON_TYPE)
//   - crates/core/src/static_index/types.rs                   (FIELD_KIND_PYTHON_TYPE)
// A parity test (python/tests/test_field_type_table_parity.py) asserts the
// three copies stay identical. Relation kinds map to 'Any' here; the terminal
// type of a relation is surfaced via the related model, not this table.
// ============================================================================
export const FIELD_KIND_PYTHON_TYPE: Record<string, string> = {
  // String-like
  CharField: 'str',
  TextField: 'str',
  SlugField: 'str',
  URLField: 'str',
  EmailField: 'str',
  FilePathField: 'str',
  GenericIPAddressField: 'str',
  IPAddressField: 'str',
  CommaSeparatedIntegerField: 'str',
  FileField: 'str',
  ImageField: 'str',
  // Integer-like
  IntegerField: 'int',
  BigIntegerField: 'int',
  SmallIntegerField: 'int',
  PositiveIntegerField: 'int',
  PositiveSmallIntegerField: 'int',
  PositiveBigIntegerField: 'int',
  AutoField: 'int',
  BigAutoField: 'int',
  SmallAutoField: 'int',
  // Real numbers
  FloatField: 'float',
  DecimalField: 'decimal.Decimal',
  // Boolean
  BooleanField: 'bool',
  NullBooleanField: 'bool',
  // Date/time
  DateField: 'datetime.date',
  DateTimeField: 'datetime.datetime',
  TimeField: 'datetime.time',
  DurationField: 'datetime.timedelta',
  // Misc scalars
  UUIDField: 'uuid.UUID',
  JSONField: 'Any',
  BinaryField: 'bytes',
  // Computed — value type is the output_field, not statically knowable.
  GeneratedField: 'Any',
  // Relations — terminal type is the related model, not a scalar python type.
  ForeignKey: 'Any',
  OneToOneField: 'Any',
  ManyToManyField: 'Any',
};

/**
 * Map a Django field-class name to its concrete Python type for display.
 * Falls back to 'Any' for custom or unrecognized field kinds.
 */
export function pythonTypeForKind(fieldKind: string): string {
  return FIELD_KIND_PYTHON_TYPE[fieldKind] ?? 'Any';
}

/**
 * Compute the Python type of the OPERAND (the comparison value) for a lookup
 * operator applied to a field whose python type is `fieldPythonType`.
 *
 * Advisory only — surfaced in hover/completion detail, never enforced.
 */
export function operandPythonType(
  lookupOperator: string,
  fieldPythonType: string
): string {
  switch (lookupOperator) {
    case 'isnull':
      return 'bool';
    case 'in':
      return `list[${fieldPythonType}]`;
    case 'range':
      return `tuple[${fieldPythonType}, ${fieldPythonType}]`;
    // JSONField key lookups: operand is the key name(s), not the value type.
    case 'has_key':
      return 'str';
    case 'has_keys':
    case 'has_any_keys':
      return 'list[str]';
    case 'contains':
    case 'icontains':
    case 'startswith':
    case 'istartswith':
    case 'endswith':
    case 'iendswith':
    case 'regex':
    case 'iregex':
      // NOTE: iexact is intentionally omitted — it is registered on non-text
      // fields too, so its operand is the field's own type (falls through).
      return 'str';
    case 'year':
    case 'month':
    case 'day':
    case 'week':
    case 'week_day':
    case 'iso_year':
    case 'iso_week_day':
    case 'quarter':
    case 'hour':
    case 'minute':
    case 'second':
      return 'int';
    case 'date':
      return 'datetime.date';
    case 'time':
      return 'datetime.time';
    default:
      // exact / gt / gte / lt / lte and anything else compare against the
      // field's own type.
      return fieldPythonType;
  }
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Returns the applicable lookup expressions for a given Django field kind.
 * Falls back to DEFAULT_LOOKUPS for unrecognized field types.
 */
export function getLookupsForField(fieldKind: string): string[] {
  return FIELD_LOOKUPS[fieldKind] ?? DEFAULT_LOOKUPS;
}

/**
 * Returns the names of transforms applicable to the given field kind.
 */
export function getTransformsForField(fieldKind: string): string[] {
  const result: string[] = [];
  for (const [name, info] of Object.entries(FIELD_TRANSFORMS)) {
    if (info.applicableFieldKinds.includes(fieldKind)) {
      result.push(name);
    }
  }
  return result;
}

/**
 * Returns the output field kind produced by a given transform,
 * or undefined if the transform name is not recognized.
 */
export function getTransformOutputKind(transformName: string): string | undefined {
  return FIELD_TRANSFORMS[transformName]?.outputFieldKind;
}
