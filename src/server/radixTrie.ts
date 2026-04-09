// ============================================================================
// Compressed Radix Trie (Patricia Trie) for fast prefix-based completion
// ============================================================================

import type { RadixTrieNode } from './types.js';

export { RadixTrieNode };

/**
 * Find the length of the longest common prefix between two strings.
 */
function commonPrefixLength(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a[i] === b[i]) {
    i++;
  }
  return i;
}

function createNode<T>(payload?: T, isTerminal = false): RadixTrieNode<T> {
  return {
    children: new Map(),
    payload,
    isTerminal,
  };
}

/**
 * A compressed radix trie (Patricia trie) supporting insert, exact search,
 * prefix search with limit, and delete. Edge labels may be multi-character
 * strings, compressing single-child chains.
 *
 * Generic over payload type T.
 */
export class CompressedRadixTrie<T> {
  private root: RadixTrieNode<T>;
  private _size: number;

  constructor() {
    this.root = createNode<T>();
    this._size = 0;
  }

  // -------------------------------------------------------------------------
  // Insert
  // -------------------------------------------------------------------------

  insert(key: string, payload: T): void {
    if (key.length === 0) {
      // Empty-string key is stored at the root.
      if (!this.root.isTerminal) {
        this._size++;
      }
      this.root.isTerminal = true;
      this.root.payload = payload;
      return;
    }

    let node = this.root;
    let remaining = key;

    while (remaining.length > 0) {
      const firstChar = remaining[0];
      const edge = node.children.get(firstChar);

      if (!edge) {
        // No edge starting with this character — create a new leaf.
        const leaf = createNode<T>(payload, true);
        node.children.set(firstChar, { label: remaining, child: leaf });
        this._size++;
        return;
      }

      const { label, child } = edge;
      const cpLen = commonPrefixLength(remaining, label);

      if (cpLen === label.length && cpLen === remaining.length) {
        // Exact match with edge label — update this node.
        if (!child.isTerminal) {
          this._size++;
        }
        child.isTerminal = true;
        child.payload = payload;
        return;
      }

      if (cpLen === label.length) {
        // The edge label is a prefix of remaining — descend.
        remaining = remaining.slice(cpLen);
        node = child;
        continue;
      }

      // cpLen < label.length — we need to split the edge.
      // Create an intermediate node at the common prefix.
      const commonPrefix = label.slice(0, cpLen);
      const existingSuffix = label.slice(cpLen);
      const intermediate = createNode<T>();

      // Re-attach existing child under the suffix.
      intermediate.children.set(existingSuffix[0], {
        label: existingSuffix,
        child,
      });

      if (cpLen === remaining.length) {
        // The key ends exactly at the split point.
        intermediate.isTerminal = true;
        intermediate.payload = payload;
        this._size++;
      } else {
        // There is still a portion of the key left — add a new branch.
        const newSuffix = remaining.slice(cpLen);
        const newLeaf = createNode<T>(payload, true);
        intermediate.children.set(newSuffix[0], {
          label: newSuffix,
          child: newLeaf,
        });
        this._size++;
      }

      // Replace the original edge with the new intermediate node.
      node.children.set(firstChar, { label: commonPrefix, child: intermediate });
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Exact search
  // -------------------------------------------------------------------------

  search(key: string): T | undefined {
    const node = this.findNode(key);
    if (node && node.isTerminal) {
      return node.payload;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Prefix search
  // -------------------------------------------------------------------------

  prefixSearch(prefix: string, limit = 50): Array<{ key: string; payload: T }> {
    const results: Array<{ key: string; payload: T }> = [];

    if (prefix.length === 0) {
      // Collect everything from the root.
      this.collect(this.root, '', results, limit);
      return results;
    }

    let node = this.root;
    let consumed = '';
    let remaining = prefix;

    while (remaining.length > 0) {
      const firstChar = remaining[0];
      const edge = node.children.get(firstChar);

      if (!edge) {
        // No matching edge — no results.
        return results;
      }

      const { label, child } = edge;
      const cpLen = commonPrefixLength(remaining, label);

      if (cpLen === remaining.length) {
        // The remaining prefix is fully consumed (possibly mid-edge).
        // Collect all terminals below this edge, using the full edge label.
        consumed += label;
        this.collect(child, consumed, results, limit);
        return results;
      }

      if (cpLen < label.length) {
        // Mismatch within an edge label — no results.
        return results;
      }

      // cpLen === label.length and remaining has more chars — descend.
      consumed += label;
      remaining = remaining.slice(cpLen);
      node = child;
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  delete(key: string): boolean {
    if (key.length === 0) {
      if (this.root.isTerminal) {
        this.root.isTerminal = false;
        this.root.payload = undefined;
        this._size--;
        return true;
      }
      return false;
    }

    // We track the stack of (parentNode, edgeFirstChar) to enable compression
    // after removal.
    const stack: Array<{ parent: RadixTrieNode<T>; edgeChar: string }> = [];
    let node = this.root;
    let remaining = key;

    while (remaining.length > 0) {
      const firstChar = remaining[0];
      const edge = node.children.get(firstChar);

      if (!edge) {
        return false;
      }

      const { label, child } = edge;

      if (!remaining.startsWith(label)) {
        return false;
      }

      stack.push({ parent: node, edgeChar: firstChar });
      remaining = remaining.slice(label.length);
      node = child;
    }

    if (!node.isTerminal) {
      return false;
    }

    node.isTerminal = false;
    node.payload = undefined;
    this._size--;

    // Clean up: if the node has no children, remove it from parent,
    // and possibly merge the parent edge if it becomes a single-child
    // non-terminal node.
    this.compressAfterDelete(stack, node);

    return true;
  }

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  clear(): void {
    this.root = createNode<T>();
    this._size = 0;
  }

  get size(): number {
    return this._size;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Navigate to the node exactly matching `key`, or undefined if no such
   * path exists in the trie.
   */
  private findNode(key: string): RadixTrieNode<T> | undefined {
    if (key.length === 0) {
      return this.root;
    }

    let node = this.root;
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

    return node;
  }

  /**
   * DFS-collect all terminal nodes below `node`, prepending `prefix` to
   * each key. Stops after `limit` results.
   */
  private collect(
    node: RadixTrieNode<T>,
    prefix: string,
    results: Array<{ key: string; payload: T }>,
    limit: number,
  ): void {
    if (results.length >= limit) {
      return;
    }

    if (node.isTerminal) {
      results.push({ key: prefix, payload: node.payload as T });
      if (results.length >= limit) {
        return;
      }
    }

    for (const [, { label, child }] of node.children) {
      this.collect(child, prefix + label, results, limit);
      if (results.length >= limit) {
        return;
      }
    }
  }

  /**
   * After a delete, compress the trie:
   * 1. If the deleted node is a leaf (no children), remove the edge from parent.
   * 2. If a parent becomes a non-terminal node with exactly one child, merge
   *    the two edges into one.
   */
  private compressAfterDelete(
    stack: Array<{ parent: RadixTrieNode<T>; edgeChar: string }>,
    deletedNode: RadixTrieNode<T>,
  ): void {
    // If the deleted node still has children, we might still need to merge
    // if it is non-terminal with exactly one child.
    if (deletedNode.children.size === 0 && stack.length > 0) {
      // Remove the leaf entirely.
      const { parent, edgeChar } = stack[stack.length - 1];
      parent.children.delete(edgeChar);
    } else if (deletedNode.children.size === 1 && !deletedNode.isTerminal && stack.length > 0) {
      // Merge: the deleted node is non-terminal with one child.
      this.mergeWithSingleChild(stack[stack.length - 1], deletedNode);
    }

    // Walk back up the stack and merge any non-terminal single-child nodes.
    for (let i = stack.length - 1; i >= 0; i--) {
      const { parent, edgeChar } = stack[i];
      const edge = parent.children.get(edgeChar);
      if (!edge) {
        continue;
      }
      const { label, child } = edge;
      if (!child.isTerminal && child.children.size === 1) {
        // Merge child with its single grandchild.
        const [[, grandEdge]] = child.children;
        parent.children.set(edgeChar, {
          label: label + grandEdge.label,
          child: grandEdge.child,
        });
      } else if (!child.isTerminal && child.children.size === 0) {
        // Orphan non-terminal node — remove.
        parent.children.delete(edgeChar);
      }
    }
  }

  /**
   * Merge a non-terminal single-child node with its only child edge.
   */
  private mergeWithSingleChild(
    parentInfo: { parent: RadixTrieNode<T>; edgeChar: string },
    node: RadixTrieNode<T>,
  ): void {
    const { parent, edgeChar } = parentInfo;
    const parentEdge = parent.children.get(edgeChar);
    if (!parentEdge) {
      return;
    }

    const [[, childEdge]] = node.children;
    parent.children.set(edgeChar, {
      label: parentEdge.label + childEdge.label,
      child: childEdge.child,
    });
  }
}
