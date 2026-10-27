import type { FieldInfo, WorkspaceIndex } from './types';

export interface LookupTypePayload {
  fieldKind: string;
  baseKind?: string;
  lookups: string[];
  transforms: Record<string, string | null>;
  runtimeTransforms?: boolean;
  runtimeLookups?: boolean;
  dynamicTransform?: { kind: 'key' | 'index' | 'band'; outputType: string | null; sliceType?: string; blockedNames?: string[] };
}

export interface LookupCatalogPayload {
  types: Record<string, LookupTypePayload>;
  fields: Record<string, Record<string, string>>;
  kinds?: Record<string, string>;
  relationPaths?: Record<string, Record<string, { accessorName: string; queryName: string }>>;
  expressionFields?: Record<string, Record<string, string>>;
}

export type LookupCatalogDelta = Record<string, LookupCatalogPayload | null>;

type CatalogChunks = { base: Record<string, LookupTypePayload>; models: Map<string, Record<string, LookupTypePayload>> };
const catalogChunks = new WeakMap<LookupCatalogPayload, CatalogChunks>();

function chunksFor(catalog?: LookupCatalogPayload): CatalogChunks {
  const cached = catalog && catalogChunks.get(catalog);
  if (cached) return cached;
  const base: Record<string, LookupTypePayload> = Object.create(null);
  const models = new Map<string, Record<string, LookupTypePayload>>();
  for (const [id, type] of Object.entries(catalog?.types ?? {})) {
    if (!id.startsWith('model:')) { base[id] = type; continue; }
    const label = id.slice(6, id.lastIndexOf(':'));
    const chunk = models.get(label) ?? Object.create(null);
    chunk[id] = type;
    models.set(label, chunk);
  }
  const result = { base, models };
  if (catalog) catalogChunks.set(catalog, result);
  return result;
}

function typeTable(chunks: CatalogChunks): Record<string, LookupTypePayload> {
  const read = (id: string): LookupTypePayload | undefined => id.startsWith('model:')
    ? chunks.models.get(id.slice(6, id.lastIndexOf(':')))?.[id]
    : chunks.base[id];
  // Immutable chunk maps keep older snapshots valid. Enumerate the flat wire
  // representation only for complete hydration/cache serialization.
  return new Proxy(Object.create(null) as Record<string, LookupTypePayload>, {
    get: (_, id) => typeof id === 'string' ? read(id) : undefined,
    has: (_, id) => typeof id === 'string' && read(id) !== undefined,
    ownKeys: () => [...Object.keys(chunks.base), ...[...chunks.models.values()].flatMap(Object.keys)],
    getOwnPropertyDescriptor: (_, id) => {
      const value = typeof id === 'string' ? read(id) : undefined;
      return value === undefined ? undefined : { value, enumerable: true, configurable: true };
    },
  });
}

/** Replace bounded per-model descriptor chunks without rehydrating other models. */
export function applyLookupCatalogDelta(index: WorkspaceIndex, delta: LookupCatalogDelta): LookupCatalogPayload {
  const previous = index.lookupCatalog;
  const previousChunks = chunksFor(previous);
  const chunks: CatalogChunks = { base: previousChunks.base, models: new Map(previousChunks.models) };
  const catalog: LookupCatalogPayload = {
    ...previous, types: typeTable(chunks), fields: { ...previous?.fields },
    expressionFields: { ...previous?.expressionFields }, relationPaths: { ...previous?.relationPaths },
  };
  const lookupTypes = index.lookupTypes ?? new Map();
  for (const [label, chunk] of Object.entries(delta)) {
    const prefix = `model:${label}:`;
    for (const id of Object.keys(chunks.models.get(label) ?? {})) lookupTypes.delete(id);
    chunks.models.delete(label);
    delete catalog.fields[label];
    delete catalog.expressionFields![label];
    delete catalog.relationPaths![label];
    if (!chunk) continue;
    const modelTypes: Record<string, LookupTypePayload> = Object.create(null);
    const remap = (id: string | null): string | null => id === null ? null : prefix + id;
    for (const [id, payload] of Object.entries(chunk.types)) {
      const type: LookupTypePayload = {
        ...payload, transforms: Object.fromEntries(Object.entries(payload.transforms).map(([name, target]) => [name, remap(target)])),
      };
      if (payload.dynamicTransform) {
        type.dynamicTransform = { ...payload.dynamicTransform, outputType: remap(payload.dynamicTransform.outputType) };
        if (payload.dynamicTransform.sliceType !== undefined) type.dynamicTransform.sliceType = prefix + payload.dynamicTransform.sliceType;
      }
      modelTypes[prefix + id] = type;
      lookupTypes.set(prefix + id, { name: '', fieldKind: type.fieldKind, isRelation: false,
        lookups: type.lookups, transforms: Object.keys(type.transforms), lookupType: type });
    }
    chunks.models.set(label, modelTypes);
    catalog.fields[label] = Object.fromEntries(Object.entries(chunk.fields[label] ?? {}).map(([name, id]) => [name, prefix + id]));
    catalog.expressionFields![label] = Object.fromEntries(Object.entries(chunk.expressionFields?.[label] ?? {}).map(([name, id]) => [name, prefix + id]));
    catalog.relationPaths![label] = { ...chunk.relationPaths?.[label] };
  }
  catalogChunks.set(catalog, chunks);
  index.lookupCatalog = catalog;
  index.lookupTypes = lookupTypes;
  applyLookupCatalog(index, catalog, Object.keys(delta));
  return catalog;
}

/** Hydrate shared output-field descriptors once per index generation. */
export function applyLookupCatalog(index: WorkspaceIndex, catalog?: LookupCatalogPayload, labels?: string[]): void {
  if (index.lookupCatalog !== catalog || !index.lookupTypes) {
    index.lookupTypes = new Map();
    for (const [id, type] of Object.entries(catalog?.types ?? {})) {
      index.lookupTypes.set(id, {
        name: '', fieldKind: type.fieldKind, isRelation: false,
        lookups: type.lookups, transforms: Object.keys(type.transforms),
        lookupType: type,
      });
    }
    labels = undefined;
  }
  index.lookupCatalog = catalog;
  for (const label of labels ?? Object.keys(catalog?.fields ?? {})) {
    const names = catalog?.fields?.[label];
    if (!names) continue;
    const model = index.models.get(label);
    if (!model) continue;
    for (const [name, paths] of Object.entries(catalog?.relationPaths?.[label] ?? {})) {
      const relation = model.reverseRelations.get(name) ?? model.relations.get(name);
      if (relation) Object.assign(relation, paths);
    }
    for (const [name, id] of Object.entries(names)) {
      const field = model.fields.get(name);
      let type = index.lookupTypes.get(id);
      if (!field || !type) continue;
      const foreignAttname = name.endsWith('_id') && model.relations.has(name.slice(0, -3)) && type.fieldKind === 'ForeignKey';
      const staleScalarType = !field.isRelation && !foreignAttname && field.fieldKind !== 'GeneratedField' && field.fieldKind !== type.fieldKind;
      if (staleScalarType) {
        // A source edit can precede a fresh Django registry snapshot. Keep the
        // current declared kind and use its installed class registry instead.
        const currentId = catalog?.kinds?.[field.fieldKind];
        type = currentId ? index.lookupTypes.get(currentId) : undefined;
        if (!type) continue;
      }
      field.lookups = type.lookups;
      field.transforms = type.transforms;
      field.lookupType = type.lookupType;
      const expressionId = staleScalarType ? undefined : catalog?.expressionFields?.[label]?.[name];
      field.expressionField = expressionId === undefined ? undefined : index.lookupTypes.get(expressionId);
      if (!field.isRelation) field.fieldKind = type.fieldKind;
    }
    // A ready registry is authoritative about whether this model has `id`.
    if (!Object.hasOwn(names, 'id')) model.fields.delete('id');
    index.fieldTrieByModel.delete(label);
  }
}

export function transformedField(field: FieldInfo, name: string, index: WorkspaceIndex): FieldInfo | undefined {
  const type = field.lookupType;
  if (!type) return undefined;
  let id: string | null | undefined = Object.hasOwn(type.transforms, name) ? type.transforms[name] : undefined;
  if (id === undefined && type.dynamicTransform && !type.dynamicTransform.blockedNames?.includes(name)) {
    const dynamic = type.dynamicTransform;
    if (dynamic.kind === 'key' || /^[+-]?\d+$/.test(name)) {
      id = dynamic.outputType;
    } else if (dynamic.kind === 'index' && /^[+-]?\d+_[+-]?\d+$/.test(name)) {
      id = dynamic.sliceType;
    }
  }
  const output = id == null ? undefined : index.lookupTypes?.get(id);
  return output ? { ...output, name } : undefined;
}
