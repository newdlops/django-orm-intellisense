// ============================================================================
// Django ORM Intellisense — Language Server Entry Point
// ============================================================================

import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  CompletionParams,
  DidChangeConfigurationNotification,
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';

import type {
  WorkspaceIndex,
  FileIndexEntry,
  ModelInfo,
  FieldInfo,
  CompletionContext,
  ParsedLookup,
  RadixTrieNode,
  LookupInfo,
  TransformInfo,
} from './types.js';

import { provideCompletions } from './completionProvider.js';
import {
  buildWorkspaceIndex,
  diffSurfaceIndex,
  updateWorkspaceIndexIncremental,
  type SurfaceIndex,
  type SurfaceIndexDiff,
} from './workspaceIndexer.js';
import { parseLookupChain, getCompletionCandidates } from './lookupResolver.js';
import { recordTiming, incrementCounter, setGauge, getAllStats, getAllCounters, getAllGauges } from './perfTracker.js';
import { CompletionItemKind } from 'vscode-languageserver/node';
import type { CompletionItem } from 'vscode-languageserver/node';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Connection & document manager
// ---------------------------------------------------------------------------

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// ---------------------------------------------------------------------------
// Workspace state
// ---------------------------------------------------------------------------

let workspaceRoot: string | null = null;

/** Set of file URIs that have been modified but not yet re-indexed. */
const dirtyFiles = new Set<string>();

/**
 * The workspace index.  Initialised empty; populated by the background
 * indexing pass that starts on `initialized`.
 */
const workspaceIndex: WorkspaceIndex = {
  models: new Map<string, ModelInfo>(),
  perFile: new Map<string, FileIndexEntry>(),
  modelLabelByName: new Map<string, string>(),
  fieldTrieByModel: new Map<string, RadixTrieNode<FieldInfo>>(),
  lookupTrie: emptyTrieNode<LookupInfo>(),
  transformTrie: emptyTrieNode<TransformInfo>(),
};

function emptyTrieNode<T>(): RadixTrieNode<T> {
  return { children: new Map(), isTerminal: false };
}

// ---------------------------------------------------------------------------
// Completion result cache
// ---------------------------------------------------------------------------

const completionCache = new Map<string, CompletionItem[]>();
const COMPLETION_CACHE_MAX = 256;

// ---------------------------------------------------------------------------
// Incremental update state
// ---------------------------------------------------------------------------

let previousSurfaceIndex: SurfaceIndex | null = null;
let previousCustomLookups: Record<string, string[]> | undefined;
const modelVersions = new Map<string, number>();
const modelFingerprints = new Map<string, string>();

// ---------------------------------------------------------------------------
// Usage frequency tracking (for completion ranking, persisted across sessions)
// ---------------------------------------------------------------------------

const USAGE_FREQUENCY_MAX = 500;
const USAGE_SAVE_DEBOUNCE_MS = 5_000;

/** Tracks how often each field/lookup name is used in completions. */
const usageFrequency = new Map<string, number>();
let usageFrequencyDirty = false;
let usageSaveTimer: ReturnType<typeof setTimeout> | undefined;

function getUsageFilePath(): string | null {
  if (!workspaceRoot) return null;
  let root = workspaceRoot;
  // Strip file:// prefix if present
  if (root.startsWith('file://')) {
    root = root.replace(/^file:\/\//, '');
  }
  const vscodeDirPath = path.join(root, '.vscode');
  return path.join(vscodeDirPath, '.django-orm-usage.json');
}

function loadUsageFrequency(): void {
  const filePath = getUsageFilePath();
  if (!filePath) return;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw) as Record<string, number>;
    usageFrequency.clear();
    for (const [key, count] of Object.entries(data)) {
      if (typeof count === 'number' && count > 0) {
        usageFrequency.set(key, count);
      }
    }
    connection.console.log(`[ls] loaded usage frequency: ${usageFrequency.size} entries`);
  } catch {
    // File doesn't exist or corrupted — start fresh
  }
}

function saveUsageFrequency(): void {
  if (!usageFrequencyDirty) return;
  const filePath = getUsageFilePath();
  if (!filePath) return;

  // Prune to max entries (keep highest frequency)
  if (usageFrequency.size > USAGE_FREQUENCY_MAX) {
    const sorted = [...usageFrequency.entries()].sort((a, b) => b[1] - a[1]);
    usageFrequency.clear();
    for (const [key, count] of sorted.slice(0, USAGE_FREQUENCY_MAX)) {
      usageFrequency.set(key, count);
    }
  }

  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const data: Record<string, number> = {};
    for (const [key, count] of usageFrequency) {
      data[key] = count;
    }
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
    usageFrequencyDirty = false;
  } catch {
    // Silently fail — non-critical
  }
}

function scheduleSaveUsageFrequency(): void {
  if (usageSaveTimer) clearTimeout(usageSaveTimer);
  usageSaveTimer = setTimeout(saveUsageFrequency, USAGE_SAVE_DEBOUNCE_MS);
}

/** Record resolved segments from the previous completion as "used". */
function recordUsage(parsedLookup: ParsedLookup): void {
  for (const seg of parsedLookup.resolvedPath) {
    const key = seg.name;
    usageFrequency.set(key, (usageFrequency.get(key) ?? 0) + 1);
  }
  usageFrequencyDirty = true;
  scheduleSaveUsageFrequency();
}

// ---------------------------------------------------------------------------
// Lifecycle: initialize
// ---------------------------------------------------------------------------

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const _t0 = performance.now();

  if (params.workspaceFolders && params.workspaceFolders.length > 0) {
    workspaceRoot = params.workspaceFolders[0].uri;
  } else if (params.rootUri) {
    workspaceRoot = params.rootUri;
  } else if (params.rootPath) {
    workspaceRoot = params.rootPath;
  }

  connection.console.log(
    `[ls] initialize ${(performance.now() - _t0).toFixed(0)}ms root=${workspaceRoot ?? '(none)'}`,
  );

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: ['_', '.', '"', "'"],
      },
    },
  };
});

// ---------------------------------------------------------------------------
// Lifecycle: initialized — kick off background indexing
// ---------------------------------------------------------------------------

connection.onInitialized(() => {
  void connection.client.register(DidChangeConfigurationNotification.type, undefined);

  loadUsageFrequency();
  connection.console.log('[ls] initialized — starting workspace indexing');
  void startWorkspaceIndexing();
});

/**
 * Placeholder for the initial workspace scan.  In Phase 0 this logs and
 * resolves immediately; the real implementation will walk Python files,
 * parse model definitions, and populate {@link workspaceIndex}.
 */
async function startWorkspaceIndexing(): Promise<void> {
  if (!workspaceRoot) {
    connection.console.warn('[ls] no workspace root — skipping indexing');
    return;
  }

  const _t0 = performance.now();
  try {
    // TODO (Phase 1): Implement full workspace scanning.
    connection.console.log(`[ls] workspace indexing complete (stub) ${(performance.now() - _t0).toFixed(0)}ms`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    connection.console.error(`[ls] indexing failed: ${message} ${(performance.now() - _t0).toFixed(0)}ms`);
  }
}

// ---------------------------------------------------------------------------
// Surface index notification from extension (Python daemon → LS)
// ---------------------------------------------------------------------------

connection.onNotification('django/updateSurfaceIndex', (params: {
  surfaceIndex: SurfaceIndex;
  modelNames: string[];
  customLookups?: Record<string, string[]>;
  staticFallback?: Record<string, { fields: string[]; relations: string[] }>;
}) => {
  const _t0 = performance.now();
  const surfaceKeys = Object.keys(params.surfaceIndex);
  const customLookupCount = params.customLookups
    ? Object.values(params.customLookups).reduce((sum, v) => sum + v.length, 0)
    : 0;
  connection.console.log(
    `[ls] received surfaceIndex: ${surfaceKeys.length} labels, ${params.modelNames.length} names` +
    (customLookupCount > 0 ? ` customLookups=${customLookupCount}` : '') +
    (surfaceKeys.length > 0 ? ` first=${surfaceKeys[0]}` : '')
  );

  if (previousSurfaceIndex === null) {
    // --- First load: full build ---
    completionCache.clear();
    const built = buildWorkspaceIndex(params.surfaceIndex, params.modelNames, params.customLookups, params.staticFallback);
    workspaceIndex.models = built.models;
    workspaceIndex.perFile = built.perFile;
    workspaceIndex.modelLabelByName = built.modelLabelByName;
    workspaceIndex.fieldTrieByModel = built.fieldTrieByModel;
    workspaceIndex.lookupTrie = built.lookupTrie;
    workspaceIndex.transformTrie = built.transformTrie;

    // Initialise fingerprint cache for future diffs
    for (const label of Object.keys(params.surfaceIndex)) {
      modelFingerprints.set(label, JSON.stringify(params.surfaceIndex[label]));
    }

    const _buildMs = performance.now() - _t0;
    recordTiming('index.build', _buildMs);
    connection.console.log(
      `[ls] full build: ${built.models.size} models ${_buildMs.toFixed(0)}ms (tries=lazy)`
    );
  } else {
    // --- Incremental update ---
    const diff = diffSurfaceIndex(previousSurfaceIndex, params.surfaceIndex, modelFingerprints);
    const totalChanges = diff.added.length + diff.removed.length + diff.changed.length;

    if (totalChanges === 0) {
      // No-op: surfaceIndex is identical
      incrementCounter('index.noop_update');
      const _noop = performance.now() - _t0;
      connection.console.log(`[ls] incremental update: no-op ${_noop.toFixed(1)}ms`);
    } else {
      updateWorkspaceIndexIncremental(
        workspaceIndex,
        params.surfaceIndex,
        diff,
        params.customLookups,
        previousCustomLookups,
      );

      // Bump version for changed/added models (removed ones no longer exist)
      for (const label of [...diff.added, ...diff.changed]) {
        modelVersions.set(label, (modelVersions.get(label) ?? 0) + 1);
      }
      for (const label of diff.removed) {
        modelVersions.delete(label);
      }

      const _buildMs = performance.now() - _t0;
      recordTiming('index.build', _buildMs);
      connection.console.log(
        `[ls] incremental update: +${diff.added.length} ~${diff.changed.length} -${diff.removed.length} ${_buildMs.toFixed(0)}ms`
      );
    }
  }

  previousSurfaceIndex = params.surfaceIndex;
  previousCustomLookups = params.customLookups;
  setGauge('models.total', workspaceIndex.models.size);
  setGauge('tries.built', workspaceIndex.fieldTrieByModel.size);
});

// ---------------------------------------------------------------------------
// Document events
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 초기 동기화 폭주 감지 (burst detection)
// ---------------------------------------------------------------------------
// VS Code는 LS 시작 시 열린/캐시된 모든 문서에 대해 didChange를 보낸다.
// 11858 파일 프로젝트에서 이 과정이 수십 초 이상 걸릴 수 있다.
// 고정 grace period 대신, 이벤트 빈도 기반으로 초기 동기화를 감지한다:
//   - BURST_WINDOW_MS 내에 BURST_THRESHOLD개 이상 고유 파일이 변경되면 burst
//   - burst 중인 이벤트는 무시 (dirtyFiles에 추가하지 않음)
//   - burst가 아닌 단발성 변경만 실제 편집으로 처리

const BURST_WINDOW_MS = 2000;   // 2초 윈도우
const BURST_THRESHOLD = 10;     // 2초 내 10개 이상 고유 파일 → burst

let _burstWindowStart = Date.now();
let _burstWindowUris = new Set<string>();
let _totalSkipped = 0;
let _initialSyncDone = false;

documents.onDidChangeContent((change) => {
  const now = Date.now();
  const uri = change.document.uri;

  // 윈도우 갱신: 이전 윈도우가 만료되면 리셋
  if (now - _burstWindowStart > BURST_WINDOW_MS) {
    // 이전 윈도우가 burst가 아니었으면 초기 동기화 종료
    if (_burstWindowUris.size < BURST_THRESHOLD && _totalSkipped > 0 && !_initialSyncDone) {
      _initialSyncDone = true;
      connection.console.log(
        `[ls] initial sync settled: skipped ${_totalSkipped} didChange events`
      );
    }
    _burstWindowStart = now;
    _burstWindowUris = new Set<string>();
  }

  _burstWindowUris.add(uri);

  // burst 감지: 현재 윈도우에서 고유 파일 수가 threshold 이상
  if (_burstWindowUris.size >= BURST_THRESHOLD) {
    _totalSkipped++;
    return; // 초기 동기화 burst — 무시
  }

  // 초기 동기화가 완전히 끝나지 않았어도, 단발성 변경은 허용
  dirtyFiles.add(uri);
});

documents.onDidSave((event) => {
  const uri = event.document.uri;
  if (dirtyFiles.has(uri)) {
    dirtyFiles.delete(uri);
    void reindexFile(uri);
  }
});

/**
 * Notify the extension host that a file needs re-indexing.
 * The extension will re-send the surfaceIndex to rebuild the workspace index.
 */
async function reindexFile(uri: string): Promise<void> {
  const shortUri = uri.split('/').slice(-2).join('/');
  connection.console.log(`[ls] reindex request: ${shortUri}`);
  connection.sendNotification('django/fileNeedsReindex', { uri });
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

connection.onCompletion((params: CompletionParams) => {
  const _t0 = performance.now();
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }

  const _t1 = performance.now();
  const context = extractCompletionContext(document, params);
  const _extractMs = performance.now() - _t1;

  if (!context) {
    return [];
  }

  // Cache lookup (includes model version + partial segment for correctness)
  const modelVer = modelVersions.get(context.currentModel) ?? 0;
  const resolvedKey = context.parsedLookup.segments.slice(0, -1).join('__');
  const cacheKey = `${context.currentModel}@${modelVer}::${resolvedKey}::${context.partialSegment}`;
  const cached = completionCache.get(cacheKey);
  if (cached) {
    const _totalMs = performance.now() - _t0;
    recordTiming('completion.total', _totalMs);
    incrementCounter('cache.hit');
    return cached;
  }
  incrementCounter('cache.miss');

  const _t2 = performance.now();

  // Record resolved segments as "used" for frequency-based ranking
  if (context.parsedLookup.resolvedPath.length > 0) {
    recordUsage(context.parsedLookup);
  }

  let items: CompletionItem[];
  // If the FSM resolved at least one segment, use getCompletionCandidates for
  // precise field-type-aware completions. Otherwise fall back to flat trie.
  if (context.parsedLookup.resolvedPath.length > 0 || context.parsedLookup.startModel) {
    const candidates = getCompletionCandidates(
      context.parsedLookup,
      context.partialSegment,
      workspaceIndex,
      usageFrequency,
    );
    items = candidates.map((c, i) => {
      const item: CompletionItem = {
        label: c.name,
        kind: candidateKindToLsp(c.kind),
        detail: c.detail,
        sortText: String(i).padStart(4, '0'),
      };
      if (c.isFuzzyMatch) {
        // Typo correction: show with visual distinction
        item.detail = `\u26A0 did you mean '${c.name}'?`;
        item.sortText = `z_${String(i).padStart(4, '0')}`;
        item.filterText = c.name;
        item.insertText = c.name;
      }
      return item;
    });
  } else {
    items = provideCompletions(context, workspaceIndex);
  }

  const _provideMs = performance.now() - _t2;
  const _totalMs = performance.now() - _t0;
  recordTiming('completion.total', _totalMs);
  recordTiming('completion.extract', _extractMs);
  recordTiming('completion.provide', _provideMs);

  connection.console.log(
    `[ls] completion: ${items.length} items model=${context.currentModel} ` +
    `partial="${context.partialSegment}" extract=${_extractMs.toFixed(0)}ms ` +
    `provide=${_provideMs.toFixed(0)}ms total=${_totalMs.toFixed(0)}ms`
  );

  // Store in cache
  completionCache.set(cacheKey, items);
  if (completionCache.size > COMPLETION_CACHE_MAX) {
    const firstKey = completionCache.keys().next().value;
    if (firstKey !== undefined) {
      completionCache.delete(firstKey);
    }
  }

  return items;
});

function candidateKindToLsp(kind: string): CompletionItemKind {
  switch (kind) {
    case 'field': return CompletionItemKind.Field;
    case 'relation': return CompletionItemKind.Reference;
    case 'lookup': return CompletionItemKind.Value;
    case 'transform': return CompletionItemKind.Function;
    default: return CompletionItemKind.Variable;
  }
}

/**
 * Build a {@link CompletionContext} from the cursor position in the
 * document.  Returns `undefined` when the cursor is not inside a
 * Django ORM lookup string (e.g. inside `.filter(field__lookup=...)`).
 */
function extractCompletionContext(
  document: TextDocument,
  params: CompletionParams,
): CompletionContext | undefined {
  const position = params.position;
  const lineText = document.getText({
    start: { line: position.line, character: 0 },
    end: { line: position.line, character: position.character },
  });

  // Match a keyword argument or identifier with optional __ separators
  // at the end of the line (where the cursor is).
  const lookupMatch = lineText.match(/(\w+(?:__\w*)*)$/);
  if (!lookupMatch) {
    return undefined;
  }

  const rawLookup = lookupMatch[1];
  const segments = rawLookup.split('__');
  const partialSegment = segments[segments.length - 1];

  const currentModel = detectModelFromLine(lineText);
  if (!currentModel) {
    return undefined;
  }

  // Use FSM parser to resolve the chain (e.g. "author__profile__name__ico")
  // The expression passed to FSM excludes the partial last segment when it's
  // a prefix being typed, so the FSM resolves the completed segments.
  const resolvedExpression = segments.length > 1
    ? segments.slice(0, -1).join('__')
    : rawLookup;

  let parsedLookup: ParsedLookup;
  if (segments.length > 1) {
    // Multiple segments: resolve all but the last, keep last as partial
    parsedLookup = parseLookupChain(resolvedExpression, currentModel, workspaceIndex);
  } else {
    // Single segment: nothing to resolve yet, FSM starts from model
    parsedLookup = {
      segments,
      resolvedPath: [],
      state: 'partial',
      startModel: currentModel,
    };
  }

  return {
    documentUri: document.uri,
    position: { line: position.line, character: position.character },
    currentModel,
    parsedLookup,
    partialSegment,
  };
}

// Django queryset methods that accept field lookups as keyword arguments
const QUERYSET_LOOKUP_METHODS = new Set([
  'filter', 'exclude', 'get', 'create', 'update',
  'get_or_create', 'update_or_create',
  'values', 'values_list', 'order_by', 'only', 'defer',
  'select_related', 'prefetch_related',
  'annotate', 'aggregate', 'alias',
]);

/**
 * Detect the Django model from the line text before the cursor.
 * Supports patterns like:
 *   - Model.objects.filter(field__
 *   - Model.objects.all().filter(field__
 *   - qs.filter(field__  (where qs = Model.objects...)
 *   - .filter(field__  (standalone queryset method call)
 */
function detectModelFromLine(lineText: string): string | undefined {
  // Pattern 1: Model.objects[.method(...)...].method(
  const objMatch = lineText.match(/(\w+)\.objects\b/);
  if (objMatch) {
    const className = objMatch[1];
    const label = workspaceIndex.modelLabelByName.get(className);
    if (label) return label;
  }

  // Pattern 2: Scan backwards for an unmatched '(' to find the enclosing call,
  // then check if it's a queryset method.
  const parenPos = findUnmatchedOpenParen(lineText);
  if (parenPos >= 0) {
    // Check the method name before the paren
    const beforeParen = lineText.substring(0, parenPos);
    const methodMatch = beforeParen.match(/\.(\w+)\s*$/);
    if (methodMatch && QUERYSET_LOOKUP_METHODS.has(methodMatch[1])) {
      // Found .filter( / .exclude( etc. Now find the receiver model.
      const beforeMethod = beforeParen.substring(0, beforeParen.length - methodMatch[0].length);

      // Try to find Model.objects in the receiver chain
      const receiverObjMatch = beforeMethod.match(/(\w+)\.objects\b/);
      if (receiverObjMatch) {
        const label = workspaceIndex.modelLabelByName.get(receiverObjMatch[1]);
        if (label) return label;
      }
    }
  }

  return undefined;
}

/**
 * Find the position of the last unmatched '(' scanning backwards.
 */
function findUnmatchedOpenParen(text: string): number {
  let depth = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === ')') depth++;
    else if (text[i] === '(') {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Performance report
// ---------------------------------------------------------------------------

connection.onRequest('django/perfReport', () => {
  return {
    stats: getAllStats(),
    counters: getAllCounters(),
    gauges: getAllGauges(),
    snapshot: {
      modelCount: workspaceIndex.models.size,
      triesBuilt: workspaceIndex.fieldTrieByModel.size,
      completionCacheSize: completionCache.size,
    },
  };
});

// ---------------------------------------------------------------------------
// Start listening
// ---------------------------------------------------------------------------

documents.listen(connection);
connection.listen();
