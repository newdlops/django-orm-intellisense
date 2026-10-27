// ============================================================================
// Django ORM Intellisense — Workspace Indexer
// ============================================================================
//
// Bridges the existing Python daemon's surfaceIndex to the WorkspaceIndex
// format used by the language server.
// ============================================================================

import {
  WorkspaceIndex,
  ModelInfo,
  FieldInfo,
  RelationInfo,
  FileIndexEntry,
  LookupInfo,
  TransformInfo,
  RadixTrieNode,
} from './types.js';
import {
  FIELD_LOOKUPS,
  FIELD_TRANSFORMS,
  getLookupsForField,
  getTransformsForField,
} from './fieldLookups.js';
import { recordTiming, incrementCounter } from './perfTracker.js';
import { applyLookupCatalog, type LookupCatalogPayload } from './lookupCatalog.js';

// ---------------------------------------------------------------------------
// Radix Trie helpers (minimal implementation against RadixTrieNode<T>)
// ---------------------------------------------------------------------------

function createTrieNode<T>(): RadixTrieNode<T> {
  return { children: new Map(), isTerminal: false };
}

/**
 * Insert a key/payload into a radix trie.
 *
 * This is a compressed trie: edge labels can be multi-character strings.
 * When a new key shares a prefix with an existing edge label the edge is
 * split so that the shared prefix becomes a separate internal node.
 */
function trieInsert<T>(root: RadixTrieNode<T>, key: string, payload: T): void {
  let node = root;
  let remaining = key;

  while (remaining.length > 0) {
    const firstChar = remaining[0];
    const edge = node.children.get(firstChar);

    if (!edge) {
      // No edge starting with this character — create a new leaf.
      const leaf: RadixTrieNode<T> = {
        children: new Map(),
        payload,
        isTerminal: true,
      };
      node.children.set(firstChar, { label: remaining, child: leaf });
      return;
    }

    // Find the longest common prefix between `remaining` and the edge label.
    const label = edge.label;
    let commonLen = 0;
    while (
      commonLen < remaining.length &&
      commonLen < label.length &&
      remaining[commonLen] === label[commonLen]
    ) {
      commonLen++;
    }

    if (commonLen === label.length) {
      // The edge label is fully consumed — descend into the child.
      remaining = remaining.slice(commonLen);
      node = edge.child;
      if (remaining.length === 0) {
        // Exact match on this node.
        node.payload = payload;
        node.isTerminal = true;
        return;
      }
      continue;
    }

    // Partial match — split the edge.
    const sharedPrefix = label.slice(0, commonLen);
    const oldSuffix = label.slice(commonLen);
    const newSuffix = remaining.slice(commonLen);

    // Create an internal split node.
    const splitNode: RadixTrieNode<T> = { children: new Map(), isTerminal: false };

    // Re-attach the original child under the old suffix.
    splitNode.children.set(oldSuffix[0], { label: oldSuffix, child: edge.child });

    if (newSuffix.length === 0) {
      // The new key ends exactly at the split point.
      splitNode.payload = payload;
      splitNode.isTerminal = true;
    } else {
      // Create a new leaf for the remaining part of the new key.
      const leaf: RadixTrieNode<T> = {
        children: new Map(),
        payload,
        isTerminal: true,
      };
      splitNode.children.set(newSuffix[0], { label: newSuffix, child: leaf });
    }

    // Replace the original edge with the split node.
    node.children.set(firstChar, { label: sharedPrefix, child: splitNode });
    return;
  }

  // Empty remaining — mark current node as terminal.
  node.payload = payload;
  node.isTerminal = true;
}

// ---------------------------------------------------------------------------
// Field kind heuristics
// ---------------------------------------------------------------------------

/** Relation field class names that Django ships. */
const RELATION_FIELD_KINDS = new Set([
  'ForeignKey',
  'OneToOneField',
  'ManyToManyField',
  'GenericForeignKey',
  'GenericRelatedObjectManager',
]);

/**
 * Infer a best-effort Django field kind from a surfaceIndex entry.
 *
 * The Python daemon stores entries as
 * `[returnKind, returnModelLabel, memberKind?, fieldKind?]` where:
 *   - returnKind is one of "scalar", "instance", "related_manager",
 *     "queryset", "model_class", "manager", or null
 *   - returnModelLabel is the related model label (for relations) or the
 *     owner model label (for scalar fields / methods)
 */
function inferFieldKind(returnKind: string | null): { fieldKind: string; isRelation: boolean } {
  if (returnKind === 'related_manager') {
    return { fieldKind: 'ManyToManyField', isRelation: true };
  }
  if (returnKind === 'instance') {
    return { fieldKind: 'ForeignKey', isRelation: true };
  }
  return { fieldKind: 'CharField', isRelation: false };
}

/**
 * Try to extract a target model label from a surfaceIndex entry.
 */
function extractTargetModel(returnKind: string | null, returnModelLabel: string | null): string | undefined {
  if (returnKind === 'instance' || returnKind === 'related_manager') {
    return returnModelLabel ?? undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Build the global lookup and transform tries
// ---------------------------------------------------------------------------

function buildLookupTrie(customLookups?: Record<string, string[]>): RadixTrieNode<LookupInfo> {
  const root = createTrieNode<LookupInfo>();
  const byName = new Map<string, LookupInfo>();
  for (const [table, source] of [[FIELD_LOOKUPS, 'builtin'], [customLookups ?? {}, 'custom']] as const) {
    for (const [kind, names] of Object.entries(table)) {
      for (const name of names) {
        if (source === 'builtin' && getTransformsForField(kind).includes(name)) continue;
        const info = byName.get(name) ?? { name, applicableFieldKinds: [], source };
        if (!info.applicableFieldKinds.includes(kind)) info.applicableFieldKinds.push(kind);
        byName.set(name, info);
      }
    }
  }
  for (const [name, info] of byName) trieInsert(root, name, info);

  return root;
}

function buildTransformTrie(): RadixTrieNode<TransformInfo> {
  const root = createTrieNode<TransformInfo>();

  for (const [name, meta] of Object.entries(FIELD_TRANSFORMS)) {
    const info: TransformInfo = {
      name,
      outputFieldKind: meta.outputFieldKind,
      applicableFieldKinds: meta.applicableFieldKinds,
      source: 'builtin',
    };
    trieInsert(root, name, info);
  }

  return root;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Surface index shape coming from the Python daemon.
 *
 * Structure: `{ [modelLabel]: { [receiverKind]: { [memberName]: SurfaceMemberTuple } } }`
 *
 * Receiver kinds include "instance", "model_class", "manager", etc.
 */
export type SurfaceMemberTuple = [
  returnKind: string,
  returnModelLabel: string | null,
  memberKind?: string,
  fieldKind?: string | null,
];

export type SurfaceIndex = Record<
  string,
  Record<string, Record<string, SurfaceMemberTuple>>
>;

// ---------------------------------------------------------------------------
// Surface index diffing
// ---------------------------------------------------------------------------

export interface SurfaceIndexDiff {
  added: string[];
  removed: string[];
  changed: string[];
  /** Models entering/leaving surface coverage can change short-name priority. */
  coverageChanged?: string[];
}

/** Include fallback changes and transitions between surface/fallback coverage. */
export function includeStaticFallbackChanges(
  index: WorkspaceIndex,
  surfaceIndex: SurfaceIndex,
  staticFallback: StaticFallback | undefined,
  diff: SurfaceIndexDiff,
  fallbackDelta: StaticFallback = {},
  removedFallbackLabels: string[] = [],
): SurfaceIndexDiff {
  const result: SurfaceIndexDiff = { added: [], changed: [], removed: [],
    coverageChanged: [...diff.added, ...diff.removed] };
  const labels = new Set([
    ...diff.added, ...diff.changed, ...diff.removed,
    ...Object.keys(fallbackDelta), ...removedFallbackLabels,
  ]);
  for (const label of labels) {
    if (!surfaceIndex[label] && !staticFallback?.[label]) result.removed.push(label);
    else if (index.models.has(label)) result.changed.push(label);
    else result.added.push(label);
  }
  return result;
}

export function applyStaticFallbackDelta(
  current: StaticFallback | null | undefined,
  delta: StaticFallback,
  removed: string[] = [],
): StaticFallback {
  const next = current ?? {};
  for (const label of removed) delete next[label];
  Object.assign(next, delta);
  return next;
}

/**
 * Compute the diff between two surface indices using cached fingerprints.
 *
 * @param prev           Previous surface index.
 * @param next           New surface index.
 * @param fingerprints   Mutable fingerprint cache — updated in-place with
 *                       the new fingerprints for `next`.
 */
export function diffSurfaceIndex(
  prev: SurfaceIndex,
  next: SurfaceIndex,
  fingerprints: Map<string, string>,
  nextFingerprints?: Record<string, string>,
): SurfaceIndexDiff {
  const _t0 = performance.now();
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  const nextKeys = Object.keys(next);

  // Build new fingerprints and detect added/changed
  for (const label of nextKeys) {
    const fp = nextFingerprints?.[label] ?? JSON.stringify(next[label]);
    if (!Object.hasOwn(prev, label)) {
      added.push(label);
    } else {
      const oldFp = fingerprints.get(label);
      if (oldFp !== fp) {
        changed.push(label);
      }
    }
    fingerprints.set(label, fp);
  }

  // Detect removed
  for (const label of Object.keys(prev)) {
    if (!Object.hasOwn(next, label)) {
      removed.push(label);
      fingerprints.delete(label);
    }
  }

  recordTiming('index.diff', performance.now() - _t0);
  return { added, removed, changed };
}

// ---------------------------------------------------------------------------
// Incremental update
// ---------------------------------------------------------------------------

/**
 * Apply an incremental diff to an existing WorkspaceIndex.
 * Only the affected models are touched; lookup/transform tries are only
 * rebuilt when customLookups has changed.
 */
export function updateWorkspaceIndexIncremental(
  index: WorkspaceIndex,
  surfaceIndex: SurfaceIndex,
  diff: SurfaceIndexDiff,
  customLookups?: Record<string, string[]>,
  prevCustomLookups?: Record<string, string[]>,
  staticFallback?: StaticFallback,
  lookupCatalog?: LookupCatalogPayload,
): void {
  const _t0 = performance.now();
  const previousModels = new Map([...diff.added, ...diff.changed, ...diff.removed]
    .map(label => [label, index.models.get(label)] as const));

  // --- Removed models ---
  for (const label of diff.removed) {
    index.models.delete(label);
    index.fieldTrieByModel.delete(label);
    const fallback = staticFallback?.[label];
    if (fallback) {
      index.models.set(label, buildStaticFallbackModelInfo(label, fallback, customLookups));
    }
  }

  // --- Added models ---
  for (const label of diff.added) {
    const receivers = surfaceIndex[label];
    const fallback = staticFallback?.[label];
    if (!receivers && !fallback) continue;
    const modelInfo = receivers
      ? buildSurfaceModelInfo(label, receivers, customLookups, staticFallback)
      : buildStaticFallbackModelInfo(label, fallback!, customLookups);
    index.models.set(label, modelInfo);
    // Field trie is NOT built here — lazy on first access
  }

  // --- Changed models ---
  for (const label of diff.changed) {
    const receivers = surfaceIndex[label];
    const fallback = staticFallback?.[label];
    if (!receivers && !fallback) continue;
    const modelInfo = receivers
      ? buildSurfaceModelInfo(label, receivers, customLookups, staticFallback)
      : buildStaticFallbackModelInfo(label, fallback!, customLookups);
    index.models.set(label, modelInfo);
    // Invalidate cached field trie so it's rebuilt lazily
    index.fieldTrieByModel.delete(label);
  }

  // --- Rebuild lookup/transform tries only if customLookups changed ---
  const lookupsChanged = JSON.stringify(customLookups) !== JSON.stringify(prevCustomLookups);
  if (lookupsChanged) {
    index.lookupTrie = buildLookupTrie(customLookups);
    index.transformTrie = buildTransformTrie();
    // Lookup-only registration changes also affect unchanged models.
    for (const [label, receivers] of Object.entries(surfaceIndex)) {
      index.models.set(label, buildSurfaceModelInfo(label, receivers, customLookups, staticFallback));
      index.fieldTrieByModel.delete(label);
    }
    for (const [label, fallback] of Object.entries(staticFallback ?? {})) {
      if (!Object.hasOwn(surfaceIndex, label)) {
        index.models.set(label, buildStaticFallbackModelInfo(label, fallback, customLookups));
        index.fieldTrieByModel.delete(label);
      }
    }
  }
  if (lookupCatalog || index.lookupCatalog) {
    applyLookupCatalog(index, lookupCatalog ?? index.lookupCatalog,
      lookupsChanged ? undefined : [...diff.added, ...diff.changed]);
  }

  // Preserve workspace/built-in name precedence, including runtime-only
  // entries and fallback-only additions/removals.
  if (diff.coverageChanged?.length || diff.added.length || diff.removed.length || [...previousModels].some(([label, previous]) => {
    const next = index.models.get(label);
    return Boolean(previous) !== Boolean(next) || previous?.runtimeOnly !== next?.runtimeOnly;
  })) {
    index.modelLabelByName = buildModelLabelByName(Object.keys(surfaceIndex), staticFallback, 'last');
  }
  normalizeModelRelationTargets(index.models, index.modelLabelByName, previousModels.keys());

  recordTiming('index.incremental', performance.now() - _t0);
  incrementCounter('index.incremental_update');
}

// ---------------------------------------------------------------------------
// Lazy field trie
// ---------------------------------------------------------------------------

/**
 * Get or lazily build the per-model field RadixTrie.
 */
export function getOrBuildFieldTrie(
  index: WorkspaceIndex,
  modelLabel: string,
): RadixTrieNode<FieldInfo> | undefined {
  const existing = index.fieldTrieByModel.get(modelLabel);
  if (existing) return existing;

  const model = index.models.get(modelLabel);
  if (!model) return undefined;

  const _t0 = performance.now();
  const trie = createTrieNode<FieldInfo>();
  for (const [name, info] of model.fields) {
    trieInsert(trie, name, info);
  }
  index.fieldTrieByModel.set(modelLabel, trie);
  recordTiming('trie.lazy_build', performance.now() - _t0);
  incrementCounter('trie.lazy_builds');
  return trie;
}

// ---------------------------------------------------------------------------
// Single model builder (shared by full build and incremental update)
// ---------------------------------------------------------------------------

function addPrimaryKeyFields(fields: Map<string, FieldInfo>): void {
  // A supplied pk describes the real primary key, including the absence of id.
  if (fields.has('pk')) return;
  const id = fields.get('id');
  if (id) {
    fields.set('pk', { ...id, name: 'pk' });
    return;
  }
  for (const name of ['pk', 'id']) fields.set(name, {
    name,
    fieldKind: 'BigAutoField',
    isRelation: false,
    lookups: getLookupsForField('BigAutoField'),
    transforms: getTransformsForField('BigAutoField'),
  });
}

function buildModelInfo(
  modelLabel: string,
  receivers: Record<string, Record<string, SurfaceMemberTuple>>,
  customLookups?: Record<string, string[]>,
): ModelInfo {
  const objectName = modelLabel.includes('.')
    ? modelLabel.split('.').pop()!
    : modelLabel;

  const fields = new Map<string, FieldInfo>();
  const relations = new Map<string, RelationInfo>();
  const reverseRelations = new Map<string, RelationInfo>();

  const instanceMembers = receivers['instance'] ?? {};
  for (const [memberName, [returnKind, returnModelLabel, memberKind, explicitFieldKind]] of Object.entries(instanceMembers)) {
    if (
      memberKind !== undefined &&
      memberKind !== 'field' &&
      memberKind !== 'relation' &&
      memberKind !== 'reverse_relation'
    ) {
      continue;
    }
    const { fieldKind, isRelation } = inferFieldKind(returnKind);
    const effectiveFieldKind = explicitFieldKind ?? fieldKind;
    let lookups = getLookupsForField(effectiveFieldKind);
    const transforms = getTransformsForField(effectiveFieldKind);

    const extraLookups = customLookups?.[effectiveFieldKind];
    if (extraLookups && extraLookups.length > 0) {
      const lookupSet = new Set(lookups);
      for (const cl of extraLookups) {
        lookupSet.add(cl);
      }
      lookups = [...lookupSet];
    }

    const fieldInfo: FieldInfo = {
      name: memberName,
      fieldKind: effectiveFieldKind,
      isRelation,
      lookups,
      transforms,
    };
    fields.set(memberName, fieldInfo);

    if (isRelation) {
      const targetModelLabel = extractTargetModel(returnKind, returnModelLabel) ?? '';
      // Reverse OneToOne has returnKind='instance' but memberKind='reverse_relation'.
      // memberKind is authoritative — relying on returnKind alone silently
      // marks reverse OneToOne as forward, which breaks graph traversal
      // (`Author.profile` reverse relation → Profile).
      const direction: 'forward' | 'reverse' =
        memberKind === 'reverse_relation' || (memberKind === undefined && returnKind === 'related_manager')
          ? 'reverse'
          : 'forward';

      const relationInfo: RelationInfo = {
        name: memberName,
        fieldKind: effectiveFieldKind,
        targetModelLabel,
        direction,
      };

      if (direction === 'reverse') {
        reverseRelations.set(memberName, relationInfo);
      } else {
        relations.set(memberName, relationInfo);
        // Synthesize the FK `<name>_id` attname alias so lookup /
        // keyword completions can offer it (Django auto-generates it
        // at the ORM layer). Only for forward FK / OneToOne relations
        // where the column lives on this model's table.
        if (
          (effectiveFieldKind === 'ForeignKey' ||
            effectiveFieldKind === 'OneToOneField' ||
            effectiveFieldKind === 'ParentalKey') &&
          !fields.has(`${memberName}_id`)
        ) {
          const attnameField: FieldInfo = {
            name: `${memberName}_id`,
            fieldKind: 'IntegerField',
            isRelation: false,
            lookups: getLookupsForField('IntegerField'),
            transforms: getTransformsForField('IntegerField'),
          };
          fields.set(attnameField.name, attnameField);
        }
      }
    }
  }

  addPrimaryKeyFields(fields);

  return {
    label: modelLabel,
    objectName,
    module: '',
    filePath: '',
    fields,
    relations,
    reverseRelations,
    isAbstract: false,
    baseLabels: [],
  };
}

function normalizeRelationTargetLabel(
  modelLabel: string,
  targetModelLabel: string,
  models: Map<string, ModelInfo>,
  modelLabelByName: Map<string, string>,
): string {
  if (!targetModelLabel) {
    return targetModelLabel;
  }

  if (models.has(targetModelLabel)) {
    return targetModelLabel;
  }

  const byShortName = modelLabelByName.get(targetModelLabel);
  if (byShortName) {
    return byShortName;
  }

  if (!targetModelLabel.includes('.')) {
    const appLabel = modelLabel.includes('.')
      ? modelLabel.slice(0, modelLabel.lastIndexOf('.'))
      : '';
    const scopedLabel = appLabel
      ? `${appLabel}.${targetModelLabel}`
      : targetModelLabel;
    if (models.has(scopedLabel)) {
      return scopedLabel;
    }
  }

  return targetModelLabel;
}

function normalizeModelRelationTargets(
  models: Map<string, ModelInfo>,
  modelLabelByName: Map<string, string>,
  labels?: Iterable<string>,
): void {
  const entries = labels
    ? Array.from(labels, label => [label, models.get(label)] as const)
    : models;
  for (const [modelLabel, modelInfo] of entries) {
    if (!modelInfo) continue;
    for (const relationInfo of modelInfo.relations.values()) {
      relationInfo.targetModelLabel = normalizeRelationTargetLabel(
        modelLabel,
        relationInfo.targetModelLabel,
        models,
        modelLabelByName,
      );
    }
    for (const relationInfo of modelInfo.reverseRelations.values()) {
      relationInfo.targetModelLabel = normalizeRelationTargetLabel(
        modelLabel,
        relationInfo.targetModelLabel,
        models,
        modelLabelByName,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Full build (first load)
// ---------------------------------------------------------------------------

/**
 * Convert the Python daemon's surfaceIndex into a WorkspaceIndex.
 *
 * Field tries are NOT built eagerly — they are created lazily on first
 * access via {@link getOrBuildFieldTrie}.
 */
/**
 * Static fallback data for models missing from runtime inspection.
 * Keys are model labels; values list field and relation names. Newer daemon
 * versions also include fieldDetails so the TS local index can answer lookup
 * completions while the richer runtime surface is loading in the background.
 */
interface StaticFallbackFieldDetail {
  fieldKind?: string | null;
  isRelation?: boolean | null;
  relationDirection?: string | null;
  relatedModelLabel?: string | null;
}

export type StaticFallback = Record<
  string,
  {
    fields: string[];
    relations?: string[];
    reverseRelations?: string[];
    fieldDetails?: Record<string, StaticFallbackFieldDetail>;
    /** Model known only from runtime inspection (installed third-party app). */
    runtimeOnly?: boolean;
    /** Django contrib model the client ships a built-in entry for. */
    builtin?: boolean;
  }
>;

export type ModelNameCollision = 'first' | 'last';

/**
 * Decide which label owns each bare model name (`Company` → `db.Company`).
 *
 * Short names drive receiver inference (`findModelLabelByShortName`, the
 * snake→Pascal variants), so only models the workspace declares own them:
 * surface entries and non-runtime-only fallback entries, with `collision`
 * choosing between workspace models that share a name. Built-in contrib
 * models claim a name only when no workspace model uses it. Other
 * runtime-only models (third-party apps) never get one — otherwise
 * `result.get(...)` would become an ORM receiver for some app's `Result`
 * model. Those stay reachable by exact label.
 */
export function buildModelLabelByName(
  surfaceLabels: Iterable<string>,
  staticFallback: StaticFallback | undefined,
  collision: ModelNameCollision,
): Map<string, string> {
  const byName = new Map<string, string>();
  const register = (label: string): void => {
    const name = modelObjectName(label);
    if (collision === 'first' && byName.has(name)) {
      return;
    }
    byName.set(name, label);
  };

  const surfaceLabelSet = new Set<string>();
  for (const label of surfaceLabels) {
    surfaceLabelSet.add(label);
    register(label);
  }

  const builtinLabels: string[] = [];
  for (const [label, info] of Object.entries(staticFallback ?? {})) {
    if (surfaceLabelSet.has(label)) {
      continue;
    }
    if (info.builtin) {
      builtinLabels.push(label);
    } else if (!info.runtimeOnly) {
      register(label);
    }
  }
  for (const label of builtinLabels) {
    const name = modelObjectName(label);
    if (!byName.has(name)) {
      byName.set(name, label);
    }
  }
  return byName;
}

function modelObjectName(label: string): string {
  return label.includes('.') ? label.split('.').pop()! : label;
}

/**
 * True when the model carries at least one field besides the `id` / `pk`
 * names synthesized for every model — i.e. the source actually knew its
 * fields.
 */
function hasDeclaredFields(model: ModelInfo): boolean {
  for (const name of model.fields.keys()) {
    if (name !== 'id' && name !== 'pk') {
      return true;
    }
  }
  return false;
}

/**
 * Build a model from its surface entry, deferring to the static fallback when
 * the entry has no instance fields. Concrete models stay registered in the
 * surface even when their `instance` receiver came back empty (inheritance-only
 * models, or a slice rebuilt against a static-only graph during runtime
 * warm-up); letting such an entry win collapses lookup completion to the
 * synthesized `id` / `pk`.
 */
function buildSurfaceModelInfo(
  modelLabel: string,
  receivers: Record<string, Record<string, SurfaceMemberTuple>>,
  customLookups?: Record<string, string[]>,
  staticFallback?: StaticFallback,
): ModelInfo {
  const modelInfo = buildModelInfo(modelLabel, receivers, customLookups);
  const fallback = staticFallback?.[modelLabel];
  if (!fallback || hasDeclaredFields(modelInfo)) {
    return modelInfo;
  }
  const fallbackInfo = buildStaticFallbackModelInfo(modelLabel, fallback, customLookups);
  return hasDeclaredFields(fallbackInfo) ? fallbackInfo : modelInfo;
}

function buildStaticFallbackModelInfo(
  label: string,
  info: StaticFallback[string],
  customLookups?: Record<string, string[]>,
): ModelInfo {
  const objectName = label.includes('.') ? label.split('.').pop()! : label;
  const fields = new Map<string, FieldInfo>();
  const relations = new Map<string, RelationInfo>();
  const reverseRelations = new Map<string, RelationInfo>();
  const details = info.fieldDetails ?? {};
  const addField = (
    fieldName: string,
    fallbackKind: string,
    fallbackIsRelation: boolean,
  ): FieldInfo => {
    const detail = details[fieldName];
    const fieldKind = detail?.fieldKind ?? fallbackKind;
    const isRelation = detail?.isRelation ?? fallbackIsRelation;
    let lookups = getLookupsForField(fieldKind);
    const extraLookups = customLookups?.[fieldKind];
    if (extraLookups && extraLookups.length > 0) {
      const lookupSet = new Set(lookups);
      for (const lookup of extraLookups) {
        lookupSet.add(lookup);
      }
      lookups = [...lookupSet];
    }

    const fieldInfo: FieldInfo = {
      name: fieldName,
      fieldKind,
      isRelation,
      lookups,
      transforms: getTransformsForField(fieldKind),
    };
    fields.set(fieldName, fieldInfo);
    return fieldInfo;
  };

  for (const fieldName of info.fields ?? []) {
    addField(fieldName, 'CharField', false);
  }

  for (const relName of info.relations ?? []) {
    const fieldInfo = addField(relName, 'ForeignKey', true);
    const detail = details[relName];
    relations.set(relName, {
      name: relName,
      fieldKind: fieldInfo.fieldKind,
      targetModelLabel: detail?.relatedModelLabel ?? '',
      direction: 'forward',
    });
    if (
      (fieldInfo.fieldKind === 'ForeignKey' ||
        fieldInfo.fieldKind === 'OneToOneField' ||
        fieldInfo.fieldKind === 'ParentalKey') &&
      !fields.has(`${relName}_id`)
    ) {
      fields.set(`${relName}_id`, {
        name: `${relName}_id`,
        fieldKind: 'IntegerField',
        isRelation: false,
        lookups: getLookupsForField('IntegerField'),
        transforms: getTransformsForField('IntegerField'),
      });
    }
  }

  for (const relName of info.reverseRelations ?? []) {
    const fieldInfo = addField(relName, 'ForeignKey', true);
    const detail = details[relName];
    reverseRelations.set(relName, {
      name: relName,
      fieldKind: fieldInfo.fieldKind,
      targetModelLabel: detail?.relatedModelLabel ?? '',
      direction: 'reverse',
    });
  }

  addPrimaryKeyFields(fields);

  return {
    label,
    objectName,
    module: '',
    filePath: '',
    fields,
    relations,
    reverseRelations,
    isAbstract: false,
    baseLabels: [],
    runtimeOnly: Boolean(info.runtimeOnly) && !info.builtin,
  };
}

export function buildWorkspaceIndex(
  surfaceIndex: SurfaceIndex,
  modelNames: string[],
  customLookups?: Record<string, string[]>,
  staticFallback?: StaticFallback,
  lookupCatalog?: LookupCatalogPayload,
): WorkspaceIndex {
  const _t0 = performance.now();
  const models = new Map<string, ModelInfo>();
  const surfaceLabels: string[] = [];

  for (const modelLabel of Object.keys(surfaceIndex)) {
    const receivers = surfaceIndex[modelLabel];
    if (!receivers) continue;

    const modelInfo = buildSurfaceModelInfo(
      modelLabel,
      receivers,
      customLookups,
      staticFallback,
    );
    models.set(modelLabel, modelInfo);
    surfaceLabels.push(modelLabel);
  }

  // Add fallback models that exist in static index but not in runtime
  if (staticFallback) {
    for (const [label, info] of Object.entries(staticFallback)) {
      if (models.has(label)) continue; // runtime data takes priority
      models.set(label, buildStaticFallbackModelInfo(label, info, customLookups));
    }
  }
  const modelLabelByName = buildModelLabelByName(surfaceLabels, staticFallback, 'last');

  normalizeModelRelationTargets(models, modelLabelByName);

  const lookupTrie = buildLookupTrie(customLookups);
  const transformTrie = buildTransformTrie();

  const runtimeCount = Object.keys(surfaceIndex).length;
  const fallbackCount = models.size - runtimeCount;
  const _elapsed = performance.now() - _t0;
  if (typeof console !== 'undefined') {
    console.log(
      `[ls:indexer] buildWorkspaceIndex: ${models.size} models` +
      (fallbackCount > 0 ? ` (${fallbackCount} static fallback)` : '') +
      ` ${_elapsed.toFixed(0)}ms (tries=lazy)`
    );
  }
  incrementCounter('index.full_rebuild');

  const index: WorkspaceIndex = {
    models,
    perFile: new Map<string, FileIndexEntry>(),
    modelLabelByName,
    fieldTrieByModel: new Map<string, RadixTrieNode<FieldInfo>>(),
    lookupTrie,
    transformTrie,
  };
  applyLookupCatalog(index, lookupCatalog);
  return index;
}

/**
 * Update the per-file cache entry in an existing WorkspaceIndex.
 *
 * If the file previously contributed model definitions the affected models
 * are marked for a future refresh (their field tries will need rebuilding
 * once the new model data arrives from the daemon).
 *
 * @param index     The workspace index to mutate.
 * @param fileUri   The URI of the changed file.
 * @param fileEntry The new file index entry.
 */
export function updateFileInIndex(
  index: WorkspaceIndex,
  fileUri: string,
  fileEntry: FileIndexEntry,
): void {
  const existing = index.perFile.get(fileUri);

  // If the previous version exported models, mark them for refresh by
  // clearing their field tries so they are rebuilt on the next query.
  if (existing?.exportedModels) {
    for (const modelName of existing.exportedModels) {
      const label = index.modelLabelByName.get(modelName);
      if (label) {
        // Reset the field trie — it will be rebuilt on next access.
        index.fieldTrieByModel.set(label, createTrieNode<FieldInfo>());
      }
    }
  }

  // Store the new file entry.
  index.perFile.set(fileUri, fileEntry);

  // If the new version also exports models, mark those for refresh too.
  if (fileEntry.exportedModels) {
    for (const modelName of fileEntry.exportedModels) {
      const label = index.modelLabelByName.get(modelName);
      if (label) {
        index.fieldTrieByModel.set(label, createTrieNode<FieldInfo>());
      }
    }
  }
}
