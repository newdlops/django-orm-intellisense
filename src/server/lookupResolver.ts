// ============================================================================
// Django ORM __ (double-underscore) Lookup Chain FSM Parser & Resolver
// ============================================================================

import type {
  FieldInfo,
  LookupInfo,
  ModelInfo,
  ParsedLookup,
  PrefixCandidate,
  RelationInfo,
  ResolvedSegment,
  ResolutionState,
  TransformInfo,
  WorkspaceIndex,
} from './types.js';
import { CompressedRadixTrie } from './radixTrie.js';

export type FsmState = ResolutionState['fsmState'];

// ---------------------------------------------------------------------------
// Levenshtein distance (for typo correction)
// ---------------------------------------------------------------------------

/**
 * Compute the Levenshtein edit distance between two strings.
 * Uses O(min(n,m)) space via a single-row DP approach.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure a is the shorter string for space efficiency
  if (a.length > b.length) {
    [a, b] = [b, a];
  }

  const aLen = a.length;
  const bLen = b.length;
  const row = new Uint16Array(aLen + 1);

  for (let i = 0; i <= aLen; i++) row[i] = i;

  for (let j = 1; j <= bLen; j++) {
    let prev = row[0];
    row[0] = j;
    for (let i = 1; i <= aLen; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const temp = row[i];
      row[i] = Math.min(
        row[i] + 1,         // deletion
        row[i - 1] + 1,     // insertion
        prev + cost,         // substitution
      );
      prev = temp;
    }
  }

  return row[aLen];
}

/**
 * Find fuzzy matches using Levenshtein distance.
 * Returns candidates with distance ≤ maxDist, sorted by distance.
 */
function fuzzyMatch(partial: string, candidates: string[], maxDist = 2): string[] {
  if (partial.length === 0) return [];
  const lowerPartial = partial.toLowerCase();
  return candidates
    .map((c) => ({ name: c, dist: levenshtein(lowerPartial, c.toLowerCase()) }))
    .filter((c) => c.dist <= maxDist && c.dist > 0)
    .sort((a, b) => a.dist - b.dist)
    .map((c) => c.name);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Retrieve the ModelInfo from the index, returning undefined if not found.
 */
function resolveModel(
  label: string,
  index: WorkspaceIndex,
): ModelInfo | undefined {
  return index.models.get(label);
}

/**
 * Check whether `name` matches a field (non-relation) on the given model.
 */
function findField(model: ModelInfo, name: string): FieldInfo | undefined {
  const field = model.fields.get(name);
  if (field && !field.isRelation) {
    return field;
  }
  return undefined;
}

/**
 * Check whether `name` matches a forward relation on the given model.
 */
function findRelation(model: ModelInfo, name: string): RelationInfo | undefined {
  return model.relations.get(name);
}

/**
 * Check whether `name` matches a reverse relation on the given model.
 */
function findReverseRelation(model: ModelInfo, name: string): RelationInfo | undefined {
  return model.reverseRelations.get(name);
}

/**
 * Check whether `name` matches a lookup for the given field.
 */
function findLookup(
  field: FieldInfo,
  name: string,
  index: WorkspaceIndex,
): LookupInfo | undefined {
  if (!field.lookups.includes(name)) {
    return undefined;
  }
  // Retrieve the full LookupInfo from the index's lookup trie.
  const payload = trieSearch(index.lookupTrie, name);
  if (payload) {
    return payload;
  }
  // Fallback: construct a minimal LookupInfo.
  return { name, applicableFieldKinds: [], source: 'builtin' };
}

/**
 * Check whether `name` matches a transform for the given field.
 */
function findTransform(
  field: FieldInfo,
  name: string,
  index: WorkspaceIndex,
): TransformInfo | undefined {
  if (!field.transforms.includes(name)) {
    return undefined;
  }
  const payload = trieSearch(index.transformTrie, name);
  if (payload) {
    return payload;
  }
  return {
    name,
    outputFieldKind: field.fieldKind,
    applicableFieldKinds: [],
    source: 'builtin',
  };
}

/**
 * Light wrapper to do an exact search in a RadixTrieNode (the root node
 * stored in WorkspaceIndex). We walk the trie manually because WorkspaceIndex
 * stores raw nodes, not CompressedRadixTrie instances.
 */
function trieSearch<T>(
  root: { children: Map<string, { label: string; child: { children: Map<string, { label: string; child: any }>; payload?: T; isTerminal: boolean } }>; payload?: T; isTerminal: boolean },
  key: string,
): T | undefined {
  if (key.length === 0) {
    return root.isTerminal ? root.payload : undefined;
  }

  let node = root;
  let remaining = key;

  while (remaining.length > 0) {
    const firstChar = remaining[0];
    const edge = node.children.get(firstChar);
    if (!edge) {
      return undefined;
    }
    const { label, child } = edge;
    if (!remaining.startsWith(label)) {
      return undefined;
    }
    remaining = remaining.slice(label.length);
    node = child;
  }

  return node.isTerminal ? node.payload : undefined;
}

/**
 * Collect all terminal payloads from a RadixTrieNode subtree, optionally
 * filtering by a prefix.
 */
function triePrefixCollect<T>(
  root: { children: Map<string, { label: string; child: any }>; payload?: T; isTerminal: boolean },
  prefix: string,
  limit: number,
): Array<{ key: string; payload: T }> {
  // Reuse CompressedRadixTrie's logic by wrapping in a temporary instance.
  // This is a hot path optimisation candidate for later; for correctness we
  // walk the trie inline.
  const results: Array<{ key: string; payload: T }> = [];

  // First, navigate to the node matching the prefix.
  let node = root;
  let consumed = '';
  let remaining = prefix;

  while (remaining.length > 0) {
    const firstChar = remaining[0];
    const edge = node.children.get(firstChar);
    if (!edge) {
      return results;
    }
    const { label, child } = edge;
    const cpLen = commonPrefixLen(remaining, label);
    if (cpLen === remaining.length) {
      // Remaining prefix consumed (possibly mid-edge).
      consumed += label;
      node = child;
      remaining = '';
      break;
    }
    if (cpLen < label.length) {
      return results;
    }
    consumed += label;
    remaining = remaining.slice(cpLen);
    node = child;
  }

  // Now collect all terminals below `node`.
  collectAll(node, consumed, results, limit);
  return results;
}

function commonPrefixLen(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a[i] === b[i]) i++;
  return i;
}

function collectAll<T>(
  node: { children: Map<string, { label: string; child: any }>; payload?: T; isTerminal: boolean },
  prefix: string,
  results: Array<{ key: string; payload: T }>,
  limit: number,
): void {
  if (results.length >= limit) return;
  if (node.isTerminal && node.payload !== undefined) {
    results.push({ key: prefix, payload: node.payload as T });
    if (results.length >= limit) return;
  }
  for (const [, { label, child }] of node.children) {
    collectAll(child, prefix + label, results, limit);
    if (results.length >= limit) return;
  }
}

// ---------------------------------------------------------------------------
// FieldInfo for a relation (we need it to get lookups/transforms context)
// ---------------------------------------------------------------------------

/**
 * Given a RelationInfo, get the FieldInfo from the model (so we have
 * lookups/transforms lists).
 */
function fieldInfoForRelation(
  model: ModelInfo,
  relation: RelationInfo,
): FieldInfo | undefined {
  // Forward relations are stored in both `fields` and `relations`.
  return model.fields.get(relation.name);
}

// ---------------------------------------------------------------------------
// Core FSM: parseLookupChain
// ---------------------------------------------------------------------------

/**
 * Parse a Django ORM lookup expression like "author__name__icontains"
 * walking through the FSM to resolve each `__`-separated segment.
 *
 * @param expression  The full lookup string (e.g. "author__name__icontains")
 * @param startModel  The fully-qualified model label to start from (e.g. "blog.Post")
 * @param index       The workspace index providing model/field/lookup data
 * @returns           A ParsedLookup describing the resolved chain
 */
export function parseLookupChain(
  expression: string,
  startModel: string,
  index: WorkspaceIndex,
): ParsedLookup {
  const result = _parseLookupChainInner(expression, startModel, index);
  result.startModel = startModel;
  return result;
}

function _parseLookupChainInner(
  expression: string,
  startModel: string,
  index: WorkspaceIndex,
): ParsedLookup {
  const _t0 = performance.now();
  const segments = expression.split('__');
  const resolvedPath: ResolvedSegment[] = [];

  const state: ResolutionState = {
    currentModel: startModel,
    currentField: undefined,
    position: 0,
    fsmState: 'EXPECT_FIELD_OR_RELATION',
  };

  const model = resolveModel(startModel, index);
  if (!model) {
    return {
      segments,
      resolvedPath,
      state: 'error',
      errorAt: 0,
      suggestions: [],
    };
  }

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    state.position = i;

    // If the segment is empty (e.g. trailing __ or double __), treat it
    // as a partial input requesting suggestions.
    if (seg === '') {
      const suggestions = buildSuggestions(state, '', index);
      return {
        segments,
        resolvedPath,
        finalField: state.currentField,
        state: 'partial',
        suggestions,
      };
    }

    const isLast = i === segments.length - 1;

    if (state.fsmState === 'EXPECT_FIELD_OR_RELATION') {
      const currentModel = resolveModel(state.currentModel, index);
      if (!currentModel) {
        return {
          segments,
          resolvedPath,
          state: 'error',
          errorAt: i,
          suggestions: [],
        };
      }

      // Try forward relation first.
      const relation = findRelation(currentModel, seg);
      if (relation) {
        const fInfo = fieldInfoForRelation(currentModel, relation);
        resolvedPath.push({
          name: seg,
          kind: 'relation',
          modelLabel: state.currentModel,
          fieldInfo: fInfo,
        });
        state.currentModel = relation.targetModelLabel;
        state.currentField = fInfo;
        // After following a relation, the next segment should again be
        // a field or relation on the target model.
        state.fsmState = 'EXPECT_FIELD_OR_RELATION';
        continue;
      }

      // Try reverse relation.
      const reverseRel = findReverseRelation(currentModel, seg);
      if (reverseRel) {
        resolvedPath.push({
          name: seg,
          kind: 'reverse_relation',
          modelLabel: state.currentModel,
        });
        state.currentModel = reverseRel.targetModelLabel;
        state.currentField = undefined;
        state.fsmState = 'EXPECT_FIELD_OR_RELATION';
        continue;
      }

      // Try scalar field.
      const field = findField(currentModel, seg);
      if (field) {
        resolvedPath.push({
          name: seg,
          kind: 'field',
          modelLabel: state.currentModel,
          fieldInfo: field,
        });
        state.currentField = field;
        // After a scalar field, the next segment must be a transform or lookup.
        state.fsmState = 'EXPECT_TRANSFORM_OR_LOOKUP';
        continue;
      }

      // Not found — if this is the last segment, it may be partial input.
      if (isLast) {
        const suggestions = buildSuggestions(state, seg, index);
        return {
          segments,
          resolvedPath,
          finalField: state.currentField,
          state: 'partial',
          suggestions,
        };
      }

      // Error: unresolved segment in the middle of the chain.
      return {
        segments,
        resolvedPath,
        state: 'error',
        errorAt: i,
        suggestions: buildSuggestions(state, seg, index),
      };
    }

    if (state.fsmState === 'EXPECT_TRANSFORM_OR_LOOKUP') {
      if (!state.currentField) {
        return {
          segments,
          resolvedPath,
          state: 'error',
          errorAt: i,
        };
      }

      // Try lookup.
      const lookup = findLookup(state.currentField, seg, index);
      if (lookup) {
        resolvedPath.push({
          name: seg,
          kind: 'lookup',
          fieldInfo: state.currentField,
        });
        state.fsmState = 'COMPLETE';
        // A lookup must be the last meaningful segment.
        if (!isLast) {
          return {
            segments,
            resolvedPath,
            finalField: state.currentField,
            finalLookup: seg,
            state: 'error',
            errorAt: i + 1,
          };
        }
        return {
          segments,
          resolvedPath,
          finalField: state.currentField,
          finalLookup: seg,
          state: 'complete',
        };
      }

      // Try transform.
      const transform = findTransform(state.currentField, seg, index);
      if (transform) {
        resolvedPath.push({
          name: seg,
          kind: 'transform',
          fieldInfo: state.currentField,
        });
        // After a transform, we get a new "virtual" field with the
        // transform's output kind. Build a synthetic FieldInfo.
        state.currentField = {
          name: seg,
          fieldKind: transform.outputFieldKind,
          isRelation: false,
          lookups: getLookupsForKind(transform.outputFieldKind, index),
          transforms: getTransformsForKind(transform.outputFieldKind, index),
        };
        // Transforms can chain or end with a lookup.
        state.fsmState = 'EXPECT_TRANSFORM_OR_LOOKUP';
        continue;
      }

      // Not found — partial?
      if (isLast) {
        const suggestions = buildSuggestions(state, seg, index);
        return {
          segments,
          resolvedPath,
          finalField: state.currentField,
          state: 'partial',
          suggestions,
        };
      }

      return {
        segments,
        resolvedPath,
        finalField: state.currentField,
        state: 'error',
        errorAt: i,
        suggestions: buildSuggestions(state, seg, index),
      };
    }

    if (state.fsmState === 'COMPLETE') {
      // We already found a terminal lookup but there are more segments.
      return {
        segments,
        resolvedPath,
        finalField: state.currentField,
        state: 'error',
        errorAt: i,
      };
    }

    if (state.fsmState === 'ERROR') {
      return {
        segments,
        resolvedPath,
        state: 'error',
        errorAt: i,
      };
    }
  }

  // We consumed all segments without hitting a lookup — this is a valid
  // partial state (the user may still be typing).
  if (state.fsmState === 'EXPECT_FIELD_OR_RELATION' || state.fsmState === 'EXPECT_TRANSFORM_OR_LOOKUP') {
    return {
      segments,
      resolvedPath,
      finalField: state.currentField,
      state: 'partial',
      suggestions: buildSuggestions(state, '', index),
    };
  }

  return {
    segments,
    resolvedPath,
    finalField: state.currentField,
    state: 'complete',
  };
}

// ---------------------------------------------------------------------------
// Suggestion builder (used internally and by getCompletionCandidates)
// ---------------------------------------------------------------------------

function buildSuggestions(
  state: ResolutionState,
  partial: string,
  index: WorkspaceIndex,
): string[] {
  const candidates = getCandidateNames(state, index);
  if (partial === '') {
    return candidates;
  }
  const lowerPartial = partial.toLowerCase();
  // 1. Prefix match first
  const prefixMatches = candidates.filter((c) => c.toLowerCase().startsWith(lowerPartial));
  if (prefixMatches.length > 0) {
    return prefixMatches;
  }
  // 2. Fuzzy match fallback (Levenshtein distance ≤ 2)
  return fuzzyMatch(partial, candidates, 2);
}

/**
 * Return an array of all valid next-segment names for the current FSM state.
 */
function getCandidateNames(
  state: ResolutionState,
  index: WorkspaceIndex,
): string[] {
  if (state.fsmState === 'EXPECT_FIELD_OR_RELATION') {
    const model = resolveModel(state.currentModel, index);
    if (!model) return [];
    const names: string[] = [];
    for (const [name, field] of model.fields) {
      names.push(name);
    }
    for (const [name] of model.relations) {
      if (!model.fields.has(name)) {
        names.push(name);
      }
    }
    for (const [name] of model.reverseRelations) {
      names.push(name);
    }
    return names;
  }

  if (state.fsmState === 'EXPECT_TRANSFORM_OR_LOOKUP') {
    if (!state.currentField) return [];
    const names: string[] = [];
    for (const l of state.currentField.lookups) {
      names.push(l);
    }
    for (const t of state.currentField.transforms) {
      names.push(t);
    }
    return names;
  }

  return [];
}

// ---------------------------------------------------------------------------
// Lookup / Transform helpers for synthetic fields
// ---------------------------------------------------------------------------

function getLookupsForKind(fieldKind: string, index: WorkspaceIndex): string[] {
  const results = triePrefixCollect<LookupInfo>(index.lookupTrie, '', 200);
  return results
    .filter(
      ({ payload }) =>
        payload.applicableFieldKinds.length === 0 ||
        payload.applicableFieldKinds.includes(fieldKind),
    )
    .map(({ payload }) => payload.name);
}

function getTransformsForKind(fieldKind: string, index: WorkspaceIndex): string[] {
  const results = triePrefixCollect<TransformInfo>(index.transformTrie, '', 200);
  return results
    .filter(
      ({ payload }) =>
        payload.applicableFieldKinds.length === 0 ||
        payload.applicableFieldKinds.includes(fieldKind),
    )
    .map(({ payload }) => payload.name);
}

// ---------------------------------------------------------------------------
// Public: getCompletionCandidates
// ---------------------------------------------------------------------------

/**
 * Given a parsed lookup and a partial segment the user is currently typing,
 * return ranked completion candidates.
 *
 * @param parsed         The result of parseLookupChain
 * @param partialSegment The text the user has typed for the current segment
 * @param index          The workspace index
 * @returns              Sorted array of PrefixCandidate objects
 */
export function getCompletionCandidates(
  parsed: ParsedLookup,
  partialSegment: string,
  index: WorkspaceIndex,
  usageFrequency?: Map<string, number>,
): PrefixCandidate[] {
  const _t0 = performance.now();

  // --- Error state recovery: use suggestions from parsed lookup ---
  if (parsed.state === 'error' && parsed.suggestions && parsed.suggestions.length > 0) {
    return parsed.suggestions.map((name, i) => ({
      name,
      kind: 'field' as const,
      detail: '(did you mean?)',
      source: 'workspace' as const,
      sortPriority: 10 + i,
      isFuzzyMatch: true,
    }));
  }

  const state = inferState(parsed, index);
  if (!state) {
    return [];
  }

  const candidates: PrefixCandidate[] = [];
  const lowerPartial = partialSegment.toLowerCase();

  if (state.fsmState === 'EXPECT_FIELD_OR_RELATION') {
    const model = resolveModel(state.currentModel, index);
    if (!model) return [];

    let hasPrefixMatch = false;

    // Scalar fields.
    for (const [name, field] of model.fields) {
      if (!field.isRelation && matchesPrefix(name, lowerPartial)) {
        hasPrefixMatch = true;
        candidates.push({
          name,
          kind: 'field',
          detail: field.fieldKind,
          source: 'workspace',
          sortPriority: 1,
        });
      }
    }

    // Forward relations.
    for (const [name, rel] of model.relations) {
      if (matchesPrefix(name, lowerPartial)) {
        hasPrefixMatch = true;
        candidates.push({
          name,
          kind: 'relation',
          detail: `${rel.fieldKind} -> ${rel.targetModelLabel}`,
          source: 'workspace',
          sortPriority: 2,
        });
      }
    }

    // Reverse relations.
    for (const [name, rel] of model.reverseRelations) {
      if (matchesPrefix(name, lowerPartial)) {
        hasPrefixMatch = true;
        candidates.push({
          name,
          kind: 'relation',
          detail: `reverse ${rel.fieldKind} from ${rel.targetModelLabel}`,
          source: 'workspace',
          sortPriority: 3,
        });
      }
    }

    // Fuzzy fallback when no prefix matches found
    if (!hasPrefixMatch && partialSegment.length > 0) {
      const allNames = getCandidateNames(state, index);
      const fuzzyResults = fuzzyMatch(partialSegment, allNames, 2);
      for (const name of fuzzyResults) {
        const field = model.fields.get(name);
        const rel = model.relations.get(name) ?? model.reverseRelations.get(name);
        candidates.push({
          name,
          kind: field && !field.isRelation ? 'field' : 'relation',
          detail: field ? `${field.fieldKind} (did you mean?)` : rel ? `${rel.fieldKind} (did you mean?)` : '(did you mean?)',
          source: 'workspace',
          sortPriority: 10,
          isFuzzyMatch: true,
        });
      }
    }
  } else if (state.fsmState === 'EXPECT_TRANSFORM_OR_LOOKUP') {
    const field = state.currentField;
    if (!field) return [];

    let hasPrefixMatch = false;

    // Lookups.
    for (const lookupName of field.lookups) {
      if (matchesPrefix(lookupName, lowerPartial)) {
        hasPrefixMatch = true;
        candidates.push({
          name: lookupName,
          kind: 'lookup',
          detail: `lookup for ${field.fieldKind}`,
          source: 'builtin',
          sortPriority: 1,
        });
      }
    }

    // Transforms.
    for (const transformName of field.transforms) {
      if (matchesPrefix(transformName, lowerPartial)) {
        hasPrefixMatch = true;
        const tInfo = trieSearch<TransformInfo>(index.transformTrie, transformName);
        candidates.push({
          name: transformName,
          kind: 'transform',
          detail: tInfo
            ? `transform -> ${tInfo.outputFieldKind}`
            : `transform for ${field.fieldKind}`,
          source: 'builtin',
          sortPriority: 2,
        });
      }
    }

    // Fuzzy fallback for lookups/transforms
    if (!hasPrefixMatch && partialSegment.length > 0) {
      const allNames = [...field.lookups, ...field.transforms];
      const fuzzyResults = fuzzyMatch(partialSegment, allNames, 2);
      for (const name of fuzzyResults) {
        const isLookup = field.lookups.includes(name);
        candidates.push({
          name,
          kind: isLookup ? 'lookup' : 'transform',
          detail: `${isLookup ? 'lookup' : 'transform'} (did you mean?)`,
          source: 'builtin',
          sortPriority: 10,
          isFuzzyMatch: true,
        });
      }
    }
  }

  // Sort: priority → exact prefix over fuzzy → usage frequency → alphabetical
  candidates.sort((a, b) => {
    if (a.sortPriority !== b.sortPriority) {
      return a.sortPriority - b.sortPriority;
    }
    // Exact prefix > fuzzy (within same priority tier)
    const aExact = a.name.toLowerCase().startsWith(lowerPartial) ? 0 : 1;
    const bExact = b.name.toLowerCase().startsWith(lowerPartial) ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    // Usage frequency (higher = better)
    if (usageFrequency) {
      const aFreq = usageFrequency.get(a.name) ?? 0;
      const bFreq = usageFrequency.get(b.name) ?? 0;
      if (aFreq !== bFreq) return bFreq - aFreq;
    }
    return a.name.localeCompare(b.name);
  });

  return candidates;
}

// ---------------------------------------------------------------------------
// Private helpers for getCompletionCandidates
// ---------------------------------------------------------------------------

function matchesPrefix(name: string, lowerPartial: string): boolean {
  if (lowerPartial === '') return true;
  return name.toLowerCase().startsWith(lowerPartial);
}

/**
 * Reconstruct the ResolutionState from a ParsedLookup so we know what
 * kind of completions to offer.
 */
function inferState(
  parsed: ParsedLookup,
  index: WorkspaceIndex,
): ResolutionState | undefined {
  if (parsed.resolvedPath.length === 0) {
    if (parsed.startModel) {
      return {
        currentModel: parsed.startModel,
        currentField: undefined,
        position: 0,
        fsmState: 'EXPECT_FIELD_OR_RELATION',
      };
    }
    return undefined;
  }

  const lastResolved = parsed.resolvedPath[parsed.resolvedPath.length - 1];

  if (lastResolved.kind === 'relation' || lastResolved.kind === 'reverse_relation') {
    // After a relation, we expect fields/relations on the target model.
    // The target model label is stored via the relation info.
    // For the resolved segment, we stored the *source* modelLabel, but
    // we need the *target*. Let's look it up.
    if (lastResolved.modelLabel) {
      const sourceModel = resolveModel(lastResolved.modelLabel, index);
      if (sourceModel) {
        const rel =
          sourceModel.relations.get(lastResolved.name) ??
          sourceModel.reverseRelations.get(lastResolved.name);
        if (rel) {
          return {
            currentModel: rel.targetModelLabel,
            currentField: undefined,
            position: parsed.resolvedPath.length,
            fsmState: 'EXPECT_FIELD_OR_RELATION',
          };
        }
      }
    }
    return undefined;
  }

  if (lastResolved.kind === 'field' || lastResolved.kind === 'transform') {
    return {
      currentModel: lastResolved.modelLabel ?? '',
      currentField: lastResolved.fieldInfo ?? parsed.finalField,
      position: parsed.resolvedPath.length,
      fsmState: 'EXPECT_TRANSFORM_OR_LOOKUP',
    };
  }

  if (lastResolved.kind === 'lookup') {
    // Already complete — no more suggestions.
    return {
      currentModel: '',
      currentField: parsed.finalField,
      position: parsed.resolvedPath.length,
      fsmState: 'COMPLETE',
    };
  }

  return undefined;
}
