// Django Aggregate.default_alias uses the sole source expression's name and
// the aggregate's name. Complex expressions must have an explicit alias.
const DEFAULT_ALIAS_AGGREGATES = new Set([
  'Count', 'Sum', 'Avg', 'Min', 'Max', 'StdDev', 'Variance',
  'ArrayAgg', 'JSONBAgg', 'StringAgg', 'BitAnd', 'BitOr', 'BitXor', 'BoolAnd', 'BoolOr',
]);

export function defaultAggregateAlias(aggregate: string, source: string): string | undefined {
  if (!DEFAULT_ALIAS_AGGREGATES.has(aggregate) || source === '*' || !source) return undefined;
  return `${source}__${aggregate.toLowerCase()}`;
}

export function matchAnnotationAlias<T extends { name: string }>(
  fields: readonly T[], path: string,
): { field: T; suffix: string } | undefined {
  let field: T | undefined;
  for (const candidate of fields) {
    if ((!field || candidate.name.length > field.name.length) &&
        (path === candidate.name || path.startsWith(`${candidate.name}__`))) {
      field = candidate;
    }
  }
  return field ? { field, suffix: path.slice(field.name.length) } : undefined;
}

// The lookup parser receives one scalar root. The original alias can contain
// separators (e.g. author__age__sum) and is matched before parsing its suffix.
export const ANNOTATION_ROOT = 'annotation_value';
