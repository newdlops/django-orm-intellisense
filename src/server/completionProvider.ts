// ============================================================================
// Django ORM Intellisense — Completion Provider
// ============================================================================

import {
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
} from 'vscode-languageserver/node';

import type {
  CompletionContext,
  PrefixCandidate,
  WorkspaceIndex,
  FieldInfo,
  RadixTrieNode,
} from './types.js';
import { getOrBuildFieldTrie } from './workspaceIndexer.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produce an array of {@link CompletionItem}s for the given completion
 * context and workspace index.
 *
 * The high-level flow:
 * 1. Determine the current model + partial lookup string from context.
 * 2. Parse the lookup chain into resolved segments (delegated to the
 *    lookup resolver once implemented).
 * 3. Collect prefix-matched candidates from the appropriate radix trie.
 * 4. Rank and convert to LSP CompletionItems.
 */
export function provideCompletions(
  context: CompletionContext,
  index: WorkspaceIndex,
): CompletionItem[] {
  const _t0 = performance.now();
  const { currentModel, parsedLookup, partialSegment } = context;

  const modelInfo = index.models.get(currentModel);
  if (!modelInfo) {
    return [];
  }

  const candidates: PrefixCandidate[] = [];

  // Determine what to suggest based on the resolution state.
  const state = parsedLookup.state;

  if (state === 'error') {
    // Nothing useful to suggest when the chain is broken.
    return [];
  }

  if (state === 'partial' || state === 'complete') {
    // Collect field / relation candidates from the *current* model at the
    // end of the resolved chain.
    const lastSegment = parsedLookup.resolvedPath[parsedLookup.resolvedPath.length - 1];
    const targetModelLabel = lastSegment?.modelLabel ?? currentModel;
    const targetModel = index.models.get(targetModelLabel) ?? modelInfo;

    // --- Field candidates via radix trie (fast prefix search) -----------
    const fieldTrie = getOrBuildFieldTrie(index, targetModel.label);
    if (fieldTrie) {
      const trieResults = prefixSearch(fieldTrie, partialSegment);
      for (const { key, payload } of trieResults) {
        candidates.push(fieldCandidateFrom(key, payload));
      }
    } else {
      // Fallback: linear scan over the model's field map.
      for (const [name, field] of targetModel.fields) {
        if (name.startsWith(partialSegment)) {
          candidates.push(fieldCandidateFrom(name, field));
        }
      }
    }

    // --- Relation candidates -------------------------------------------
    for (const [name, rel] of targetModel.relations) {
      if (name.startsWith(partialSegment)) {
        candidates.push({
          name,
          kind: 'relation',
          detail: `${rel.fieldKind} -> ${rel.targetModelLabel}`,
          source: 'workspace',
          sortPriority: 1,
        });
      }
    }

    for (const [name, rel] of targetModel.reverseRelations) {
      if (name.startsWith(partialSegment)) {
        candidates.push({
          name,
          kind: 'relation',
          detail: `reverse ${rel.fieldKind} from ${rel.targetModelLabel}`,
          source: 'workspace',
          sortPriority: 2,
        });
      }
    }

    // --- If the last segment resolved to a field, offer lookups / transforms
    const resolvedField = parsedLookup.finalField;
    if (resolvedField) {
      collectLookupCandidates(resolvedField, partialSegment, index, candidates);
      collectTransformCandidates(resolvedField, partialSegment, index, candidates);
    }
  }

  // Sort candidates by priority (lower is better), then alphabetically.
  candidates.sort((a, b) => a.sortPriority - b.sortPriority || a.name.localeCompare(b.name));

  return candidates.map(toCompletionItem);
}

// ---------------------------------------------------------------------------
// Radix trie helpers
// ---------------------------------------------------------------------------

/**
 * Walk the radix trie and collect all entries whose key starts with
 * {@link prefix}.  Returns at most {@link limit} results.
 */
function prefixSearch<T>(
  root: RadixTrieNode<T>,
  prefix: string,
  limit = 50,
): Array<{ key: string; payload: T }> {
  const results: Array<{ key: string; payload: T }> = [];
  collectFromNode(root, '', prefix, results, limit);
  return results;
}

function collectFromNode<T>(
  node: RadixTrieNode<T>,
  accumulated: string,
  prefix: string,
  results: Array<{ key: string; payload: T }>,
  limit: number,
): void {
  if (results.length >= limit) {
    return;
  }

  if (node.isTerminal && node.payload !== undefined && accumulated.startsWith(prefix)) {
    results.push({ key: accumulated, payload: node.payload });
  }

  for (const [, edge] of node.children) {
    const newAcc = accumulated + edge.label;
    // Only descend if the accumulated path could still be a prefix match.
    if (newAcc.startsWith(prefix) || prefix.startsWith(newAcc)) {
      collectFromNode(edge.child, newAcc, prefix, results, limit);
    }
  }
}

// ---------------------------------------------------------------------------
// Candidate builders
// ---------------------------------------------------------------------------

function fieldCandidateFrom(name: string, field: FieldInfo): PrefixCandidate {
  return {
    name,
    kind: field.isRelation ? 'relation' : 'field',
    detail: field.fieldKind,
    source: 'workspace',
    sortPriority: field.isRelation ? 1 : 0,
  };
}

function collectLookupCandidates(
  field: FieldInfo,
  partial: string,
  index: WorkspaceIndex,
  out: PrefixCandidate[],
): void {
  const trieResults = prefixSearch(index.lookupTrie, partial);
  for (const { key, payload } of trieResults) {
    if (payload.applicableFieldKinds.length === 0 || payload.applicableFieldKinds.includes(field.fieldKind)) {
      out.push({
        name: key,
        kind: 'lookup',
        detail: payload.description ?? `lookup (${payload.source})`,
        source: payload.source,
        sortPriority: 3,
      });
    }
  }
}

function collectTransformCandidates(
  field: FieldInfo,
  partial: string,
  index: WorkspaceIndex,
  out: PrefixCandidate[],
): void {
  const trieResults = prefixSearch(index.transformTrie, partial);
  for (const { key, payload } of trieResults) {
    if (payload.applicableFieldKinds.length === 0 || payload.applicableFieldKinds.includes(field.fieldKind)) {
      out.push({
        name: key,
        kind: 'transform',
        detail: `-> ${payload.outputFieldKind} (${payload.source})`,
        source: payload.source,
        sortPriority: 4,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// LSP conversion
// ---------------------------------------------------------------------------

const kindMap: Record<PrefixCandidate['kind'], CompletionItemKind> = {
  field: CompletionItemKind.Field,
  relation: CompletionItemKind.Reference,
  lookup: CompletionItemKind.Enum,
  transform: CompletionItemKind.Function,
};

function toCompletionItem(candidate: PrefixCandidate): CompletionItem {
  return {
    label: candidate.name,
    kind: kindMap[candidate.kind],
    detail: candidate.detail,
    insertText: candidate.name,
    insertTextFormat: InsertTextFormat.PlainText,
    data: {
      source: candidate.source,
      candidateKind: candidate.kind,
    },
  };
}
