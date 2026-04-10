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
 * Infer a Django field kind from the surfaceIndex entry's type string
 * and returnKind.
 *
 * The surfaceIndex stores entries as `[typeStr, returnKind]` where:
 *   - typeStr is the Python type annotation (e.g. "int", "str",
 *     "Optional[str]", "ForeignKey", "RelatedManager[Post]", etc.)
 *   - returnKind is one of "instance", "related_manager", "queryset",
 *     "model_class", "manager", or null.
 */
function inferFieldKind(typeStr: string, returnKind: string | null): { fieldKind: string; isRelation: boolean } {
  // If returnKind indicates a relation
  if (returnKind === 'instance' || returnKind === 'related_manager') {
    // Try to detect the specific relation type from the typeStr
    if (typeStr.includes('ManyToMany') || returnKind === 'related_manager') {
      return { fieldKind: 'ManyToManyField', isRelation: true };
    }
    if (typeStr.includes('OneToOne')) {
      return { fieldKind: 'OneToOneField', isRelation: true };
    }
    if (typeStr.includes('ForeignKey')) {
      return { fieldKind: 'ForeignKey', isRelation: true };
    }
  }

  // Check if the typeStr directly names a known field class
  for (const kind of Object.keys(FIELD_LOOKUPS)) {
    if (typeStr.includes(kind)) {
      return { fieldKind: kind, isRelation: RELATION_FIELD_KINDS.has(kind) };
    }
  }

  // Heuristic: map Python primitive types to Django field kinds
  const stripped = typeStr.replace(/Optional\[|\]/g, '').trim();
  switch (stripped) {
    case 'str':
      return { fieldKind: 'CharField', isRelation: false };
    case 'int':
      return { fieldKind: 'IntegerField', isRelation: false };
    case 'float':
      return { fieldKind: 'FloatField', isRelation: false };
    case 'bool':
      return { fieldKind: 'BooleanField', isRelation: false };
    case 'datetime':
    case 'datetime.datetime':
      return { fieldKind: 'DateTimeField', isRelation: false };
    case 'date':
    case 'datetime.date':
      return { fieldKind: 'DateField', isRelation: false };
    case 'time':
    case 'datetime.time':
      return { fieldKind: 'TimeField', isRelation: false };
    case 'timedelta':
    case 'datetime.timedelta':
      return { fieldKind: 'DurationField', isRelation: false };
    case 'Decimal':
    case 'decimal.Decimal':
      return { fieldKind: 'DecimalField', isRelation: false };
    case 'UUID':
    case 'uuid.UUID':
      return { fieldKind: 'UUIDField', isRelation: false };
    case 'bytes':
      return { fieldKind: 'BinaryField', isRelation: false };
    case 'dict':
      return { fieldKind: 'JSONField', isRelation: false };
    default:
      return { fieldKind: 'CharField', isRelation: false };
  }
}

/**
 * Try to extract a target model label from a relation type string.
 * E.g. "RelatedManager[Post]" -> "Post", "ForeignKey[Author]" -> "Author".
 */
function extractTargetModel(typeStr: string): string | undefined {
  const match = typeStr.match(/\[([^\]]+)\]/);
  return match ? match[1] : undefined;
}

// ---------------------------------------------------------------------------
// Build the global lookup and transform tries
// ---------------------------------------------------------------------------

function buildLookupTrie(customLookups?: Record<string, string[]>): RadixTrieNode<LookupInfo> {
  const root = createTrieNode<LookupInfo>();
  const seen = new Set<string>();

  for (const [fieldKind, lookups] of Object.entries(FIELD_LOOKUPS)) {
    for (const lookupName of lookups) {
      if (!seen.has(lookupName)) {
        seen.add(lookupName);
        // Collect all field kinds that support this lookup.
        const applicableFieldKinds: string[] = [];
        for (const [fk, fkLookups] of Object.entries(FIELD_LOOKUPS)) {
          if (fkLookups.includes(lookupName)) {
            applicableFieldKinds.push(fk);
          }
        }
        const info: LookupInfo = {
          name: lookupName,
          applicableFieldKinds,
          source: 'builtin',
        };
        trieInsert(root, lookupName, info);
      }
    }
  }

  // Add custom lookups registered via register_lookup()
  if (customLookups) {
    for (const [fieldKind, lookupNames] of Object.entries(customLookups)) {
      for (const lookupName of lookupNames) {
        if (!seen.has(lookupName)) {
          seen.add(lookupName);
          const info: LookupInfo = {
            name: lookupName,
            applicableFieldKinds: [fieldKind],
            source: 'custom',
          };
          trieInsert(root, lookupName, info);
        }
      }
    }
  }

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
 * Structure: `{ [modelLabel]: { [receiverKind]: { [memberName]: [typeStr, returnKind] } } }`
 *
 * Receiver kinds include "instance", "model_class", "manager", etc.
 */
export type SurfaceIndex = Record<
  string,
  Record<string, Record<string, [string, string | null]>>
>;

// ---------------------------------------------------------------------------
// Surface index diffing
// ---------------------------------------------------------------------------

export interface SurfaceIndexDiff {
  added: string[];
  removed: string[];
  changed: string[];
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
): SurfaceIndexDiff {
  const _t0 = performance.now();
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  const prevKeys = new Set(Object.keys(prev));
  const nextKeys = Object.keys(next);

  // Build new fingerprints and detect added/changed
  const newFingerprints = new Map<string, string>();
  for (const label of nextKeys) {
    const fp = JSON.stringify(next[label]);
    newFingerprints.set(label, fp);

    if (!prevKeys.has(label)) {
      added.push(label);
    } else {
      const oldFp = fingerprints.get(label);
      if (oldFp !== fp) {
        changed.push(label);
      }
    }
  }

  // Detect removed
  const nextKeySet = new Set(nextKeys);
  for (const label of prevKeys) {
    if (!nextKeySet.has(label)) {
      removed.push(label);
    }
  }

  // Update fingerprint cache to reflect new state
  fingerprints.clear();
  for (const [k, v] of newFingerprints) {
    fingerprints.set(k, v);
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
): void {
  const _t0 = performance.now();

  // --- Removed models ---
  for (const label of diff.removed) {
    const model = index.models.get(label);
    if (model) {
      index.modelLabelByName.delete(model.objectName);
    }
    index.models.delete(label);
    index.fieldTrieByModel.delete(label);
  }

  // --- Added models ---
  for (const label of diff.added) {
    const receivers = surfaceIndex[label];
    if (!receivers) continue;
    const modelInfo = buildModelInfo(label, receivers, customLookups);
    index.models.set(label, modelInfo);
    index.modelLabelByName.set(modelInfo.objectName, label);
    // Field trie is NOT built here — lazy on first access
  }

  // --- Changed models ---
  for (const label of diff.changed) {
    const receivers = surfaceIndex[label];
    if (!receivers) continue;
    const oldModel = index.models.get(label);
    if (oldModel) {
      index.modelLabelByName.delete(oldModel.objectName);
    }
    const modelInfo = buildModelInfo(label, receivers, customLookups);
    index.models.set(label, modelInfo);
    index.modelLabelByName.set(modelInfo.objectName, label);
    // Invalidate cached field trie so it's rebuilt lazily
    index.fieldTrieByModel.delete(label);
  }

  // --- Rebuild lookup/transform tries only if customLookups changed ---
  const lookupsChanged = JSON.stringify(customLookups) !== JSON.stringify(prevCustomLookups);
  if (lookupsChanged) {
    index.lookupTrie = buildLookupTrie(customLookups);
    index.transformTrie = buildTransformTrie();
  }

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

function buildModelInfo(
  modelLabel: string,
  receivers: Record<string, Record<string, [string, string | null]>>,
  customLookups?: Record<string, string[]>,
): ModelInfo {
  const objectName = modelLabel.includes('.')
    ? modelLabel.split('.').pop()!
    : modelLabel;

  const fields = new Map<string, FieldInfo>();
  const relations = new Map<string, RelationInfo>();
  const reverseRelations = new Map<string, RelationInfo>();

  const instanceMembers = receivers['instance'] ?? {};
  for (const [memberName, [typeStr, returnKind]] of Object.entries(instanceMembers)) {
    const { fieldKind, isRelation } = inferFieldKind(typeStr, returnKind);
    let lookups = getLookupsForField(fieldKind);
    const transforms = getTransformsForField(fieldKind);

    const extraLookups = customLookups?.[fieldKind];
    if (extraLookups && extraLookups.length > 0) {
      const lookupSet = new Set(lookups);
      for (const cl of extraLookups) {
        lookupSet.add(cl);
      }
      lookups = [...lookupSet];
    }

    const fieldInfo: FieldInfo = {
      name: memberName,
      fieldKind,
      isRelation,
      lookups,
      transforms,
    };
    fields.set(memberName, fieldInfo);

    if (isRelation) {
      const targetModelLabel = extractTargetModel(typeStr) ?? '';
      const direction: 'forward' | 'reverse' =
        returnKind === 'related_manager' ? 'reverse' : 'forward';

      const relationInfo: RelationInfo = {
        name: memberName,
        fieldKind,
        targetModelLabel,
        direction,
      };

      if (direction === 'reverse') {
        reverseRelations.set(memberName, relationInfo);
      } else {
        relations.set(memberName, relationInfo);
      }
    }
  }

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
 * Keys are model labels; values list field and relation names.
 */
export type StaticFallback = Record<string, { fields: string[]; relations: string[] }>;

export function buildWorkspaceIndex(
  surfaceIndex: SurfaceIndex,
  modelNames: string[],
  customLookups?: Record<string, string[]>,
  staticFallback?: StaticFallback,
): WorkspaceIndex {
  const _t0 = performance.now();
  const models = new Map<string, ModelInfo>();
  const modelLabelByName = new Map<string, string>();

  for (const modelLabel of Object.keys(surfaceIndex)) {
    const receivers = surfaceIndex[modelLabel];
    if (!receivers) continue;

    const modelInfo = buildModelInfo(modelLabel, receivers, customLookups);
    models.set(modelLabel, modelInfo);
    modelLabelByName.set(modelInfo.objectName, modelLabel);
  }

  // Add fallback models that exist in static index but not in runtime
  if (staticFallback) {
    for (const [label, info] of Object.entries(staticFallback)) {
      if (models.has(label)) continue; // runtime data takes priority

      const objectName = label.includes('.') ? label.split('.').pop()! : label;
      const fields = new Map<string, FieldInfo>();
      const defaultLookups = getLookupsForField('CharField');
      const defaultTransforms = getTransformsForField('CharField');

      for (const fieldName of info.fields) {
        fields.set(fieldName, {
          name: fieldName,
          fieldKind: 'CharField',
          isRelation: false,
          lookups: defaultLookups,
          transforms: defaultTransforms,
        });
      }

      for (const relName of info.relations) {
        fields.set(relName, {
          name: relName,
          fieldKind: 'ForeignKey',
          isRelation: true,
          lookups: getLookupsForField('ForeignKey'),
          transforms: [],
        });
      }

      models.set(label, {
        label,
        objectName,
        module: '',
        filePath: '',
        fields,
        relations: new Map(),
        reverseRelations: new Map(),
        isAbstract: false,
        baseLabels: [],
      });
      modelLabelByName.set(objectName, label);
    }
  }

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

  return {
    models,
    perFile: new Map<string, FileIndexEntry>(),
    modelLabelByName,
    fieldTrieByModel: new Map<string, RadixTrieNode<FieldInfo>>(),
    lookupTrie,
    transformTrie,
  };
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
