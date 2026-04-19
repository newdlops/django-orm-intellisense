// ============================================================================
// Django ORM Intellisense — Language Server Type Definitions
// ============================================================================

// ---------------------------------------------------------------------------
// Workspace Index
// ---------------------------------------------------------------------------

/**
 * Top-level index holding every model, file entry, and search structures
 * for the entire workspace.
 */
export interface WorkspaceIndex {
  models: Map<string, ModelInfo>;
  perFile: Map<string, FileIndexEntry>;
  /** Maps a short model object name (e.g. "Company") to its app label (e.g. "db.Company"). */
  modelLabelByName: Map<string, string>;
  /** Per-model radix trie over field names for fast prefix completion. */
  fieldTrieByModel: Map<string, RadixTrieNode<FieldInfo>>;
  /** Global trie of lookup names (exact, icontains, ...). */
  lookupTrie: RadixTrieNode<LookupInfo>;
  /** Global trie of transform names (lower, year, ...). */
  transformTrie: RadixTrieNode<TransformInfo>;
}

/**
 * Per-file metadata stored in the workspace index.
 */
export interface FileIndexEntry {
  uri: string;
  version: number;
  fingerprint: string;
  exportedModels: string[];
  /** alias -> module.symbol */
  importedSymbols: Map<string, string>;
  containsModelDefs: boolean;
}

// ---------------------------------------------------------------------------
// Model / Field / Relation
// ---------------------------------------------------------------------------

export interface ModelInfo {
  /** App-qualified label, e.g. "db.Company". */
  label: string;
  /** Class name, e.g. "Company". */
  objectName: string;
  /** Dotted Python module path, e.g. "zuzu.db.models.company.company". */
  module: string;
  filePath: string;
  fields: Map<string, FieldInfo>;
  relations: Map<string, RelationInfo>;
  reverseRelations: Map<string, RelationInfo>;
  isAbstract: boolean;
  baseLabels: string[];
}

export interface FieldInfo {
  name: string;
  /** e.g. "CharField", "IntegerField", "ForeignKey" */
  fieldKind: string;
  isRelation: boolean;
  /** Applicable lookups: ["exact", "icontains", ...] */
  lookups: string[];
  /** Applicable transforms: ["lower", "upper", "year", ...] */
  transforms: string[];
}

export interface RelationInfo {
  name: string;
  /** e.g. "ForeignKey", "OneToOneField", "ManyToManyField" */
  fieldKind: string;
  targetModelLabel: string;
  relatedName?: string;
  direction: 'forward' | 'reverse';
}

// ---------------------------------------------------------------------------
// Lookup / Transform
// ---------------------------------------------------------------------------

export interface LookupInfo {
  name: string;
  applicableFieldKinds: string[];
  source: 'builtin' | 'custom';
  description?: string;
}

export interface TransformInfo {
  name: string;
  /** The field kind produced after applying this transform. */
  outputFieldKind: string;
  applicableFieldKinds: string[];
  source: 'builtin' | 'custom';
}

// ---------------------------------------------------------------------------
// Lookup Resolution
// ---------------------------------------------------------------------------

export interface ParsedLookup {
  segments: string[];
  resolvedPath: ResolvedSegment[];
  finalField?: FieldInfo;
  finalLookup?: string;
  state: 'complete' | 'partial' | 'error';
  errorAt?: number;
  suggestions?: string[];
  /** The model label that started the lookup chain. */
  startModel?: string;
}

export interface ResolvedSegment {
  name: string;
  kind: 'field' | 'relation' | 'reverse_relation' | 'transform' | 'lookup';
  modelLabel?: string;
  fieldInfo?: FieldInfo;
}

export interface ResolutionState {
  currentModel: string;
  currentField?: FieldInfo;
  position: number;
  fsmState:
    | 'EXPECT_FIELD_OR_RELATION'
    | 'EXPECT_TRANSFORM_OR_LOOKUP'
    | 'COMPLETE'
    | 'ERROR';
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

export interface CompletionContext {
  documentUri: string;
  position: { line: number; character: number };
  currentModel: string;
  parsedLookup: ParsedLookup;
  partialSegment: string;
  method?: string;
}

export interface PrefixCandidate {
  name: string;
  kind: 'field' | 'relation' | 'lookup' | 'transform';
  detail: string;
  source: 'builtin' | 'custom' | 'workspace' | 'dependency';
  sortPriority: number;
  isFuzzyMatch?: boolean;
}

// ---------------------------------------------------------------------------
// Radix Trie
// ---------------------------------------------------------------------------

export interface RadixTrieNode<T> {
  children: Map<string, { label: string; child: RadixTrieNode<T> }>;
  payload?: T;
  isTerminal: boolean;
}
