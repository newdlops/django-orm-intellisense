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
  applyStaticFallbackDelta,
  includeStaticFallbackChanges,
  updateWorkspaceIndexIncremental,
  type SurfaceIndex,
  type SurfaceIndexDiff,
  type StaticFallback,
} from './workspaceIndexer.js';
import { loadSurfaceCache, saveSurfaceCacheAsync, type SurfaceCachePayload } from './nativeCache.js';
import { SurfaceCacheWriter } from './surfaceCacheWriter.js';
import { SurfaceCachePrewarmer } from './surfaceCachePrewarmer.js';
import { isSurfaceCacheContext, type SurfaceCacheContext, type SurfaceSourceProvenance } from '../client/surfaceSourceProvenance';
import { SaveReindexTracker } from './saveReindexTracker.js';
import { applyLookupCatalogDelta, type LookupCatalogDelta } from './lookupCatalog.js';
import { attachProjectModelSources, projectForFile, projectWorkspaceView } from './projectScope.js';
import type { DjangoProjectContext } from '../client/protocol.js';
import { parseLookupChain, getCompletionCandidates } from './lookupResolver.js';
import { recordTiming, incrementCounter, setGauge, getAllStats, getAllCounters, getAllGauges } from './perfTracker.js';
import { CompletionItemKind } from 'vscode-languageserver/node';
import type { CompletionItem } from 'vscode-languageserver/node';
import * as fs from 'fs';
import * as path from 'path';
import { SurfaceSnapshotDecoder } from '../client/daemon/surfaceSnapshotTransport';
import type { SurfaceIndexChangedNotificationMessage } from '../client/protocol';

type CompletionLabelDetails = {
  detail?: string;
  description?: string;
};

// ---------------------------------------------------------------------------
// Connection & document manager
// ---------------------------------------------------------------------------

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// ---------------------------------------------------------------------------
// Workspace state
// ---------------------------------------------------------------------------

let workspaceRoot: string | null = null;

const saveReindexTracker = new SaveReindexTracker();

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

let projectContexts: DjangoProjectContext[] = [];
const projectViews = new Map<string, WorkspaceIndex>();
function refreshProjectViews(): void {
  projectViews.clear();
  attachProjectModelSources(workspaceIndex, projectContexts);
}
function indexForDocument(uri: string): WorkspaceIndex {
  if (!projectContexts.length) return workspaceIndex;
  const key = projectForFile(projectContexts, uri)?.namespace ?? '';
  let view = projectViews.get(key);
  if (!view) {
    view = projectWorkspaceView(workspaceIndex, projectContexts, uri);
    projectViews.set(key, view);
  }
  return view;
}

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
let previousModelNames: string[] = [];
let previousSourceProvenance: SurfaceSourceProvenance | null = null;
let nativeCacheContext: SurfaceCacheContext | null = null;
let previousCustomLookups: Record<string, string[]> | undefined;
let previousCustomLookupsFingerprint: string | undefined;
let previousStaticFallback: StaticFallback | undefined;
let previousStaticFallbackFingerprint: string | null | undefined;
const modelVersions = new Map<string, number>();
const modelFingerprints = new Map<string, string>();
// This baseline belongs to full-snapshot transport, independently of source deltas.
const surfaceSnapshotDecoder = new SurfaceSnapshotDecoder();

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
      experimental: { djangoSurfaceSnapshotTransport: 1 },
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

  // The resolved interpreter/settings context arrives before Python setup.
  // The worker verifies producer-bound sources before exposing a cache hint.

  connection.console.log('[ls] initialized — starting workspace indexing');
  void startWorkspaceIndexing();
});

const nativeCachePrewarmer = new SurfaceCachePrewarmer<SurfaceCachePayload>({
  load: async context => {
    const start = performance.now();
    const cached = await loadSurfaceCache(context.workspaceRoot, context);
    connection.console.log(`[ls] native cache pre-warm: ${cached ? 'validated' : 'miss'} (${(performance.now() - start).toFixed(1)}ms)`);
    return cached;
  },
  hasResident: () => previousSurfaceIndex !== null,
  apply: cached => {
  const _t0 = performance.now();
  const built = buildWorkspaceIndex(
    cached.surfaceIndex,
    cached.modelNames,
    cached.customLookups,
    cached.staticFallback,
    cached.lookupCatalog,
  );
  workspaceIndex.models = built.models;
  workspaceIndex.perFile = built.perFile;
  workspaceIndex.modelLabelByName = built.modelLabelByName;
  workspaceIndex.fieldTrieByModel = built.fieldTrieByModel;
  workspaceIndex.lookupTrie = built.lookupTrie;
  workspaceIndex.transformTrie = built.transformTrie;
  workspaceIndex.lookupCatalog = built.lookupCatalog;
  workspaceIndex.lookupTypes = built.lookupTypes;
  previousSurfaceIndex = cached.surfaceIndex;
  previousModelNames = cached.modelNames;
  previousSourceProvenance = cached.sourceProvenance ?? null;
  previousCustomLookups = cached.customLookups;
  previousCustomLookupsFingerprint = cached.customLookupsFingerprint;
  previousStaticFallback = cached.staticFallback;
  previousStaticFallbackFingerprint = cached.staticFallbackFingerprint;
  modelFingerprints.clear();
  for (const label of Object.keys(cached.surfaceIndex)) {
    modelFingerprints.set(
      label,
      cached.surfaceFingerprints?.[label] ?? JSON.stringify(cached.surfaceIndex[label]),
    );
  }
  setGauge('models.total', workspaceIndex.models.size);
  const _elapsed = performance.now() - _t0;
  recordTiming('index.prewarm', _elapsed);
  connection.console.log(
    `[ls] native cache pre-warm: ${built.models.size} models ${_elapsed.toFixed(1)}ms`,
  );
  },
});

connection.onRequest('django/setSurfaceCacheContext', (value: unknown) => {
  const context = isSurfaceCacheContext(value) ? value : null;
  if (JSON.stringify(context) !== JSON.stringify(nativeCacheContext) && previousSurfaceIndex !== null) {
    surfaceCacheWriter.clear();
    replaceWorkspaceIndexFromSurface({ surfaceIndex: {}, modelNames: [] });
    previousSurfaceIndex = null;
    previousSourceProvenance = null;
    previousModelNames = [];
    surfaceSnapshotDecoder.reset();
    modelVersions.clear();
    completionCache.clear();
  }
  nativeCacheContext = context;
  nativeCachePrewarmer.update(context);
  return { applied: true };
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

function replaceWorkspaceIndexFromSurface(params: {
  projectContexts?: DjangoProjectContext[];
  lookupCatalog?: import('./lookupCatalog').LookupCatalogPayload;
  surfaceIndex: SurfaceIndex;
  modelNames?: string[];
  customLookups?: Record<string, string[]>;
  surfaceFingerprints?: Record<string, string>;
  staticFallback?: StaticFallback;
  staticFallbackFingerprint?: string | null;
  customLookupsFingerprint?: string;
}): number {
  const built = buildWorkspaceIndex(
    params.surfaceIndex,
    params.modelNames ?? [],
    params.customLookups,
    params.staticFallback,
    params.lookupCatalog,
  );
  workspaceIndex.models = built.models;
  workspaceIndex.perFile = built.perFile;
  workspaceIndex.modelLabelByName = built.modelLabelByName;
  workspaceIndex.fieldTrieByModel = built.fieldTrieByModel;
  workspaceIndex.lookupTrie = built.lookupTrie;
  workspaceIndex.transformTrie = built.transformTrie;
  workspaceIndex.lookupCatalog = built.lookupCatalog;
  workspaceIndex.lookupTypes = built.lookupTypes;
  projectContexts = params.projectContexts ?? [];
  refreshProjectViews();
  previousSurfaceIndex = params.surfaceIndex;
  previousCustomLookups = params.customLookups;
  previousCustomLookupsFingerprint = params.customLookupsFingerprint;
  previousStaticFallback = params.staticFallback;
  previousStaticFallbackFingerprint = params.staticFallbackFingerprint;
  modelFingerprints.clear();
  for (const label of Object.keys(params.surfaceIndex)) {
    modelFingerprints.set(
      label,
      params.surfaceFingerprints?.[label] ?? JSON.stringify(params.surfaceIndex[label]),
    );
  }
  return built.models.size;
}

const surfaceCacheWriter = new SurfaceCacheWriter<void>(async () => {
  if (previousSurfaceIndex === null || !previousSourceProvenance) return;
  await saveSurfaceCacheAsync(previousSourceProvenance.root, {
    sourceProvenance: previousSourceProvenance,
    surfaceIndex: previousSurfaceIndex,
    modelNames: previousModelNames,
    surfaceFingerprints: Object.fromEntries(modelFingerprints),
    customLookups: previousCustomLookups,
    lookupCatalog: workspaceIndex.lookupCatalog,
    customLookupsFingerprint: previousCustomLookupsFingerprint,
    staticFallback: previousStaticFallback,
    staticFallbackFingerprint: previousStaticFallbackFingerprint,
  });
});

function persistSurfaceCacheSnapshot(): void {
  if (previousSurfaceIndex === null || !previousSourceProvenance) {
    return;
  }
  // Capture resident state when this request starts; older pending requests
  // are replaced so a delayed native save cannot accumulate serializations.
  surfaceCacheWriter.schedule();
}

// ---------------------------------------------------------------------------
// Surface index notification from extension (Python daemon → LS)
// ---------------------------------------------------------------------------

connection.onRequest('django/clearSurfaceIndex', () => {
  nativeCachePrewarmer.invalidate();
  previousSourceProvenance = null;
  previousModelNames = [];
  // Retire only resident session data. Keep the last source-validated disk
  // cache for the next startup; an empty retirement must never replace it.
  surfaceCacheWriter.clear();
  replaceWorkspaceIndexFromSurface({ surfaceIndex: {}, modelNames: [] });
  previousSurfaceIndex = null;
  surfaceSnapshotDecoder.reset();
  completionCache.clear();
  modelVersions.clear();
  setGauge('models.total', 0);
  setGauge('tries.built', 0);
  return { applied: true };
});

function applySurfaceIndex(params: {
  projectContexts?: DjangoProjectContext[];
  sourceProvenance?: SurfaceSourceProvenance | null;
  lookupCatalog?: import('./lookupCatalog').LookupCatalogPayload;
  surfaceIndex: SurfaceIndex;
  modelNames?: string[];
  surfaceFingerprints?: Record<string, string>;
  customLookups?: Record<string, string[]>;
  customLookupsFingerprint?: string;
  staticFallback?: StaticFallback;
  staticFallbackFingerprint?: string | null;
}): { applied: boolean } {
  nativeCachePrewarmer.invalidate();
  previousSourceProvenance = null;
  const _t0 = performance.now();
  const surfaceKeys = Object.keys(params.surfaceIndex);
  const customLookupCount = params.customLookups
    ? Object.values(params.customLookups).reduce((sum, v) => sum + v.length, 0)
    : 0;
  connection.console.log(
    `[ls] received surfaceIndex: ${surfaceKeys.length} labels` +
    (customLookupCount > 0 ? ` customLookups=${customLookupCount}` : '') +
    (surfaceKeys.length > 0 ? ` first=${surfaceKeys[0]}` : '')
  );

  if (previousSurfaceIndex === null) {
    // --- First load: full build ---
    completionCache.clear();
    const modelCount = replaceWorkspaceIndexFromSurface(params);

    const _buildMs = performance.now() - _t0;
    recordTiming('index.build', _buildMs);
    connection.console.log(
      `[ls] full build: ${modelCount} models ${_buildMs.toFixed(0)}ms (tries=lazy)`
    );
  } else {
    // --- Incremental update ---
    const diff = diffSurfaceIndex(
      previousSurfaceIndex,
      params.surfaceIndex,
      modelFingerprints,
      params.surfaceFingerprints,
    );
    const totalChanges = diff.added.length + diff.removed.length + diff.changed.length;

    // Whole snapshots remain authoritative when only registry/catalog overlays
    // change, a producer omits a global fingerprint, or short-name order moves.
    // Source deltas can also change these public values between wire snapshots.
    const lookupMetadataChanged = previousCustomLookupsFingerprint !== params.customLookupsFingerprint
      || JSON.stringify(previousCustomLookups) !== JSON.stringify(params.customLookups)
      || JSON.stringify(workspaceIndex.lookupCatalog) !== JSON.stringify(params.lookupCatalog);
    const staticFallbackChanged =
      previousStaticFallbackFingerprint !== (params.staticFallbackFingerprint ?? null)
      || JSON.stringify(previousStaticFallback ?? null) !== JSON.stringify(params.staticFallback ?? null);
    const modelOrderChanged = JSON.stringify(Object.keys(previousSurfaceIndex)) !== JSON.stringify(surfaceKeys);
    if (lookupMetadataChanged || staticFallbackChanged || modelOrderChanged) {
      completionCache.clear();
      replaceWorkspaceIndexFromSurface(params);
    } else if (totalChanges === 0) {
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
        params.staticFallback,
        params.lookupCatalog,
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
  previousSourceProvenance = params.sourceProvenance ?? null;
  previousModelNames = params.modelNames ?? [];
  previousCustomLookups = params.customLookups;
  previousCustomLookupsFingerprint = params.customLookupsFingerprint;
  previousStaticFallback = params.staticFallback;
  previousStaticFallbackFingerprint = params.staticFallbackFingerprint;
  projectContexts = params.projectContexts ?? [];
  refreshProjectViews();
  setGauge('models.total', workspaceIndex.models.size);
  setGauge('tries.built', workspaceIndex.fieldTrieByModel.size);

  persistSurfaceCacheSnapshot();
  return { applied: true };
}

function recoverFailedSurfaceUpdate<T>(apply: (params: T) => { applied: boolean }): (params: T) => { applied: boolean } {
  return params => {
    try {
      return apply(params);
    } catch (error) {
      // A failed incremental build may already have advanced its surface
      // fingerprints. The next full snapshot must rebuild, even if those
      // fingerprints match, rather than acknowledge a damaged index as a no-op.
      previousSurfaceIndex = null;
      previousSourceProvenance = null;
      nativeCachePrewarmer.invalidate();
      surfaceSnapshotDecoder.reset();
      completionCache.clear();
      throw error;
    }
  };
}

const applySurfaceIndexSafely = recoverFailedSurfaceUpdate((params: NonNullable<SurfaceIndexChangedNotificationMessage['params']>) => {
  const complete = surfaceSnapshotDecoder.decode(params);
  if (!complete.surfaceIndex) throw new Error('Full surface snapshot is missing.');
  return applySurfaceIndex(complete as Parameters<typeof applySurfaceIndex>[0]);
});
connection.onNotification('django/updateSurfaceIndex', applySurfaceIndexSafely);
connection.onRequest('django/updateSurfaceIndex', applySurfaceIndexSafely);

function applySurfaceIndexDelta(params: {
  projectContexts?: DjangoProjectContext[];
  lookupCatalogDelta?: LookupCatalogDelta;
  surfaceIndexDelta: SurfaceIndex;
  surfaceFingerprints?: Record<string, string>;
  addedLabels?: string[];
  changedLabels?: string[];
  removedLabels?: string[];
  staticFallback?: StaticFallback | null;
  staticFallbackDelta?: StaticFallback;
  removedStaticFallbackLabels?: string[];
  staticFallbackFingerprint?: string | null;
}): { applied: boolean } {
  nativeCachePrewarmer.invalidate();
  previousSourceProvenance = null;
  if (params.projectContexts) {
    projectContexts = params.projectContexts;
    refreshProjectViews();
    completionCache.clear();
  }
  if (previousSurfaceIndex === null) {
    connection.console.warn('[ls] surfaceIndex delta ignored before initial snapshot');
    return { applied: false };
  }

  const _t0 = performance.now();
  const added = params.addedLabels ?? [];
  const changed = params.changedLabels ?? [];
  const removed = params.removedLabels ?? [];
  const totalChanges = added.length + changed.length + removed.length;
  const hasFallbackDeltaChanges = Boolean(Object.keys(params.staticFallbackDelta ?? {}).length
    || params.removedStaticFallbackLabels?.length);
  const hasUnfingerprintedFallback = params.staticFallback !== undefined
    && params.staticFallbackFingerprint == null;
  const nextStaticFallbackFingerprint = params.staticFallbackFingerprint !== undefined
    ? params.staticFallbackFingerprint
    : hasFallbackDeltaChanges || hasUnfingerprintedFallback ? null : previousStaticFallbackFingerprint ?? null;
  const staticFallbackChanged = (previousStaticFallbackFingerprint ?? null) !== nextStaticFallbackFingerprint
    || hasUnfingerprintedFallback;
  if (totalChanges === 0 && !Object.keys(params.lookupCatalogDelta ?? {}).length
    && !hasFallbackDeltaChanges && !staticFallbackChanged) {
    incrementCounter('index.noop_update');
    connection.console.log('[ls] incremental delta update: no-op');
    return { applied: true };
  }

  if (params.lookupCatalogDelta) applyLookupCatalogDelta(workspaceIndex, params.lookupCatalogDelta);

  for (const label of removed) {
    delete previousSurfaceIndex[label];
    modelFingerprints.delete(label);
    modelVersions.delete(label);
  }
  for (const label of [...added, ...changed]) {
    const nextEntry = params.surfaceIndexDelta[label];
    if (!nextEntry) {
      continue;
    }
    previousSurfaceIndex[label] = nextEntry;
    modelFingerprints.set(
      label,
      params.surfaceFingerprints?.[label] ?? JSON.stringify(nextEntry),
    );
  }

  if (staticFallbackChanged && (params.staticFallbackDelta === undefined || params.staticFallback !== undefined)) {
    previousStaticFallback = params.staticFallbackDelta !== undefined
      ? applyStaticFallbackDelta(params.staticFallback ?? undefined, params.staticFallbackDelta, params.removedStaticFallbackLabels)
      : params.staticFallback ?? undefined;
    previousStaticFallbackFingerprint = nextStaticFallbackFingerprint;
    completionCache.clear();
    const modelCount = replaceWorkspaceIndexFromSurface({
      projectContexts,
      surfaceIndex: previousSurfaceIndex,
      surfaceFingerprints: Object.fromEntries(modelFingerprints),
      customLookups: previousCustomLookups,
      customLookupsFingerprint: previousCustomLookupsFingerprint,
      lookupCatalog: workspaceIndex.lookupCatalog,
      staticFallback: previousStaticFallback,
      staticFallbackFingerprint: previousStaticFallbackFingerprint,
    });
    const _buildMs = performance.now() - _t0;
    recordTiming('index.build', _buildMs);
    connection.console.log(
      `[ls] full rebuild from delta (staticFallback changed): ${modelCount} models ${_buildMs.toFixed(0)}ms`
    );
    setGauge('models.total', workspaceIndex.models.size);
    setGauge('tries.built', workspaceIndex.fieldTrieByModel.size);
    persistSurfaceCacheSnapshot();
    return { applied: true };
  }

  if (params.staticFallbackDelta !== undefined) {
    previousStaticFallback = applyStaticFallbackDelta(
      params.staticFallback !== undefined ? params.staticFallback ?? undefined : previousStaticFallback,
      params.staticFallbackDelta, params.removedStaticFallbackLabels,
    );
    previousStaticFallbackFingerprint = nextStaticFallbackFingerprint;
  }
  const modelDiff = includeStaticFallbackChanges(
    workspaceIndex, previousSurfaceIndex, previousStaticFallback,
    { added, changed, removed }, params.staticFallbackDelta, params.removedStaticFallbackLabels,
  );

  updateWorkspaceIndexIncremental(
    workspaceIndex,
    previousSurfaceIndex,
    modelDiff,
    previousCustomLookups,
    previousCustomLookups,
    previousStaticFallback,
  );
  refreshProjectViews();

  for (const label of [...modelDiff.added, ...modelDiff.changed]) {
    modelVersions.set(label, (modelVersions.get(label) ?? 0) + 1);
  }
  for (const label of modelDiff.removed) modelVersions.delete(label);

  const _buildMs = performance.now() - _t0;
  recordTiming('index.build', _buildMs);
  connection.console.log(
    `[ls] incremental delta update: +${added.length} ~${changed.length} -${removed.length} ${_buildMs.toFixed(0)}ms`
  );
  setGauge('models.total', workspaceIndex.models.size);
  setGauge('tries.built', workspaceIndex.fieldTrieByModel.size);
  persistSurfaceCacheSnapshot();
  return { applied: true };
}

const applySurfaceIndexDeltaSafely = recoverFailedSurfaceUpdate(applySurfaceIndexDelta);
connection.onNotification('django/updateSurfaceIndexDelta', applySurfaceIndexDeltaSafely);
connection.onRequest('django/updateSurfaceIndexDelta', applySurfaceIndexDeltaSafely);

// ---------------------------------------------------------------------------
// Document events
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 초기 동기화 폭주 감지 (burst detection)
// ---------------------------------------------------------------------------
// TextDocuments emits onDidOpen before its initial onDidChangeContent event.
// Suppress that event explicitly; edit bursts must never discard real saves.
documents.onDidOpen(event => saveReindexTracker.opened(event.document.uri));
documents.onDidChangeContent(event => saveReindexTracker.changed(event.document.uri));
documents.onDidClose(event => saveReindexTracker.closed(event.document.uri));

documents.onDidSave((event) => {
  const uri = event.document.uri;
  if (saveReindexTracker.saved(uri)) {
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
  const index = indexForDocument(document.uri);
  const context = extractCompletionContext(document, params, index);
  const _extractMs = performance.now() - _t1;

  if (!context) {
    return [];
  }

  // Cache lookup (includes model version + partial segment for correctness)
  const modelVer = modelVersions.get(context.currentModel) ?? 0;
  const resolvedKey = context.parsedLookup.segments.slice(0, -1).join('__');
  const cacheKey = `${context.currentModel}@${modelVer}::${resolvedKey}::${context.partialSegment}::${context.method ?? ''}`;
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
      index,
      context.method,
      usageFrequency,
    );
    items = candidates.map((c, i) => {
      const item: CompletionItem = {
        label: c.name,
        kind: candidateKindToLsp(c.kind),
        detail: c.detail,
        sortText: String(i).padStart(4, '0'),
      };
      if (c.kind === 'relation') {
        const labelDetails = relationCompletionLabelDetails(c.detail);
        if (labelDetails) {
          (item as CompletionItem & { labelDetails?: CompletionLabelDetails }).labelDetails = labelDetails;
        }
      }
      const canContinue =
        c.kind === 'relation' ||
        c.kind === 'transform' ||
        (c.kind === 'field' && LOOKUP_CONTINUATION_METHODS.has(context.method ?? ''));
      if (canContinue) {
        item.insertText = c.name.endsWith('__') ? c.name : `${c.name}__`;
        item.command = {
          title: 'Continue Django ORM lookup',
          command: 'editor.action.triggerSuggest',
        };
      }
      if (c.isFuzzyMatch) {
        // Typo correction: show with visual distinction
        item.detail = `\u26A0 did you mean '${c.name}'?`;
        item.sortText = `z_${String(i).padStart(4, '0')}`;
        item.filterText = c.name;
        item.insertText = c.name;
        item.command = undefined;
      }
      return item;
    });
  } else {
    items = provideCompletions(context, index);
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

function relationCompletionLabelDetails(
  detail: string | undefined
): CompletionLabelDetails | undefined {
  if (!detail) {
    return undefined;
  }

  const [fieldKind, description] = detail.split(' · ');
  if (!fieldKind || !description) {
    return undefined;
  }

  return {
    detail: ` (${fieldKind})`,
    description,
  };
}

/**
 * Build a {@link CompletionContext} from the cursor position in the
 * document.  Returns `undefined` when the cursor is not inside a
 * Django ORM lookup string (e.g. inside `.filter(field__lookup=...)`).
 */
function extractCompletionContext(
  document: TextDocument,
  params: CompletionParams,
  index: WorkspaceIndex,
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

  const currentModel = detectModelFromLine(lineText, index);
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
    parsedLookup = parseLookupChain(`${resolvedExpression}__`, currentModel, index, detectCompletionMethod(lineText));
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
    method: detectCompletionMethod(lineText),
  };
}

function detectCompletionMethod(lineText: string): string | undefined {
  const match = lineText.match(/\.([A-Za-z_][\w]*)\([^()]*$/);
  return match?.[1];
}

// Django queryset methods that accept field lookups as keyword arguments
const QUERYSET_LOOKUP_METHODS = new Set([
  'filter', 'exclude', 'get', 'create', 'update',
  'get_or_create', 'update_or_create',
  'values', 'values_list', 'order_by', 'only', 'defer',
  'select_related', 'prefetch_related',
  'annotate', 'aggregate', 'alias',
]);
const LOOKUP_CONTINUATION_METHODS = new Set(['filter', 'exclude', 'get']);

/**
 * Detect the Django model from the line text before the cursor.
 * Supports patterns like:
 *   - Model.objects.filter(field__
 *   - Model.objects.all().filter(field__
 *   - qs.filter(field__  (where qs = Model.objects...)
 *   - .filter(field__  (standalone queryset method call)
 */
function detectModelFromLine(lineText: string, index: WorkspaceIndex): string | undefined {
  // Pattern 1: Model.objects[.method(...)...].method(
  const objMatch = lineText.match(/(\w+)\.objects\b/);
  if (objMatch) {
    const className = objMatch[1];
    const label = index.modelLabelByName.get(className);
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
        const label = index.modelLabelByName.get(receiverObjMatch[1]);
        if (label) return label;
      }

      // Pattern 3: Reverse relation manager — e.g. xxx.question_thread_set.create(
      // Extract the last dotted segment before .method( and check if it's a
      // known reverse relation name on any model.
      const lastSegmentMatch = beforeMethod.match(/\.(\w+)\s*$/);
      if (lastSegmentMatch) {
        const possibleRelName = lastSegmentMatch[1];
        for (const [, modelInfo] of index.models) {
          const reverseRel = modelInfo.reverseRelations.get(possibleRelName);
          if (reverseRel) {
            return reverseRel.targetModelLabel;
          }
        }
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
// Batch lookup path validation (replaces N individual daemon IPC calls)
// ---------------------------------------------------------------------------

interface ValidateLookupPathsParams {
  paths: Array<{
    baseModelLabel: string;
    value: string;
    method: string;
  }>;
}

interface ValidateLookupPathResult {
  resolved: boolean;
  reason?: string;
  missingSegment?: string;
}

connection.onRequest('django/validateLookupPaths', (params: ValidateLookupPathsParams): ValidateLookupPathResult[] => {
  const _t0 = performance.now();
  const results = params.paths.map(({ baseModelLabel, value, method }) => {
    if (!workspaceIndex.models.has(baseModelLabel)) {
      return { resolved: true };  // Unknown model — skip (don't flag as error)
    }

    const parsed = parseLookupChain(value, baseModelLabel, workspaceIndex, method);
    if (parsed.runtimeRequired) return { resolved: true };

    // The parser also serves completion: an unknown final segment is partial.
    // A validation request must resolve every nonempty segment, as the client
    // local validator does. Keep trailing empty completion segments accepted.
    if (parsed.state === 'error' || (
      parsed.state === 'partial'
      && parsed.resolvedPath.length < parsed.segments.filter(Boolean).length
    )) {
      const errorIdx = parsed.errorAt ?? parsed.resolvedPath.length;
      const errorSegment = parsed.segments[errorIdx] ?? value;
      const lastResolved = parsed.resolvedPath[parsed.resolvedPath.length - 1];

      // Determine reason based on FSM state
      let reason = 'segment_not_found';
      if (lastResolved?.kind === 'field' && errorIdx > 0) {
        // A non-relation field was followed by more segments
        reason = 'non_relation_intermediate';
      } else if (
        parsed.resolvedPath.length > 0 &&
        lastResolved?.kind !== 'relation' &&
        lastResolved?.kind !== 'reverse_relation'
      ) {
        // After a field, the next segment should be a lookup operator
        reason = 'invalid_lookup_operator';
      }

      return {
        resolved: false,
        reason,
        missingSegment: errorSegment,
      };
    }

    return { resolved: true };
  });

  const elapsed = performance.now() - _t0;
  if (params.paths.length > 0) {
    connection.console.log(
      `[ls] validateLookupPaths: ${params.paths.length} paths, ` +
      `${results.filter(r => !r.resolved).length} errors, ${elapsed.toFixed(1)}ms`
    );
  }

  return results;
});

// ---------------------------------------------------------------------------
// Start listening
// ---------------------------------------------------------------------------

documents.listen(connection);
connection.listen();
