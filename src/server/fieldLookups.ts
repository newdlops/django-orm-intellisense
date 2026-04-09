// ============================================================================
// Django ORM Intellisense — Field Lookup & Transform Tables
// ============================================================================

/**
 * Maps Django field class names to their applicable lookup expressions.
 */
export const FIELD_LOOKUPS: Record<string, string[]> = {
  // String fields
  'CharField': ['exact', 'iexact', 'contains', 'icontains', 'startswith', 'istartswith', 'endswith', 'iendswith', 'in', 'regex', 'iregex', 'isnull'],
  'TextField': ['exact', 'iexact', 'contains', 'icontains', 'startswith', 'istartswith', 'endswith', 'iendswith', 'in', 'regex', 'iregex', 'isnull'],
  'SlugField': ['exact', 'iexact', 'contains', 'icontains', 'startswith', 'istartswith', 'endswith', 'iendswith', 'in', 'regex', 'iregex', 'isnull'],
  'URLField': ['exact', 'iexact', 'contains', 'icontains', 'startswith', 'istartswith', 'endswith', 'iendswith', 'in', 'regex', 'iregex', 'isnull'],
  'EmailField': ['exact', 'iexact', 'contains', 'icontains', 'startswith', 'istartswith', 'endswith', 'iendswith', 'in', 'regex', 'iregex', 'isnull'],
  'FilePathField': ['exact', 'iexact', 'contains', 'icontains', 'startswith', 'istartswith', 'endswith', 'iendswith', 'in', 'regex', 'iregex', 'isnull'],
  'UUIDField': ['exact', 'in', 'isnull'],
  'GenericIPAddressField': ['exact', 'iexact', 'contains', 'icontains', 'startswith', 'istartswith', 'endswith', 'iendswith', 'in', 'isnull'],

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
export const FIELD_TRANSFORMS: Record<string, { outputFieldKind: string; applicableFieldKinds: string[] }> = {
  'lower': { outputFieldKind: 'CharField', applicableFieldKinds: ['CharField', 'TextField', 'SlugField', 'URLField', 'EmailField'] },
  'upper': { outputFieldKind: 'CharField', applicableFieldKinds: ['CharField', 'TextField', 'SlugField', 'URLField', 'EmailField'] },
  'length': { outputFieldKind: 'IntegerField', applicableFieldKinds: ['CharField', 'TextField', 'SlugField', 'URLField', 'EmailField'] },
  'trim': { outputFieldKind: 'CharField', applicableFieldKinds: ['CharField', 'TextField'] },
  'ltrim': { outputFieldKind: 'CharField', applicableFieldKinds: ['CharField', 'TextField'] },
  'rtrim': { outputFieldKind: 'CharField', applicableFieldKinds: ['CharField', 'TextField'] },
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
