import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { AsyncLocalStorage } from 'async_hooks';
import { withKnownNativeMemberReturn } from './ormMemberConfidence';
import { applyLookupCatalogDelta } from '../../server/lookupCatalog';
import { attachProjectModelSources, projectForFile, projectWorkspaceView } from '../../server/projectScope';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { SurfaceSnapshotDecoder } from './surfaceSnapshotTransport';
import { SourceConfigurationRequests } from './sourceConfigurationRequests';
import type { SourceObservationContext } from '../sourceObservation';
import { captureNativeSourceBoundary } from '../native/sourceWatcher';
import { daemonProcessLaunch } from './nativeProcessLaunch';
import { prepareNativeDaemonState, type NativeDaemonStateOwner } from './nativeDaemonState';
import { isSurfaceSourceProvenance, type SurfaceCacheContext, type SurfaceSourceProvenance } from '../surfaceSourceProvenance';
import { fingerprintLaunchEnvironment } from '../launchEnvironment';
import { PythonRuntimeCompatibility } from '../python/runtimeCompatibility';
import * as vscode from 'vscode';
import { getExtensionSettings } from '../config/settings';
import { normalizeSourcePath } from '../sourceWatcher';
import {
  decompressIpcEnvelope,
  isCompressedEnvelope,
} from './ipcCompression';
import {
  hydrateNativeFastPathFromSurface,
  isNativeFastPathReady,
  dropNativeFastPath,
  ensureNativeAstModules,
  waitForPendingNativeAstModules,
  resetNativeAstModulesFlag,
  nativeResolveRelationTarget,
  nativeListRelationTargets,
  nativeResolveLookupPath,
  nativeResolveOrmMember,
  nativeListLookupPathCompletions,
  nativeListOrmMemberCompletions,
  nativeResolveExportOrigin,
  nativeResolveModule,
} from './nativeFastPath';
import {
  resolvePythonInterpreter,
  validatePythonInterpreterPath,
} from '../python/interpreter';
import type {
  ExportOriginResolution,
  HealthSnapshot,
  LookupPathItem,
  InitializeResult,
  LookupPathCompletionsResult,
  LookupPathResolution,
  ModuleResolution,
  OrmMemberChainResolution,
  OrmMemberCompletionsResult,
  OrmMemberItem,
  OrmMemberResolution,
  OrmReceiverKind,
  ReindexFileResult,
  DeletedSourceFilesResult,
  RelationTargetResolution,
  RelationTargetsResult,
  RequestMessage,
  ResponseMessage,
  ServerMessage,
  DjangoProjectContext,
} from '../protocol';
import {
  buildModelLabelByName,
  buildWorkspaceIndex,
  diffSurfaceIndex,
  applyStaticFallbackDelta,
  includeStaticFallbackChanges,
  updateWorkspaceIndexIncremental,
  type StaticFallback,
  type SurfaceIndex,
} from '../../server/workspaceIndexer';
import { parseLookupChain, getCompletionCandidates, supportsLookupTransforms, FILTER_LOOKUP_METHODS, relationAllowedForMethod } from '../../server/lookupResolver';
import { operandPythonType, pythonTypeForKind } from '../../server/fieldLookups';
import { djangoBuiltinAvailable } from '../../server/djangoVersion';
import type {
  FieldInfo,
  ModelInfo,
  ParsedLookup,
  PrefixCandidate,
  WorkspaceIndex,
} from '../../server/types';

const REQUEST_TIMEOUT_MS = 8_000;
const INITIALIZE_REQUEST_TIMEOUT_MS = 60_000;
const RESPONSE_CACHE_LIMIT = 2048;
const RESPONSE_CACHE_TTL_MS = 30_000;
const DIAGNOSTIC_CACHE_TTL_MS = 120_000;
const MAX_PENDING_REQUESTS = 64;
const MAX_PAYLOAD_BYTES = 512 * 1024; // 512KB
const LOCAL_LOOKUP_RELATION_ONLY_METHODS = new Set([
  'select_related',
  'prefetch_related',
]);
const LOCAL_LOOKUP_ALIAS_SENSITIVE_METHODS = new Set<string>();
const LOCAL_LOOKUP_OPERATOR_METHODS = FILTER_LOOKUP_METHODS;
const LOCAL_LOOKUP_CHAIN_DEPTH = 2;

function normalizeLookupPathValue(value: string, method: string): string {
  const trimmed = value.trim();
  return method === 'order_by' && trimmed.startsWith('-')
    ? trimmed.slice(1)
    : trimmed;
}

const LOCAL_QUERYSET_RETURNING_METHODS = [
  'filter', 'exclude', 'all', 'annotate', 'alias', 'order_by', 'only',
  'defer', 'select_related', 'prefetch_related', 'distinct', 'using',
  'reverse', 'none', 'select_for_update', 'get_queryset',
  'fetch_mode',
];
const LOCAL_INSTANCE_RETURNING_METHODS = [
  'get', 'first', 'last', 'earliest', 'latest', 'create',
  'get_or_create', 'update_or_create',
];
const LOCAL_SCALAR_QUERYSET_METHODS = [
  'count', 'exists', 'update', 'delete', 'aggregate', 'values', 'values_list',
  'iterator', 'in_bulk', 'bulk_create', 'bulk_update',
];
const LOCAL_INSTANCE_METHODS = [
  'save', 'delete', 'full_clean', 'clean', 'clean_fields', 'validate_unique',
  'validate_constraints', 'refresh_from_db', 'serializable_value',
  'get_deferred_fields', 'asave', 'arefresh_from_db',
];

type IpcRequestSource =
  | 'completion'
  | 'diagnostic'
  | 'hover'
  | 'signature'
  | 'definition'
  | 'initialSync'
  | 'reindex'
  | 'health'
  | 'command'
  | 'unknown';

function createEmptyWorkspaceIndex(): WorkspaceIndex {
  return {
    models: new Map(),
    perFile: new Map(),
    modelLabelByName: new Map(),
    fieldTrieByModel: new Map(),
    lookupTrie: { children: new Map(), isTerminal: false },
    transformTrie: { children: new Map(), isTerminal: false },
  };
}

interface LocalLookupTraversal {
  completionMode: 'field' | 'field_and_lookup' | 'lookup';
  currentModelLabel: string;
  lookupField?: FieldInfo;
  lookupFieldOwnerLabel?: string;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface LaunchContext {
  resource?: vscode.Uri;
  workspaceRoot: string;
  pythonPath: string;
  pythonSource: string;
  pythonSourceDetail: string;
  settingsModule?: string;
}

function buildPythonEnvironment(
  extensionPythonRoot: string,
  interpreterPath: string
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    DJANGO_ORM_INTELLISENSE: '1',
    PYTHONPATH: extensionPythonRoot,
    PYTHONUNBUFFERED: '1',
  };

  delete environment.PYTHONHOME;
  delete environment.__PYVENV_LAUNCHER__;
  delete environment.VIRTUAL_ENV;

  const virtualEnvironmentRoot = findVirtualEnvironmentRoot(interpreterPath);
  if (virtualEnvironmentRoot) {
    environment.VIRTUAL_ENV = virtualEnvironmentRoot;
    environment.PATH = prependToPath(
      path.join(
        virtualEnvironmentRoot,
        process.platform === 'win32' ? 'Scripts' : 'bin'
      ),
      process.env.PATH
    );
  }

  return environment;
}

function findVirtualEnvironmentRoot(interpreterPath: string): string | undefined {
  const executableDirectory = path.dirname(interpreterPath);
  const directoryName = path.basename(executableDirectory).toLowerCase();
  if (directoryName !== 'bin' && directoryName !== 'scripts') {
    return undefined;
  }

  const candidateRoot = path.dirname(executableDirectory);
  return fs.existsSync(path.join(candidateRoot, 'pyvenv.cfg'))
    ? candidateRoot
    : undefined;
}

function prependToPath(
  segment: string,
  existingPath: string | undefined
): string {
  if (!existingPath) {
    return segment;
  }

  const parts = existingPath.split(path.delimiter);
  return parts.includes(segment)
    ? existingPath
    : [segment, existingPath].join(path.delimiter);
}

const TEST_LOG_BUFFER_LIMIT = 5000;
const testLogBuffer: string[] = [];

function isTestLogCaptureEnabled(): boolean {
  return process.env.DJLS_TEST_CAPTURE_LOGS === '1';
}

// Minimal static-fallback entries for Django's most commonly referenced
// built-in models. The workspace-discovery pass naturally misses these
// because they live inside the Django package, not the project source.
// Receivers like `User.objects.filter(...)` would otherwise land in the
// diagnostic noRecv bucket and produce no feedback at all.
//
// The `fields` set lists every concrete model field plus reverse manager
// names. `relations` lists fields that point at another model — same as
// the workspace-derived staticFallback shape consumed by
// `buildWorkspaceIndex` / `rebuildModelLabelByName`.
const DJANGO_BUILTIN_STATIC_FALLBACK: Readonly<
  Record<string, { fields: string[]; relations: string[] }>
> = {
  'auth.User': {
    fields: [
      'id', 'pk', 'password', 'last_login', 'is_superuser', 'username',
      'first_name', 'last_name', 'email', 'is_staff', 'is_active', 'date_joined',
      'groups', 'user_permissions',
    ],
    relations: ['groups', 'user_permissions'],
  },
  'auth.Group': {
    fields: ['id', 'pk', 'name', 'permissions', 'user_set'],
    relations: ['permissions', 'user_set'],
  },
  'auth.Permission': {
    fields: ['id', 'pk', 'name', 'content_type', 'codename', 'group_set', 'user_set'],
    relations: ['content_type', 'group_set', 'user_set'],
  },
  'contenttypes.ContentType': {
    fields: ['id', 'pk', 'app_label', 'model', 'permission_set'],
    relations: ['permission_set'],
  },
  'sessions.Session': {
    fields: ['session_key', 'pk', 'session_data', 'expire_date'],
    relations: [],
  },
};

/** Test-only: read all captured diagnostic log lines (requires DJLS_TEST_CAPTURE_LOGS=1). */
export function getDiagnosticLogBufferForTesting(): readonly string[] {
  return testLogBuffer;
}

/** Test-only: clear the captured log buffer. */
export function clearDiagnosticLogBufferForTesting(): void {
  testLogBuffer.length = 0;
}

/** Test-only: simulate the captain trace where `daemon.modelLabelByName` is
 *  missing entries that `localWorkspaceIndex.modelLabelByName` still has.
 *  Lets E2E tests verify the cross-map fallback in `findModelLabelByShortName`
 *  / `hasModelByShortName` recovers the lookup. */
export function clearDaemonModelLabelByNameForTesting(daemon: AnalysisDaemon): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (daemon as any).modelLabelByName = new Map<string, string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (daemon as any).modelNames = new Set<string>();
}

/** Test-only: drop a specific full-label entry from EVERY local index so the
 *  daemon behaves as if it never knew about that model. Reproduces the
 *  captain regression where `CompanyQuestionThread` was referenced in user
 *  code, was a real Django model, but happened to be absent from this
 *  particular daemon session's surfaceIndex / localWorkspaceIndex.models /
 *  modelLabelByName trio — `CompanyQuestionThread.objects` stayed in
 *  `unknown_root` every cycle. */
export function dropModelFromAllIndicesForTesting(
  daemon: AnalysisDaemon,
  fullLabel: string,
): void {
  const shortName = fullLabel.includes('.')
    ? fullLabel.slice(fullLabel.lastIndexOf('.') + 1)
    : fullLabel;
  // Daemon's short-name index.
  daemon.modelLabelByName.delete(shortName);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ((daemon as any).modelNames as Set<string>).delete(shortName);
  // Surface index (daemon's source of truth from Python).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete ((daemon as any).surfaceIndex as Record<string, unknown>)[fullLabel];
  // localWorkspaceIndex (client-side derived index used by completion).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lwi = (daemon as any).localWorkspaceIndex as WorkspaceIndex;
  lwi.models.delete(fullLabel);
  lwi.modelLabelByName.delete(shortName);
  lwi.fieldTrieByModel.delete(fullLabel);
  // Invalidate the cached full-label inverted index so the next short-name
  // lookup rebuilds without the dropped label.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (daemon as any)._shortNameFromFullLabelIndex = null;
}

export class AnalysisDaemon implements vscode.Disposable {
  private readonly stateEmitter = new vscode.EventEmitter<HealthSnapshot>();
  private readonly surfaceSnapshotEmitter = new vscode.EventEmitter<void>();
  private readonly modelsReindexedEmitter = new vscode.EventEmitter<void>();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly responseCache = new Map<string, { promise: Promise<unknown>; createdAt: number; source?: IpcRequestSource }>();
  private readonly intentionalExitProcessIds = new Set<number>();
  private readonly requestSourceContext = new AsyncLocalStorage<IpcRequestSource>();
  private readonly documentContext = new AsyncLocalStorage<string | undefined>();
  projectContexts: DjangoProjectContext[] = [];
  private projectViews = new Map<string, WorkspaceIndex>();
  private readonly abortSignalContext = new AsyncLocalStorage<AbortSignal>();
  private readonly deadlineContext = new AsyncLocalStorage<number>();
  private readonly output: vscode.OutputChannel;
  private process?: ChildProcessWithoutNullStreams;
  private nativeStateOwners = new WeakMap<ChildProcessWithoutNullStreams, NativeDaemonStateOwner>();
  private stdoutReader?: readline.Interface;
  private requestSequence = 0;
  private sessionRevision = 0;
  private lifecycleRevision = 0;
  private metadataRetired = false;
  private startPromise?: Promise<HealthSnapshot>;
  private cancelStart?: (error: Error) => void;
  private restartPromise?: Promise<HealthSnapshot>;
  private restartRevision = 0;
  private restartQueued = false;
  private queuedRestartScope?: vscode.ConfigurationScope;
  private stopRequested = false;
  private allModelNames: Set<string> = new Set();
  private allModelLabels: Map<string, string> = new Map();
  get modelNames(): Set<string> {
    return this.projectContexts.length ? new Set(this.getLookupIndex().modelLabelByName.keys()) : this.allModelNames;
  }
  set modelNames(value: Set<string>) { this.allModelNames = value; }
  get modelLabelByName(): Map<string, string> {
    return this.projectContexts.length ? this.getLookupIndex().modelLabelByName : this.allModelLabels;
  }
  set modelLabelByName(value: Map<string, string>) { this.allModelLabels = value; }
  // Lazy inverted index over `localWorkspaceIndex.models.keys()` (full labels).
  // Maps short name -> full label, populated on first miss in
  // `findModelLabelByShortName`, invalidated when the workspace index is
  // rebuilt. Captain regression: `zuzu.CompanyQuestionThread` lived in
  // `localWorkspaceIndex.models` but not in either modelLabelByName, so
  // receivers like `CompanyQuestionThread.objects` permanently landed in
  // noRecv. The full-label keys are the ground truth.
  private _shortNameFromFullLabelIndex: Map<string, string> | null = null;
  // Per-IPC perf counters keyed by IPC method name. Captain receiver-chain
  // analysis needs to know WHICH IPC dominates the wall time — bare
  // `recv-ipc-ms` aggregates everything inside `resolveLookupReceiverInfoForReceiver`
  // and hides the contributing IPC types. Diagnostic cycles call
  // `snapshotIpcStats()` at start and end to compute a per-cycle delta.
  private _ipcStats: Map<string, { count: number; totalMs: number }> = new Map();
  surfaceIndex: SurfaceIndex = {};
  surfaceFingerprints: Record<string, string> = {};
  customLookups: Record<string, string[]> = {};
  lookupCatalog?: import('../../server/lookupCatalog').LookupCatalogPayload;
  customLookupsFingerprint?: string;
  staticFallback: StaticFallback | null = null;
  staticFallbackFingerprint: string | null = null;
  sourceProvenance: SurfaceSourceProvenance | null = null;
  private surfaceCacheContext: SurfaceCacheContext | null = null;
  private editableSourceRoots: string[] = [];
  private sourceObservationContext?: SourceObservationContext;
  private readonly sourceConfigurationRequests = new SourceConfigurationRequests();
  private initializationPending = false;
  private pendingSourceObservationBoundary?: string;
  private surfaceSnapshotDecoder = new SurfaceSnapshotDecoder();
  private surfaceResyncPromise?: Promise<void>;
  private surfaceResyncNeeded = false;
  private surfaceResyncRetry?: NodeJS.Timeout;
  private localWorkspaceIndex: WorkspaceIndex = createEmptyWorkspaceIndex();
  private localModelFingerprints = new Map<string, string>();
  private lastLaunchContext?: LaunchContext;
  private interpreterCheck?: Promise<void>;
  private readonly pythonCompatibility = new PythonRuntimeCompatibility();
  private currentState: HealthSnapshot = {
    phase: 'stopped',
    detail: 'Daemon has not been started yet.',
    capabilities: [],
  };

  constructor(
    private readonly context: vscode.ExtensionContext,
    output?: vscode.OutputChannel
  ) {
    this.output =
      output ?? vscode.window.createOutputChannel('Django ORM Intellisense');
  }

  get onDidChangeState(): vscode.Event<HealthSnapshot> {
    return this.stateEmitter.event;
  }

  getSurfaceCacheContext(): SurfaceCacheContext | null {
    return this.surfaceCacheContext;
  }

  /** Fires when a complete authoritative surface snapshot replaces metadata. */
  get onDidReplaceSurfaceSnapshot(): vscode.Event<void> {
    return this.surfaceSnapshotEmitter.event;
  }

  /**
   * Fires after a reindex changed model definitions. File-watcher reindexes
   * (branch switch, external edit) never raise a save event, so this is the
   * signal to drop resolution caches computed against the old models.
   */
  get onDidReindexModels(): vscode.Event<void> {
    return this.modelsReindexedEmitter.event;
  }

  getState(): HealthSnapshot {
    const project = projectForFile(this.projectContexts, this.documentContext.getStore());
    if (project?.runtime) return {...this.currentState, runtime: project.runtime};
    return this.currentState;
  }

  getEditableSourceRoots(): readonly string[] {
    return this.editableSourceRoots;
  }

  getSourceObservationContext(): SourceObservationContext | undefined {
    return this.sourceObservationContext;
  }

  isSourceConfigurationRefreshing(): boolean {
    return this.sourceConfigurationRequests.refreshing;
  }

  /** Changes whenever a daemon process starts or is invalidated. */
  getSessionRevision(): number {
    return this.sessionRevision;
  }

  /** A retired session publishes an empty in-memory LS state until new metadata arrives. */
  isMetadataRetired(): boolean {
    return this.metadataRetired;
  }

  isReady(): boolean {
    return Boolean(this.process) && !this.sourceConfigurationRequests.refreshing && (
      this.currentState.phase === 'ready' ||
      this.currentState.phase === 'degraded'
    );
  }

  withRequestSource<T>(source: IpcRequestSource, callback: () => T, sourceFile?: string): T {
    return this.requestSourceContext.run(source, () => this.documentContext.run(
      sourceFile ? normalizeSourcePath(sourceFile) : this.documentContext.getStore(), callback));
  }

  withDocumentContext<T>(sourceFile: string, callback: () => T): T {
    return this.documentContext.run(normalizeSourcePath(sourceFile), callback);
  }

  /** Publication always includes the whole repository, regardless of caller. */
  getAllModelNames(): readonly string[] { return [...this.allModelNames]; }

  getRequestProjectKey(): string {
    return projectForFile(this.projectContexts, this.documentContext.getStore())?.namespace ?? '';
  }

  private invalidateProjectViews(): void {
    this.projectViews.clear();
    attachProjectModelSources(this.localWorkspaceIndex, this.projectContexts);
  }

  withAbortSignal<T>(signal: AbortSignal, callback: () => T): T {
    return this.abortSignalContext.run(signal, callback);
  }

  /** Run callback with a performance.now() deadline (ms since epoch). */
  withDeadline<T>(deadlineMs: number, callback: () => T): T {
    return this.deadlineContext.run(deadlineMs, callback);
  }

  /**
   * Check if the current async context should abort.
   * Works even when the event loop is blocked (performance.now() is synchronous).
   */
  isAborted(): boolean {
    if (this.abortSignalContext.getStore()?.aborted === true) {
      return true;
    }
    const deadline = this.deadlineContext.getStore();
    if (deadline !== undefined && performance.now() >= deadline) {
      return true;
    }
    return false;
  }

  private rebuildLocalWorkspaceIndex(): void {
    this.localWorkspaceIndex = buildWorkspaceIndex(
      this.surfaceIndex,
      Array.from(this.allModelNames),
      this.customLookups,
      this.effectiveStaticFallback(),
      this.lookupCatalog,
    );
    this._shortNameFromFullLabelIndex = null;
    this.invalidateProjectViews();
    this.localModelFingerprints.clear();
    for (const [label, receivers] of Object.entries(this.surfaceIndex)) {
      this.localModelFingerprints.set(
        label,
        this.surfaceFingerprints[label] ?? JSON.stringify(receivers),
      );
    }
  }

  private updateLocalWorkspaceIndex(
    nextSurfaceIndex: SurfaceIndex,
    nextStaticFallback: StaticFallback | null,
    nextSurfaceFingerprints?: Record<string, string>,
    nextStaticFallbackFingerprint?: string | null,
  ): void {
    if (
      this.localWorkspaceIndex.models.size === 0 ||
      this.staticFallbackFingerprint !== (nextStaticFallbackFingerprint ?? null)
    ) {
      this.surfaceIndex = nextSurfaceIndex;
      this.surfaceFingerprints = { ...(nextSurfaceFingerprints ?? {}) };
      this.staticFallback = nextStaticFallback;
      this.staticFallbackFingerprint = nextStaticFallbackFingerprint ?? null;
      this.rebuildModelLabelByName();
      this.rebuildModelNames();
      this.rebuildLocalWorkspaceIndex();
      return;
    }

    const diff = diffSurfaceIndex(
      this.surfaceIndex,
      nextSurfaceIndex,
      this.localModelFingerprints,
      nextSurfaceFingerprints,
    );

    // Same fallback fingerprint on this path, so the current fallback is the
    // next one; it lets field-less surface entries keep their static fields.
    updateWorkspaceIndexIncremental(
      this.localWorkspaceIndex,
      nextSurfaceIndex,
      diff,
      this.customLookups,
      this.customLookups,
      this.effectiveStaticFallback(),
      this.lookupCatalog,
    );
    this._shortNameFromFullLabelIndex = null;
    this.surfaceIndex = nextSurfaceIndex;
    this.surfaceFingerprints = { ...(nextSurfaceFingerprints ?? this.surfaceFingerprints) };
    this.staticFallback = nextStaticFallback;
    this.staticFallbackFingerprint = nextStaticFallbackFingerprint ?? null;
    this.rebuildModelLabelByName();
    this.rebuildModelNames();
  }

  /**
   * Returns staticFallback with Django built-in models merged in. Workspace
   * entries take precedence over built-ins on key collision (e.g. a custom
   * `auth.User` swap). Used everywhere staticFallback feeds downstream
   * lookups so built-ins receive the same treatment as workspace models.
   */
  private effectiveStaticFallback(): StaticFallback {
    const merged: StaticFallback = {};
    for (const [label, info] of Object.entries(DJANGO_BUILTIN_STATIC_FALLBACK)) {
      merged[label] = { ...info, builtin: true };
    }
    for (const [label, info] of Object.entries(this.staticFallback ?? {})) {
      // The daemon's runtime entry for a contrib model (`auth.User`) is more
      // accurate than the built-in one but must keep its built-in name
      // standing; a bare runtime-only entry never owns a short name.
      merged[label] = label in DJANGO_BUILTIN_STATIC_FALLBACK
        ? { ...info, builtin: true }
        : info;
    }
    return merged;
  }

  private rebuildModelLabelByName(): void {
    // Workspace-defined models own short names; Django built-ins fill the
    // gaps so receivers like `User.objects.filter(...)` resolve even when the
    // workspace does not directly subclass them — otherwise every such
    // receiver lands in the diagnostic noRecv bucket with no lookup-path
    // feedback. Third-party runtime-only models are reachable by label only.
    this.modelLabelByName = buildModelLabelByName(
      Object.keys(this.surfaceIndex),
      this.effectiveStaticFallback(),
      'first',
    );
  }

  private rebuildModelNames(): void {
    this.modelNames = new Set(this.allModelLabels.keys());
  }

  /**
   * Resolve a short model name (e.g. `CompanyQuestionThread`) to a full label
   * (e.g. `zuzu.CompanyQuestionThread`). Production captain trace showed
   * `daemon.modelLabelByName` and `localWorkspaceIndex.modelLabelByName` can
   * disagree because of different short-name collision semantics:
   *   - `daemon.modelLabelByName`: first-come wins (rebuildModelLabelByName)
   *   - `localWorkspaceIndex.modelLabelByName`: last-come wins (buildWorkspaceIndex)
   * When a workspace contains both `db.X` and `zuzu.X`, the two maps return
   * different labels for the bare name `X`. Worse, in the captain trace
   * `daemon.modelLabelByName.has('CompanyQuestionThread')` returned false
   * altogether, leaving the lookup in unknown_root every cycle.
   *
   * This helper consults both maps so a name registered in either resolves.
   * Sync, no IPC. Callers should prefer this over direct
   * `daemon.modelLabelByName.get(...)` for diagnostic / receiver-resolution
   * paths.
   */
  findModelLabelByShortName(shortName: string): string | undefined {
    if (this.projectContexts.length) return this.getLookupIndex().modelLabelByName.get(shortName);
    const direct = this.modelLabelByName.get(shortName);
    if (direct) return direct;
    const lwi = this.localWorkspaceIndex.modelLabelByName.get(shortName);
    if (lwi) return lwi;
    // Final fallback: iterate the full-label keys of localWorkspaceIndex.models
    // looking for any label whose last segment matches `shortName`. Cached so
    // subsequent calls are O(1). The captain workload exercises ~1.3k labels
    // so the first miss costs <1ms and warms the cache.
    if (this._shortNameFromFullLabelIndex === null) {
      const built = new Map<string, string>();
      for (const [fullLabel, model] of this.localWorkspaceIndex.models) {
        if (model.runtimeOnly) continue;
        const tail = fullLabel.includes('.')
          ? fullLabel.slice(fullLabel.lastIndexOf('.') + 1)
          : fullLabel;
        if (!built.has(tail)) built.set(tail, fullLabel);
      }
      this._shortNameFromFullLabelIndex = built;
    }
    return this._shortNameFromFullLabelIndex.get(shortName);
  }

  /** Sync `has` companion to `findModelLabelByShortName`. */
  hasModelByShortName(shortName: string): boolean {
    return this.findModelLabelByShortName(shortName) !== undefined;
  }

  /**
   * Record an IPC call's wall time under a method-name bucket. Called by the
   * IPC dispatch wrappers so per-cycle perf summaries can break down where
   * the receiver-chain time is going.
   */
  private _trackIpcCall(method: string, elapsedMs: number): void {
    const existing = this._ipcStats.get(method);
    if (existing) {
      existing.count += 1;
      existing.totalMs += elapsedMs;
    } else {
      this._ipcStats.set(method, { count: 1, totalMs: elapsedMs });
    }
  }

  /** Snapshot the current IPC stats. Returns a deep copy so subtraction
   *  against a later snapshot produces a per-cycle delta. */
  snapshotIpcStats(): Map<string, { count: number; totalMs: number }> {
    const snap = new Map<string, { count: number; totalMs: number }>();
    for (const [method, entry] of this._ipcStats) {
      snap.set(method, { count: entry.count, totalMs: entry.totalMs });
    }
    return snap;
  }

  /** Compute delta (current - baseline) for each IPC method. Returns
   *  entries with non-zero deltas sorted by totalMs descending. */
  diffIpcStats(
    baseline: Map<string, { count: number; totalMs: number }>,
  ): Array<{ method: string; count: number; totalMs: number }> {
    const result: Array<{ method: string; count: number; totalMs: number }> = [];
    for (const [method, entry] of this._ipcStats) {
      const before = baseline.get(method);
      const count = entry.count - (before?.count ?? 0);
      const totalMs = entry.totalMs - (before?.totalMs ?? 0);
      if (count > 0) {
        result.push({ method, count, totalMs });
      }
    }
    result.sort((a, b) => b.totalMs - a.totalMs);
    return result;
  }

  /** Test-only: read access to the otherwise private localWorkspaceIndex
   *  for assertions about the cross-map fallback. */
  get localWorkspaceIndexForTesting(): WorkspaceIndex {
    return this.localWorkspaceIndex;
  }

  private applySurfaceIndexDelta(
    surfaceIndexDelta: SurfaceIndex,
    addedLabels: string[],
    changedLabels: string[],
    removedLabels: string[],
    surfaceFingerprints?: Record<string, string>,
  ): void {
    for (const label of removedLabels) {
      delete this.surfaceIndex[label];
      delete this.surfaceFingerprints[label];
      this.localModelFingerprints.delete(label);
    }
    for (const label of [...addedLabels, ...changedLabels]) {
      const nextEntry = surfaceIndexDelta[label];
      if (!nextEntry) {
        continue;
      }
      this.surfaceIndex[label] = nextEntry;
      const fp = surfaceFingerprints?.[label] ?? JSON.stringify(nextEntry);
      this.surfaceFingerprints[label] = fp;
      this.localModelFingerprints.set(label, fp);
    }
  }

  private refreshNativeFastPathFromSurface(reason: string): void {
    const workspaceRoot = this.lastLaunchContext?.workspaceRoot;
    if (!workspaceRoot) {
      return;
    }

    void hydrateNativeFastPathFromSurface({
      workspaceRoot,
      surfaceIndex: this.surfaceIndex,
      workspaceIndex: this.localWorkspaceIndex,
      reason,
      log: (level, message) => {
        this.log(level === 'info' ? 'info' : 'info', message);
      },
    }).then((ok) => {
      if (!ok) return;
      // Populate `modules` in the resident Rust state so that
      // `resolveExportOrigin` / `resolveModule` are answered natively.
      // Runs on the JS task queue; callers observe stale
      // (Python-fallback) answers until it completes, then microsecond
      // ones. 1.1k-module workspaces come in under ~300ms.
      void ensureNativeAstModules(workspaceRoot, (level, message) => {
        this.log(level === 'info' ? 'info' : 'info', message);
      });
    });
  }

  async start(scope?: vscode.ConfigurationScope): Promise<HealthSnapshot> {
    if (this.restartPromise) return this.restartPromise;
    return this.startSession(scope);
  }

  private async startSession(scope?: vscode.ConfigurationScope): Promise<HealthSnapshot> {
    if (this.startPromise) {
      return this.startPromise;
    }

    if (this.process) {
      return this.refreshHealth();
    }

    let cancel!: (error: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => { cancel = reject; });
    // The underlying work may be uncooperative. Its lifecycle guards prevent
    // late adoption; public waiters must still settle when the session stops.
    const startPromise = Promise.race([this.startProcess(scope), cancelled]);
    this.startPromise = startPromise;
    this.cancelStart = cancel;

    try {
      return await startPromise;
    } finally {
      if (this.startPromise === startPromise) {
        this.startPromise = undefined;
        this.cancelStart = undefined;
      }
    }
  }

  async refreshHealth(): Promise<HealthSnapshot> {
    if (this.restartPromise) return this.restartPromise;
    if (this.startPromise) {
      return this.startPromise;
    }

    if (!this.process) {
      return this.currentState;
    }

    const child = this.process;
    const session = this.sessionRevision;
    const snapshot = this.decorateSnapshot(
      await this.request<HealthSnapshot>(
        'health',
        {},
        REQUEST_TIMEOUT_MS,
        false,
        'health'
      )
    );
    if (session !== this.sessionRevision || this.process !== child) {
      throw new Error('Health result belongs to an inactive daemon session.');
    }
    // A status query does not change resolver metadata. Keep warmed provider
    // caches when every health value is unchanged; explicit healthChanged
    // notifications still invalidate them when the runtime registry is ready.
    if (JSON.stringify(snapshot) !== JSON.stringify(this.currentState)) {
      this.updateState(snapshot);
    }
    return snapshot;
  }

  async ensureStarted(scope?: vscode.ConfigurationScope): Promise<void> {
    if (this.sourceConfigurationRequests.refreshing) {
      await this.sourceConfigurationRequests.waitForCurrent(REQUEST_TIMEOUT_MS, this.abortSignalContext.getStore());
      return;
    }
    // Background diagnostics share the active process; they must never undo
    // a foreground project switch with a stale document's startup scope.
    if (this.currentRequestSource() === 'diagnostic') {
      const pending = this.restartPromise ?? this.startPromise;
      if (pending) await pending;
      if (!this.isReady()) throw new Error('Background analysis requires a ready daemon session.');
      return;
    }
    if (this.restartPromise) {
      await this.restartPromise;
      return;
    }
    if (this.startPromise) {
      await this.startPromise;
      if (
        scope &&
        this.process &&
        this.lastLaunchContext &&
        (await this.requiresScopedRestart(scope))
      ) {
        await this.stop();
        await this.start(scope);
      }
      return;
    }

    if (!this.process) {
      await this.start(scope);
      return;
    }

    await this.restartIfInterpreterChanged(scope);
  }

  async restart(scope?: vscode.ConfigurationScope): Promise<HealthSnapshot> {
    if (this.restartPromise) {
      this.restartQueued = true;
      if (scope !== undefined) {
        this.queuedRestartScope = scope;
      }
      return this.restartPromise;
    }

    const revision = ++this.restartRevision;
    const restartPromise = (async () => {
      let nextScope = scope;
      let lastSnapshot: HealthSnapshot | undefined;
      let lastError: unknown;

      while (true) {
        if (revision !== this.restartRevision) throw new Error('Daemon restart belongs to an inactive daemon session.');
        this.restartQueued = false;
        const restartScope = nextScope;
        nextScope = undefined;

        await this.stopProcess();
        if (revision !== this.restartRevision) throw new Error('Daemon restart belongs to an inactive daemon session.');

        try {
          lastSnapshot = await this.startSession(restartScope);
          lastError = undefined;
        } catch (error) {
          lastSnapshot = undefined;
          lastError = error;
        }

        if (revision !== this.restartRevision) throw new Error('Daemon restart belongs to an inactive daemon session.');
        if (!this.restartQueued) {
          if (lastSnapshot) {
            return lastSnapshot;
          }
          throw lastError;
        }

        nextScope = this.queuedRestartScope;
        this.queuedRestartScope = undefined;
      }
    })();
    this.restartPromise = restartPromise;

    try {
      return await restartPromise;
    } finally {
      if (this.restartPromise === restartPromise) {
        this.restartPromise = undefined;
      }
    }
  }

  async refreshSourceConfiguration(ownsSource: () => boolean = () => true): Promise<HealthSnapshot> {
    const child = this.process, launch = this.lastLaunchContext, session = this.sessionRevision;
    const current = (): boolean => Boolean(child && launch && this.process === child
      && this.sessionRevision === session && !this.stopRequested && ownsSource());
    if (!current() || !launch) throw new Error('Source configuration belongs to an inactive daemon session.');
    const promise = this.sourceConfigurationRequests.refresh(
      INITIALIZE_REQUEST_TIMEOUT_MS,
      () => {
        this.initializationPending = true;
        this.retireMetadata();
        this.updateState({...this.currentState, phase: 'starting', detail: 'Refreshing source configuration.'});
      },
      async remaining => {
        if (!current()) throw new Error('Source configuration belongs to an inactive daemon session.');
        this.pendingSourceObservationBoundary = captureNativeSourceBoundary();
        const result = await this.request<InitializeResult>('initialize', {
          workspaceRoot: launch.workspaceRoot, settingsModule: launch.settingsModule,
          deferRuntime: true, surfaceSnapshotTransport: 1, sourceObservationTransport: 1, initializeSurfaceTransport: 1,
        }, remaining, false, 'initialSync');
        if (!current()) throw new Error('Source configuration belongs to an inactive daemon session.');
        return result;
      },
      result => {
        if (!current()) throw new Error('Source configuration belongs to an inactive daemon session.');
        this.initializationPending = false;
        this.surfaceSnapshotDecoder.reset();
        this.adoptInitializeResult(result, 'source-configuration');
        return result;
      },
    );
    try {
      await promise;
      if (!current()) throw new Error('Source configuration belongs to an inactive daemon session.');
      const snapshot = this.currentState;
      this.updateState(snapshot);
      this.surfaceSnapshotEmitter.fire();
      this.requestSurfaceSnapshotResync();
      return snapshot;
    } catch (error) {
      if (current()) {
        this.initializationPending = false;
        this.updateStateFromError(error);
      }
      throw error;
    }
  }

  async restartIfInterpreterChanged(scope?: vscode.ConfigurationScope): Promise<void> {
    const pending = this.restartPromise ?? this.startPromise;
    if (pending) {
      try { await pending; } catch { /* A newly available interpreter can recover a failed start. */ }
    }
    if (!this.lastLaunchContext || this.stopRequested || this.currentState.phase === 'stopped') {
      return;
    }

    if (this.interpreterCheck) {
      await this.interpreterCheck;
      return;
    }

    this.interpreterCheck = this.checkForInterpreterChange(scope);

    try {
      await this.interpreterCheck;
    } finally {
      this.interpreterCheck = undefined;
    }
  }

  async listRelationTargets(prefix: string): Promise<RelationTargetsResult> {
    const native = this.projectContexts.length === 0 && isNativeFastPathReady()
      ? nativeListRelationTargets(prefix)
      : undefined;
    if (native && (native.items.length > 0 || prefix.trim().length === 0)) {
      return native;
    }
    return this.cachedRequest<RelationTargetsResult>('relationTargets', { prefix });
  }

  async resolveRelationTarget(
    value: string,
    background: boolean = false
  ): Promise<RelationTargetResolution> {
    const _ipcStart = performance.now();
    const _track = () => {
      this._trackIpcCall('resolveRelationTarget', performance.now() - _ipcStart);
    };
    // Test-only escape hatch: simulate captain's state where a Django model
    // was dropped from EVERY index (client + daemon) — the BG resolver has
    // no way to recover the label. Mirrors the production captain trace
    // where `CompanyQuestionThread.objects` stays in `unknown_root` every
    // cycle because neither client maps nor daemon knows it any more.
    if (process.env.DJLS_TEST_FORCE_RESOLVE_RELATION_UNRESOLVED === '1') {
      _track();
      return { resolved: false } as RelationTargetResolution;
    }
    const source = this.currentRequestSource();
    const allowLocationlessNative = background || source === 'diagnostic';
    // Native fast-path: static graph lookup completes in microseconds.
    // Python daemon was measured at 950-3084ms for this call on real
    // projects. Foreground definition/hover still needs source locations,
    // but diagnostics only need the resolution outcome.
    const native = this.projectContexts.length === 0 && isNativeFastPathReady()
      ? nativeResolveRelationTarget(value)
      : undefined;
    if (
      native?.resolved &&
      native.target &&
      (native.target.filePath || allowLocationlessNative)
    ) {
      _track();
      return native;
    }
    if (native && allowLocationlessNative && !native.resolved) {
      _track();
      return native;
    }
    try {
      return await this.cachedRequest<RelationTargetResolution>('resolveRelationTarget', {
        value,
      }, background);
    } finally {
      _track();
    }
  }

  async resolveExportOrigin(
    moduleName: string,
    symbol: string
  ): Promise<ExportOriginResolution> {
    const _ipcStart = performance.now();
    const _track = () => {
      this._trackIpcCall('resolveExportOrigin', performance.now() - _ipcStart);
    };
    const source = this.currentRequestSource();
    const allowLocationlessNative = source === 'diagnostic';
    // Native fast-path: recursive re-export walk on the resident static
    // index. Python daemon cold-start (ProcessPoolExecutor spawn) can
    // push this to 4-6s on the first diagnostic burst; the Rust path
    // runs in microseconds. `modules` is populated on a background
    // `ensureNativeAstModules` after surface hydrate, so we only hit
    // the fast path once that completes — before then, `native` returns
    // `undefined` and we fall through to Python.
    const native = this.projectContexts.length ? undefined : nativeResolveExportOrigin(moduleName, symbol);
    if (
      native?.resolved &&
      (native.originFilePath || allowLocationlessNative)
    ) {
      _track();
      return native;
    }
    if (native && allowLocationlessNative && !native.resolved) {
      _track();
      return native;
    }
    try {
      return await this.cachedRequest<ExportOriginResolution>('resolveExportOrigin', {
        module: moduleName,
        symbol,
      });
    } finally {
      _track();
    }
  }

  async resolveModule(moduleName: string): Promise<ModuleResolution> {
    const _ipcStart = performance.now();
    const _track = () => {
      this._trackIpcCall('resolveModule', performance.now() - _ipcStart);
    };
    const source = this.currentRequestSource();
    const allowLocationlessNative = source === 'diagnostic';
    const native = this.projectContexts.length ? undefined : nativeResolveModule(moduleName);
    if (native?.resolved && (native.filePath || allowLocationlessNative)) {
      _track();
      return native;
    }
    if (native && allowLocationlessNative && !native.resolved) {
      _track();
      return native;
    }
    try {
      return await this.cachedRequest<ModuleResolution>('resolveModule', {
        module: moduleName,
      });
    } finally {
      _track();
    }
  }

  async deletedSourceFiles(filePath: string): Promise<readonly string[]> {
    const result = await this.request<DeletedSourceFilesResult>(
      'deletedSourceFiles', { filePath }, INITIALIZE_REQUEST_TIMEOUT_MS, false, 'reindex'
    );
    if (result.error) throw new Error(result.error);
    return result.filePaths ?? [];
  }

  async reindexFile(filePath: string, isCurrentSourceOwner?: () => boolean): Promise<ReindexFileResult> {
    return this.reindexSourcePath('reindexFile', filePath, isCurrentSourceOwner);
  }

  async reindexSourceRoot(filePath: string, isCurrentSourceOwner?: () => boolean): Promise<ReindexFileResult> {
    return this.reindexSourcePath('reindexSourceRoot', filePath, isCurrentSourceOwner);
  }

  async reindexSourceDirectory(filePath: string, isCurrentSourceOwner?: () => boolean): Promise<ReindexFileResult> {
    return this.reindexSourcePath('reindexSourceDirectory', filePath, isCurrentSourceOwner);
  }

  private async reindexSourcePath(
    method: 'reindexFile' | 'reindexSourceRoot' | 'reindexSourceDirectory',
    filePath: string,
    isCurrentSourceOwner?: () => boolean,
  ): Promise<ReindexFileResult> {
    const sessionRevision = this.sessionRevision;
    const result = await this.request<ReindexFileResult>(
      method,
      { filePath },
      INITIALIZE_REQUEST_TIMEOUT_MS,
      false,
      'reindex'
    );
    if (sessionRevision !== this.sessionRevision) {
      throw new Error('Source reindex result belongs to an inactive daemon session.');
    }
    if (isCurrentSourceOwner && !isCurrentSourceOwner()) {
      // Python may already have committed this edit. Fetch current state,
      // since a same-source retry can legitimately contain no delta.
      if (this.isReady() && !this.isMetadataRetired()) {
        this.surfaceResyncNeeded = true;
        this.requestSurfaceSnapshotResync();
      }
      const error = new Error('Source reindex result belongs to an inactive source watcher owner.');
      if (result && typeof result === 'object' && !Array.isArray(result) && !result.error) {
        // The reply can already be committed in Python. Keep only an owned
        // path hint so a returned registration can read current source.
        Object.assign(error, { sourceReindexOwnerRetired: { filePath, sessionRevision } });
      }
      throw error;
    }
    if (result.error) {
      throw new Error(result.error);
    }
    if (result.projectContexts) this.projectContexts = result.projectContexts;
    this.invalidateProjectViews();

    if (result.unchanged) {
      // Only a verified source duplicate leaves resolver metadata untouched.
      // Surface-only no-ops can still change exports and source locations.
      if (result.sourceUnchanged === true) return result;
      this.sourceProvenance = null;
      this.clearResponseCache();
      resetNativeAstModulesFlag();
      const workspaceRoot = this.lastLaunchContext?.workspaceRoot;
      if (workspaceRoot) void ensureNativeAstModules(workspaceRoot);
      this.modelsReindexedEmitter.fire();
      return result;
    }

    this.sourceProvenance = null;
    const addedLabels = result.addedLabels ?? [];
    const changedLabels = result.changedLabels ?? [];
    const removedLabels = result.removedLabels ?? [];
    if (result.lookupCatalogDelta) {
      this.lookupCatalog = applyLookupCatalogDelta(this.localWorkspaceIndex, result.lookupCatalogDelta);
    }
    const hasFallbackDelta = result.staticFallbackDelta !== undefined;
    const nextStaticFallback = hasFallbackDelta
      ? applyStaticFallbackDelta(this.staticFallback, result.staticFallbackDelta!, result.removedStaticFallbackLabels)
      : result.staticFallback !== undefined ? result.staticFallback : this.staticFallback;
    const nextStaticFallbackFingerprint = result.staticFallbackFingerprint ?? null;
    if (result.surfaceIndexDelta) {
      this.applySurfaceIndexDelta(
        result.surfaceIndexDelta,
        addedLabels,
        changedLabels,
        removedLabels,
        result.surfaceFingerprints,
      );
      if (this.localWorkspaceIndex.models.size === 0) {
        this.staticFallback = nextStaticFallback;
        this.staticFallbackFingerprint = nextStaticFallbackFingerprint;
        this.rebuildModelLabelByName();
        this.rebuildModelNames();
        this.rebuildLocalWorkspaceIndex();
      } else if (!hasFallbackDelta && this.staticFallbackFingerprint !== nextStaticFallbackFingerprint) {
        this.staticFallback = nextStaticFallback;
        this.staticFallbackFingerprint = nextStaticFallbackFingerprint;
        this.rebuildModelLabelByName();
        this.rebuildModelNames();
        this.rebuildLocalWorkspaceIndex();
      } else {
        this.staticFallback = nextStaticFallback;
        const fallback = this.effectiveStaticFallback();
        const diff = includeStaticFallbackChanges(
          this.localWorkspaceIndex, this.surfaceIndex, fallback,
          { added: addedLabels, changed: changedLabels, removed: removedLabels },
          result.staticFallbackDelta, result.removedStaticFallbackLabels,
        );
        updateWorkspaceIndexIncremental(
          this.localWorkspaceIndex,
          this.surfaceIndex,
          diff,
          this.customLookups,
          this.customLookups,
          fallback,
          this.lookupCatalog,
        );
        this._shortNameFromFullLabelIndex = null;
      }
    } else {
      const nextSurfaceIndex = result.surfaceIndex ?? {};
      this.updateLocalWorkspaceIndex(
        nextSurfaceIndex,
        nextStaticFallback,
        result.surfaceFingerprints,
        nextStaticFallbackFingerprint,
      );
    }

    this.staticFallback = nextStaticFallback;
    this.staticFallbackFingerprint = nextStaticFallbackFingerprint;
    this.rebuildModelLabelByName();
    this.rebuildModelNames();
    this.invalidateProjectViews();
    this.refreshNativeFastPathFromSurface('reindex');
    // Cached IPC answers (lookup resolutions, receiver chains) were computed
    // against the old models and would otherwise outlive the edit by the TTL.
    this.clearResponseCache();
    this.modelsReindexedEmitter.fire();
    return result;
  }

  async listLookupPathCompletions(
    baseModelLabel: string,
    prefix: string,
    method: string
  ): Promise<LookupPathCompletionsResult> {
    return this.cachedRequest<LookupPathCompletionsResult>('lookupPathCompletions', {
      baseModelLabel,
      prefix,
      method,
    });
  }

  /**
   * Native Rust bulk lookup-path completion. Returns `undefined` when the
   * resident state is not ready (caller should fall back to Python IPC).
   * Covers static fields, relations, descendants, and built-in lookup
   * operators — custom runtime lookups still require the Python path.
   */
  listLookupPathCompletionsNative(
    baseModelLabel: string,
    prefix: string,
    method: string
  ): LookupPathCompletionsResult | undefined {
    if (this.lookupCatalog && prefix.includes('__')) return undefined;
    if (!isNativeFastPathReady()) return undefined;
    return nativeListLookupPathCompletions(baseModelLabel, prefix, method);
  }

  /**
   * List lookup-path completions from the local workspace index without IPC.
   *
   * This reuses the language-server lookup FSM and trie-backed field metadata
   * so the extension host does not have to guess from raw surfaceIndex tuples.
   * Alias-sensitive attribute-path methods still fall back to the daemon until
   * source provenance is preserved in the local index.
   */
  listLookupPathCompletionsLocal(
    baseModelLabel: string,
    prefix: string,
    method: string
  ): LookupPathCompletionsResult | undefined {
    if (LOCAL_LOOKUP_ALIAS_SENSITIVE_METHODS.has(method)) {
      return undefined;
    }

    const index = this.getLookupIndex();
    const model = index.models.get(baseModelLabel);
    if (!model) {
      const objectName = baseModelLabel.includes('.')
        ? baseModelLabel.split('.').pop()!
        : baseModelLabel;
      const candidateKeys = Object.keys(this.surfaceIndex).filter((key) => {
        if (key === baseModelLabel) return true;
        const keyObject = key.includes('.') ? key.split('.').pop() : key;
        return keyObject === objectName;
      });
      const nameMapped = this.modelLabelByName.get(objectName);
      this.logDiagnostic(
        `[completion:lookup:local:miss] model=${baseModelLabel} indexSize=${index.models.size} surfaceKeys=${Object.keys(this.surfaceIndex).length} hasSurfaceEntry=${Boolean(this.surfaceIndex[baseModelLabel])} nameMapped=${nameMapped ?? '<none>'} candidates=${JSON.stringify(candidateKeys.slice(0, 10))}`
      );
      return undefined;
    }
    this.logDiagnostic(
      `[completion:lookup:local:hit] model=${baseModelLabel} fields=${model.fields.size} relations=${model.relations.size} reverseRelations=${model.reverseRelations.size}`
    );

    const { completedSegments, currentPartial } = this.splitLocalLookupPrefix(
      prefix,
      method,
    );
    const parsed: ParsedLookup = completedSegments.length > 0
      ? parseLookupChain(`${completedSegments.join('__')}__`, baseModelLabel, index, method)
      : {
          segments: [],
          resolvedPath: [],
          state: 'partial',
          startModel: baseModelLabel,
        };
    if (parsed.state === 'error' || parsed.runtimeRequired) {
      return undefined;
    }
    if (
      completedSegments.length > 0 &&
      parsed.resolvedPath.length < completedSegments.length
    ) {
      return undefined;
    }

    const traversal = this.analyzeLocalLookupTraversal(
      baseModelLabel,
      parsed,
      method,
    );
    if (!traversal) {
      return undefined;
    }

    const itemsByName = new Map<string, LookupPathItem>();
    const includePrefixedLookupItems =
      supportsLookupTransforms(method) &&
      (currentPartial.length > 0 || completedSegments.length === 0);

    if (
      traversal.completionMode === 'field' ||
      traversal.completionMode === 'field_and_lookup'
    ) {
      const directItems = this.buildLocalFieldCompletionItems(
        traversal.currentModelLabel,
        parsed,
        currentPartial,
        method,
      );
      for (const item of directItems) {
        itemsByName.set(item.name, item);
      }

      if (includePrefixedLookupItems) {
        for (const item of this.buildPrefixedLocalLookupItems(
          traversal.currentModelLabel,
          directItems,
          currentPartial,
          method,
        )) {
          itemsByName.set(item.name, item);
        }
      }

      for (const item of this.buildLocalDescendantCompletionItems(
        traversal.currentModelLabel,
        currentPartial,
        method,
      )) {
        itemsByName.set(item.name, item);
      }

      if (
        traversal.completionMode === 'field_and_lookup' &&
        traversal.lookupField &&
        traversal.lookupFieldOwnerLabel
      ) {
        for (const item of this.buildLocalLookupItems(
          traversal.lookupFieldOwnerLabel,
          traversal.lookupField,
          currentPartial,
          traversal.lookupField.name,
          LOCAL_LOOKUP_OPERATOR_METHODS.has(method),
        )) {
          itemsByName.set(item.name, item);
        }
      }
    } else if (traversal.lookupField && traversal.lookupFieldOwnerLabel) {
      for (const item of this.buildLocalLookupItems(
        traversal.lookupFieldOwnerLabel,
        traversal.lookupField,
        currentPartial,
        traversal.lookupField.name,
        LOCAL_LOOKUP_OPERATOR_METHODS.has(method),
      )) {
        itemsByName.set(item.name, item);
      }
    }

    return {
      items: [...itemsByName.values()],
      resolved: true,
      currentModelLabel: traversal.currentModelLabel,
    };
  }

  getLookupIndex(): WorkspaceIndex {
    if (this.projectContexts.length === 0) return this.localWorkspaceIndex;
    const key = this.getRequestProjectKey();
    let view = this.projectViews.get(key);
    if (!view) {
      view = projectWorkspaceView(this.localWorkspaceIndex, this.projectContexts, this.documentContext.getStore());
      this.projectViews.set(key, view);
    }
    return view;
  }

  async resolveLookupPath(
    baseModelLabel: string,
    value: string,
    method: string,
    background: boolean = false
  ): Promise<LookupPathResolution> {
    const normalizedValue = normalizeLookupPathValue(value, method);
    const source = this.currentRequestSource();
    const sessionRevision = this.sessionRevision;
    const assertCurrent = (): void => {
      if (this.isAborted()) throw new Error('Aborted: resolveLookupPath');
      if (sessionRevision !== this.sessionRevision) {
        throw new Error('Native lookup preparation belongs to an inactive daemon session.');
      }
    };
    const allowLocationlessNative = background || source === 'diagnostic';
    let pythonFallback: Promise<LookupPathResolution> | undefined;
    const queryPython = (): Promise<LookupPathResolution> => pythonFallback ??= (async () => {
      assertCurrent();
      // Preserve the existing fallback and its test-only delay, including when
      // a pending native preparation and more than one caller share this IPC.
      const lookupDelayMs = parseInt(process.env.DJLS_TEST_RESOLVE_LOOKUP_PATH_DELAY_MS ?? '', 10);
      if (Number.isFinite(lookupDelayMs) && lookupDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, lookupDelayMs));
      }
      assertCurrent();
      return this.cachedRequest<LookupPathResolution>('resolveLookupPath', {
        baseModelLabel, value: normalizedValue, method,
      }, background);
    })();
    const local = this.lookupCatalog?.fields?.[baseModelLabel]
      ? this.resolveLookupPathLocal(baseModelLabel, normalizedValue, method)
      : undefined;
    if (local && (allowLocationlessNative || !local.resolved)) return local;
    // Native fast-path: static FSM walk on the resident model graph.
    // Python daemon was measured at up to 2.6s for one `title__startswith`
    // resolve. Only defer to Python when native can't answer (e.g.
    // custom runtime lookups registered via `register_lookup`).
    if (isNativeFastPathReady()) {
      let native = nativeResolveLookupPath(baseModelLabel, normalizedValue, method);
      if (!allowLocationlessNative && native?.resolved && native.target && !native.target.filePath) {
        const workspaceRoot = this.lastLaunchContext?.workspaceRoot;
        const parentSignal = this.abortSignalContext.getStore();
        const waiter = new AbortController();
        const endWait = (): void => waiter.abort(parentSignal?.reason ?? 'Native lookup source wait ended');
        parentSignal?.addEventListener('abort', endWait, { once: true });
        if (parentSignal?.aborted) endWait();
        let fallbackTurn: ReturnType<typeof setImmediate> | undefined;
        let settleScheduledFallback: ((result: LookupAttempt) => void) | undefined;
        type LookupAttempt = { kind: 'native'; value: LookupPathResolution | undefined }
          | { kind: 'python'; value: LookupPathResolution }
          | { kind: 'python-error'; error: unknown };
        try {
          const pending = workspaceRoot ? waitForPendingNativeAstModules(
            workspaceRoot, waiter.signal, this.deadlineContext.getStore()
          ) : undefined;
          if (pending) {
            const nativePreparation = pending.promise.then(prepared => {
              assertCurrent();
              return prepared && pending.isCurrent() && isNativeFastPathReady()
                ? nativeResolveLookupPath(baseModelLabel, normalizedValue, method) : undefined;
            });
            const scheduledPython = new Promise<LookupAttempt>(resolve => {
              settleScheduledFallback = resolve;
              // Let native completion already queued for this turn win without
              // an IPC. Otherwise don't spend the whole foreground deadline
              // waiting for a multi-second source index before trying Python.
              fallbackTurn = setImmediate(() => {
                fallbackTurn = undefined;
                void queryPython().then(
                  value => resolve({ kind: 'python', value }),
                  error => resolve({ kind: 'python-error', error }),
                );
              });
            });
            const first = await Promise.race<LookupAttempt>([
              nativePreparation.then(value => ({ kind: 'native', value })), scheduledPython,
            ]);
            assertCurrent();
            if (first.kind === 'python' && first.value.resolved) return first.value;
            const preparedNative = first.kind === 'native' ? first.value : await nativePreparation;
            assertCurrent();
            if (preparedNative?.resolved && preparedNative.target?.filePath
                && pending.isCurrent() && isNativeFastPathReady()) {
              native = preparedNative;
            } else {
              // Failed/negative Python answers do not hide a native source
              // answer that was already being prepared. Keep the original
              // fallback failure object when neither path can answer.
              if (first.kind === 'python-error') throw first.error;
              const result = first.kind === 'python' ? first.value : await queryPython();
              assertCurrent();
              return result;
            }
          }
        } finally {
          parentSignal?.removeEventListener('abort', endWait);
          endWait();
          if (fallbackTurn !== undefined) {
            clearImmediate(fallbackTurn);
            // Settle the unstarted branch without issuing or cancelling IPC.
            settleScheduledFallback?.({ kind: 'native', value: undefined });
          }
        }
      }
      if (native) {
        if (
          native.resolved &&
          LOCAL_LOOKUP_RELATION_ONLY_METHODS.has(method)
        ) {
          const localRelationOnlyCheck = this.resolveLookupPathLocal(
            baseModelLabel,
            normalizedValue,
            method
          );
          if (localRelationOnlyCheck?.reason === 'relation_required') {
            return localRelationOnlyCheck;
          }
          if (native.target && !native.target.isRelation) {
            return { resolved: false, reason: 'relation_required', baseModelLabel };
          }
        }
        // Foreground hover/definition still need precise source locations.
        // Diagnostics only need the boolean resolution outcome, so do not
        // send static lookup-operator hits like `title__startswith` back to
        // Python just because the native target is location-less.
        if (
          native.resolved &&
          native.target &&
          (native.target.filePath || allowLocationlessNative)
        ) {
          return local ? { ...native, terminalType: local.terminalType, lookupOperator: local.lookupOperator } : native;
        }
        // For diagnostic-background calls, skip the Python fallback when
        // it cannot disagree: if the daemon's Django runtime is not bootstrapped
        // (no `register_lookup` calls were executed), Python uses the same
        // default operator set that the Rust native path already evaluated.
        // The IPC roundtrip alone was measured at 1.4s under event-loop
        // pressure on a 1ms daemon-side operation — pure overhead for an
        // answer we already know.
        if (
          allowLocationlessNative &&
          native.resolved === false &&
          (
            this.currentState.runtime?.bootstrapStatus !== 'ready' ||
            process.env.DJLS_TEST_FORCE_RUNTIME_NOT_READY === '1'
          )
        ) {
          return native;
        }
      }
    }
    return queryPython();
  }

  async listOrmMemberCompletions(
    modelLabel: string,
    receiverKind: OrmReceiverKind,
    prefix: string,
    managerName?: string
  ): Promise<OrmMemberCompletionsResult> {
    return this.cachedRequest<OrmMemberCompletionsResult>('ormMemberCompletions', {
      modelLabel,
      receiverKind,
      prefix,
      managerName,
    });
  }

  /**
   * Native Rust bulk ORM member completion. Returns `undefined` when the
   * resident state is not ready. Covers the static surface — fields,
   * reverse relations, Django built-in methods, default manager. Project
   * `def` methods and dynamic managers still need the Python path.
   */
  listOrmMemberCompletionsNative(
    modelLabel: string,
    receiverKind: OrmReceiverKind,
    prefix: string,
    managerName?: string
  ): OrmMemberCompletionsResult | undefined {
    if (!isNativeFastPathReady()) return undefined;
    const result = nativeListOrmMemberCompletions(modelLabel, receiverKind, prefix, managerName);
    return result ? { ...result, items: result.items.filter((item) =>
      item.source !== 'builtin' || djangoBuiltinAvailable(item.name, this.currentState.runtime?.djangoVersion)) } : undefined;
  }

  /**
   * List ORM members from the local surface index without IPC.
   *
   * This is intentionally limited to receiver kinds whose surface entries are
   * stable enough to classify locally. Surface tuples may carry memberKind
   * and fieldKind metadata; older two-item cache entries still work with
   * conservative defaults.
   */
  listOrmMemberCompletionsLocal(
    modelLabel: string,
    receiverKind: OrmReceiverKind,
    prefix: string,
    managerName?: string
  ): OrmMemberCompletionsResult | undefined {
    if (receiverKind === 'scalar' || receiverKind === 'unknown') {
      return undefined;
    }

    if (receiverKind === 'instance') {
      const local = this.listLocalInstanceOrmMemberCompletions(modelLabel, prefix);
      const builtinItems = this.localBuiltinOrmMemberItems(
        modelLabel,
        receiverKind,
        prefix,
        managerName
      );
      if (!local) {
        return builtinItems.length > 0
          ? {
              resolved: true,
              items: builtinItems,
              receiverKind,
              modelLabel,
              managerName,
            }
          : undefined;
      }
      return {
        ...local,
        items: this.mergeOrmMemberItems(local.items, builtinItems),
      };
    }

    const modelEntry = this.surfaceIndex[modelLabel];
    const builtinItems = this.localBuiltinOrmMemberItems(
      modelLabel,
      receiverKind,
      prefix,
      managerName
    );
    if (!modelEntry) {
      return builtinItems.length > 0
        ? {
            resolved: true,
            items: builtinItems,
            receiverKind,
            modelLabel,
            managerName,
          }
        : undefined;
    }

    const kindEntry = modelEntry[receiverKind];
    if (!kindEntry) {
      return builtinItems.length > 0
        ? {
            resolved: true,
            items: builtinItems,
            receiverKind,
            modelLabel,
            managerName,
          }
        : undefined;
    }

    const normalizedPrefix = prefix.trim();
    const items: OrmMemberItem[] = [];

    for (const [name, [returnKind, returnModelLabel, surfaceMemberKind]] of Object.entries(kindEntry)) {
      if (normalizedPrefix && !name.startsWith(normalizedPrefix)) {
        continue;
      }

      const memberKind = surfaceMemberKind ?? (returnKind === 'manager' ? 'manager' : 'method');
      let detail = 'Django ORM member';
      if (memberKind === 'manager') {
        detail = 'Django manager';
      } else if (receiverKind === 'model_class') {
        detail = 'Django model class method';
      } else if (receiverKind === 'manager') {
        detail = 'Django manager method';
      } else if (receiverKind === 'queryset') {
        detail = 'Django queryset method';
      } else if (receiverKind === 'related_manager') {
        detail = 'Django related manager method';
      }

      items.push({
        name,
        memberKind,
        modelLabel,
        receiverKind,
        detail,
        source: 'local',
        isRelation: false,
        returnKind,
        returnModelLabel: returnModelLabel || undefined,
        managerName,
      });
    }

    return {
      resolved: true,
      items: this.mergeOrmMemberItems(items, builtinItems),
      receiverKind,
      modelLabel,
      managerName,
    };
  }

  private mergeOrmMemberItems(
    primaryItems: OrmMemberItem[],
    additionalItems: OrmMemberItem[]
  ): OrmMemberItem[] {
    if (additionalItems.length === 0) {
      return primaryItems;
    }

    const merged = [...primaryItems];
    const names = new Set(primaryItems.map((item) => item.name));
    for (const item of additionalItems) {
      if (names.has(item.name)) {
        continue;
      }
      names.add(item.name);
      merged.push(item);
    }
    return merged;
  }

  private localBuiltinOrmMemberItems(
    modelLabel: string,
    receiverKind: OrmReceiverKind | string,
    prefix: string,
    managerName?: string
  ): OrmMemberItem[] {
    const normalizedPrefix = prefix.trim();
    const items: OrmMemberItem[] = [];
    const addMethod = (
      name: string,
      detail: string,
      returnKind: string,
      returnModelLabel?: string
    ) => {
      if (!djangoBuiltinAvailable(name, this.currentState.runtime?.djangoVersion)) return;
      if (normalizedPrefix && !name.startsWith(normalizedPrefix)) {
        return;
      }
      items.push({
        name,
        memberKind: 'method',
        modelLabel,
        receiverKind,
        detail,
        source: 'builtin',
        returnKind,
        returnModelLabel,
        managerName,
        isRelation: false,
      });
    };

    if (
      receiverKind === 'manager' ||
      receiverKind === 'queryset' ||
      receiverKind === 'related_manager'
    ) {
      for (const name of LOCAL_QUERYSET_RETURNING_METHODS) {
        addMethod(name, 'Django queryset method', 'queryset', modelLabel);
      }
      for (const name of LOCAL_INSTANCE_RETURNING_METHODS) {
        addMethod(name, 'Django queryset method', 'instance', modelLabel);
      }
      for (const name of LOCAL_SCALAR_QUERYSET_METHODS) {
        addMethod(name, 'Django queryset method', 'scalar');
      }
      if (receiverKind === 'queryset' &&
          djangoBuiltinAvailable('totally_ordered', this.currentState.runtime?.djangoVersion) &&
          'totally_ordered'.startsWith(normalizedPrefix)) {
        items.push({
          name: 'totally_ordered', memberKind: 'property', modelLabel, receiverKind,
          detail: 'Whether this QuerySet has deterministic ordering.', source: 'builtin',
          returnKind: 'scalar', fieldKind: 'BooleanField', signature: ': bool', isRelation: false,
        });
      }
      return items;
    }

    if (receiverKind === 'instance') {
      for (const name of LOCAL_INSTANCE_METHODS) {
        addMethod(name, 'Django model instance method', 'scalar');
      }
    }

    return items;
  }

  private listLocalInstanceOrmMemberCompletions(
    modelLabel: string,
    prefix: string,
  ): OrmMemberCompletionsResult | undefined {
    const model = this.getLookupIndex().models.get(modelLabel);
    if (!model || model.fields.size === 0) {
      return undefined;
    }

    const normalizedPrefix = prefix.trim();
    const itemsByName = new Map<string, OrmMemberItem>();
    const addItem = (item: OrmMemberItem) => {
      if (normalizedPrefix && !item.name.startsWith(normalizedPrefix)) {
        return;
      }
      itemsByName.set(item.name, item);
    };

    for (const field of model.fields.values()) {
      if (this.isHiddenLookupFieldName(field.name)) {
        continue;
      }

      const relation =
        model.relations.get(field.name) ?? model.reverseRelations.get(field.name);
      const isReverseRelation = relation?.direction === 'reverse';
      const isForwardRelation = relation?.direction === 'forward' || (
        !relation && field.isRelation
      );
      let memberKind = 'field';
      let returnKind: string | undefined = 'scalar';
      let returnModelLabel: string | undefined;

      if (isReverseRelation) {
        memberKind = 'reverse_relation';
        returnKind = 'related_manager';
        returnModelLabel = relation?.targetModelLabel || undefined;
      } else if (isForwardRelation) {
        memberKind = 'relation';
        returnKind =
          field.fieldKind === 'ManyToManyField' ? 'related_manager' : 'instance';
        returnModelLabel = relation?.targetModelLabel || undefined;
      }
      if (
        (returnKind === 'instance' || returnKind === 'related_manager') &&
        !returnModelLabel
      ) {
        continue;
      }

      addItem({
        name: field.name,
        memberKind,
        modelLabel,
        receiverKind: 'instance',
        detail: field.fieldKind,
        source: 'local',
        fieldKind: field.fieldKind,
        isRelation: field.isRelation,
        returnKind,
        returnModelLabel,
      });
    }

    const instanceEntry = this.surfaceIndex[modelLabel]?.instance;
    if (instanceEntry) {
      for (const [name, [returnKind, returnModelLabel, surfaceMemberKind, fieldKind]] of Object.entries(instanceEntry)) {
        if (itemsByName.has(name)) {
          continue;
        }

        const memberKind = surfaceMemberKind ?? (returnKind === 'manager' ? 'manager' : 'method');
        addItem({
          name,
          memberKind,
          modelLabel,
          receiverKind: 'instance',
          detail:
            memberKind === 'field'
              ? (fieldKind ?? 'Django model field')
              : returnKind === 'manager'
              ? 'Django manager'
              : 'Django model instance method',
          source: 'local',
          fieldKind: memberKind === 'field' ? (fieldKind ?? undefined) : undefined,
          isRelation: returnKind === 'instance' || returnKind === 'related_manager',
          returnKind,
          returnModelLabel: returnModelLabel || undefined,
        });
      }
    }

    return {
      resolved: true,
      items: [...itemsByName.values()],
      receiverKind: 'instance',
      modelLabel,
    };
  }

  async resolveOrmMember(
    modelLabel: string,
    receiverKind: OrmReceiverKind,
    name: string,
    managerName?: string
  ): Promise<OrmMemberResolution> {
    const _ipcStart = performance.now();
    const _track = () => {
      this._trackIpcCall('resolveOrmMember', performance.now() - _ipcStart);
    };
    // Native fast-path: declared fields, reverse relations, and Django
    // built-in methods are all static data. Undefined return means the
    // member is not in the static surface — defer to Python for
    // project-defined methods and runtime managers.
    if (isNativeFastPathReady()) {
      const native = withKnownNativeMemberReturn(
        nativeResolveOrmMember(modelLabel, receiverKind, name, managerName),
        managerName ? undefined : this.surfaceIndex[modelLabel]?.[receiverKind]?.[name]
      );
      if (
        native &&
        (native.item?.source !== 'builtin' || djangoBuiltinAvailable(name, this.currentState.runtime?.djangoVersion)) &&
        (
          native.item?.filePath ||
          native.item?.source === 'builtin' ||
          native.item?.memberKind === 'method'
        )
      ) {
        _track();
        return native;
      }
    }
    // Test-only escape hatch: simulate the production "Python daemon
    // cannot resolve" state (captain workspace runs without Django
    // installed, so Python's static index has the model but lacks the
    // implicit `objects` / reverse-manager entries). Lets E2E tests
    // exercise the client-side fallbacks (e.g. `<model_class>.objects`
    // synthetic manager) without spinning up a non-Django workspace.
    if (process.env.DJLS_TEST_FORCE_ORM_MEMBER_UNRESOLVED === '1') {
      _track();
      return { resolved: false };
    }
    // Test-only knob: artificially slow the BG IPC so per-context
    // timeout in the phase2-lookups loop can be exercised by E2E.
    const delayMs = parseInt(
      process.env.DJLS_TEST_RESOLVE_ORM_MEMBER_DELAY_MS ?? '',
      10
    );
    if (Number.isFinite(delayMs) && delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      return await this.cachedRequest<OrmMemberResolution>('resolveOrmMember', {
        modelLabel,
        receiverKind,
        name,
        managerName,
      });
    } finally {
      _track();
    }
  }

  async resolveOrmMemberBatch(
    items: Array<{ modelLabel: string; receiverKind: string; name: string; managerName?: string }>
  ): Promise<OrmMemberResolution[]> {
    const result = await this.request<{ results: OrmMemberResolution[] }>(
      'resolveOrmMemberBatch',
      { items },
      INITIALIZE_REQUEST_TIMEOUT_MS,
      true,  // always background — batch is never user-interactive
      this.currentRequestSource()
    );
    return result.results;
  }

  async resolveLookupPathBatch(
    items: Array<{ baseModelLabel: string; value: string; method: string }>
  ): Promise<LookupPathResolution[]> {
    const normalizedItems = items.map((item) => ({
      ...item,
      value: normalizeLookupPathValue(item.value, item.method),
    }));
    const results: Array<LookupPathResolution | undefined> = new Array(normalizedItems.length);
    const fallbackItems: Array<{ baseModelLabel: string; value: string; method: string }> = [];
    const fallbackIndexes: number[] = [];

    // Same trust-native-when-runtime-not-ready gate as resolveLookupPath:
    // batches are always background, so we can use native's "not resolved"
    // verdict when Python is guaranteed to produce the same answer.
    const skipPythonForUnresolved =
      this.currentState.runtime?.bootstrapStatus !== 'ready' ||
      process.env.DJLS_TEST_FORCE_RUNTIME_NOT_READY === '1';

    for (const [index, item] of normalizedItems.entries()) {
      if (this.lookupCatalog?.fields?.[item.baseModelLabel]) {
        results[index] = this.resolveLookupPathLocal(item.baseModelLabel, item.value, item.method);
      }
    }

    if (isNativeFastPathReady()) {
      for (const [index, item] of normalizedItems.entries()) {
        if (results[index]) continue;
        const native = nativeResolveLookupPath(
          item.baseModelLabel,
          item.value,
          item.method,
        );
        if (
          native?.resolved &&
          LOCAL_LOOKUP_RELATION_ONLY_METHODS.has(item.method)
        ) {
          const localRelationOnlyCheck = this.resolveLookupPathLocal(
            item.baseModelLabel,
            item.value,
            item.method
          );
          if (localRelationOnlyCheck?.reason === 'relation_required') {
            results[index] = localRelationOnlyCheck;
            continue;
          }
          if (native.target && !native.target.isRelation) {
            results[index] = {
              resolved: false,
              reason: 'relation_required',
              baseModelLabel: item.baseModelLabel,
            };
            continue;
          }
        }
        if (native?.resolved && native.target) {
          results[index] = native;
          continue;
        }
        if (native && native.resolved === false && skipPythonForUnresolved) {
          results[index] = native;
          continue;
        }
        fallbackIndexes.push(index);
        fallbackItems.push(item);
      }
    } else {
      for (const [index, item] of normalizedItems.entries()) {
        if (results[index]) continue;
        if (skipPythonForUnresolved) {
          const local = this.resolveLookupPathLocal(
            item.baseModelLabel,
            item.value,
            item.method
          );
          if (local) {
            results[index] = local;
            continue;
          }
        }
        fallbackIndexes.push(index);
        fallbackItems.push(item);
      }
    }

    if (fallbackItems.length === 0) {
      return results.map(
        (result) => result ?? { resolved: false, reason: 'missing_result' }
      );
    }

    const result = await this.request<{ results: LookupPathResolution[] }>(
      'resolveLookupPathBatch',
      { items: fallbackItems },
      INITIALIZE_REQUEST_TIMEOUT_MS,
      true,  // always background
      this.currentRequestSource()
    );
    for (const [fallbackResultIndex, itemIndex] of fallbackIndexes.entries()) {
      results[itemIndex] = result.results[fallbackResultIndex];
    }

    return results.map(
      (resolved) => resolved ?? { resolved: false, reason: 'missing_result' }
    );
  }

  private resolveLookupPathLocal(
    baseModelLabel: string,
    value: string,
    method: string
  ): LookupPathResolution | undefined {
    const normalizedValue = normalizeLookupPathValue(value, method);
    if (!normalizedValue) {
      return { resolved: false, reason: 'empty', baseModelLabel };
    }
    if (!this.getLookupIndex().models.has(baseModelLabel)) {
      return undefined;
    }
    if (LOCAL_LOOKUP_RELATION_ONLY_METHODS.has(method)) {
      const relationOnly = this.resolveRelationOnlyLookupPathLocal(
        baseModelLabel,
        normalizedValue,
        method,
      );
      if (relationOnly) {
        return relationOnly;
      }
    }

    const parsed = parseLookupChain(
      normalizedValue,
      baseModelLabel,
      this.getLookupIndex(),
      method,
    );
    if (parsed.runtimeRequired) return undefined;
    const segments = parsed.segments.filter(Boolean);
    const resolvedCount = parsed.resolvedPath.length;
    const lastResolved = parsed.resolvedPath.at(-1);
    const relationOnlyScalarFinalField =
      LOCAL_LOOKUP_RELATION_ONLY_METHODS.has(method) &&
      parsed.finalField !== undefined &&
      !parsed.finalField.isRelation;
    const outputField = parsed.finalField;
    const terminalType = outputField && !outputField.isRelation ? {
      outputFieldKind: outputField.fieldKind,
      pythonType: pythonTypeForKind(outputField.fieldKind),
      isTransformed: parsed.resolvedPath.some((segment) => segment.kind === 'transform'),
      lookupOperator: parsed.finalLookup,
      operandPythonType: parsed.finalLookup
        ? operandPythonType(parsed.finalLookup, pythonTypeForKind(outputField.fieldKind)) : undefined,
    } : undefined;
    // Relation terminals have no scalar descriptor. Retain their model label
    // from the resident index so background inlays need no display-target RPC.
    const terminalRelation = parsed.finalLookup
      ? parsed.resolvedPath.at(-2)
      : lastResolved;
    const target = !terminalType && terminalRelation && (
      parsed.state === 'complete' || (parsed.state === 'partial' && resolvedCount >= segments.length)
    ) && (
      terminalRelation.kind === 'relation' || terminalRelation.kind === 'reverse_relation'
    ) ? this.localLookupFieldItem(
      terminalRelation.modelLabel ?? baseModelLabel,
      terminalRelation.name,
    ) : undefined;

    if (parsed.state === 'complete') {
      if (
        relationOnlyScalarFinalField ||
        (
          LOCAL_LOOKUP_RELATION_ONLY_METHODS.has(method) &&
          lastResolved &&
          lastResolved.kind !== 'relation' &&
          lastResolved.kind !== 'reverse_relation'
        )
      ) {
        return { resolved: false, reason: 'relation_required', baseModelLabel };
      }
      return {
        resolved: true,
        baseModelLabel,
        target,
        lookupOperator: parsed.finalLookup,
        terminalType,
      };
    }

    if (
      parsed.state === 'partial' &&
      resolvedCount >= segments.length &&
      lastResolved
    ) {
      if (
        relationOnlyScalarFinalField ||
        (
          LOCAL_LOOKUP_RELATION_ONLY_METHODS.has(method) &&
          lastResolved.kind !== 'relation' &&
          lastResolved.kind !== 'reverse_relation'
        )
      ) {
        return { resolved: false, reason: 'relation_required', baseModelLabel };
      }
      return { resolved: true, baseModelLabel, target, terminalType };
    }

    if (parsed.state === 'partial' || parsed.state === 'error') {
      const missingSegment =
        segments[parsed.errorAt ?? resolvedCount] ??
        segments[resolvedCount] ??
        normalizedValue;
      const reason = parsed.finalField
        ? 'invalid_lookup_operator'
        : 'segment_not_found';
      return {
        resolved: false,
        reason,
        missingSegment,
        baseModelLabel,
      };
    }

    return undefined;
  }

  /**
   * Resolve an ORM member from local indexes without IPC.
   * The returned item has enough fields for chain resolution (returnKind,
   * returnModelLabel, managerName) but NOT for display (detail, filePath).
   */
  resolveOrmMemberLocal(
    modelLabel: string,
    receiverKind: string,
    name: string
  ): OrmMemberResolution | undefined {
    const modelEntry = this.surfaceIndex[modelLabel];
    const kindEntry = modelEntry?.[receiverKind];
    const member = kindEntry?.[name];
    if (member) {
      const [returnKind, returnModelLabel, memberKind, fieldKind] = member;
      return {
        resolved: true,
        item: {
          name,
          memberKind: memberKind ?? 'field',
          modelLabel,
          receiverKind,
          detail: fieldKind ?? '',
          source: 'local',
          fieldKind: fieldKind ?? undefined,
          isRelation: returnKind === 'instance' || returnKind === 'related_manager',
          returnKind,
          returnModelLabel: returnModelLabel || undefined,
        },
      };
    }

    if (receiverKind !== 'instance') {
      const builtin = this.localBuiltinOrmMemberItems(
        modelLabel,
        receiverKind,
        name,
      ).find((item) => item.name === name);
      return builtin
        ? {
            resolved: true,
            item: builtin,
          }
        : undefined;
    }

    const model = this.getLookupIndex().models.get(modelLabel);
    const field = model?.fields.get(name);
    const relation =
      model?.relations.get(name) ?? model?.reverseRelations.get(name);
    if (!model || (!field && !relation)) {
      const builtin = this.localBuiltinOrmMemberItems(
        modelLabel,
        receiverKind,
        name,
      ).find((item) => item.name === name);
      return builtin
        ? {
            resolved: true,
            item: builtin,
          }
        : undefined;
    }

    const isReverseRelation = relation?.direction === 'reverse';
    const isForwardRelation =
      relation?.direction === 'forward' || (!relation && field?.isRelation);
    let memberKind = 'field';
    let returnKind = 'scalar';
    let returnModelLabel: string | undefined;

    if (isReverseRelation) {
      memberKind = 'reverse_relation';
      returnKind = 'related_manager';
      returnModelLabel = relation?.targetModelLabel || undefined;
    } else if (isForwardRelation) {
      memberKind = 'relation';
      returnKind =
        field?.fieldKind === 'ManyToManyField' ? 'related_manager' : 'instance';
      returnModelLabel = relation?.targetModelLabel || undefined;
    }
    if (
      (returnKind === 'instance' || returnKind === 'related_manager') &&
      !returnModelLabel
    ) {
      return undefined;
    }

    return {
      resolved: true,
      item: {
        name,
        memberKind,
        modelLabel,
        receiverKind,
        detail: field?.fieldKind ?? relation?.fieldKind ?? '',
        source: 'local',
        fieldKind: field?.fieldKind ?? relation?.fieldKind,
        isRelation: field?.isRelation ?? Boolean(relation),
        returnKind,
        returnModelLabel,
      },
    };
  }

  /** 로컬 surface index에서 O(1) chain resolution. daemon IPC 불필요. */
  resolveOrmMemberChainLocal(
    modelLabel: string,
    receiverKind: string,
    chain: string[],
    managerName?: string
  ): OrmMemberChainResolution {
    let currentLabel = modelLabel;
    let currentKind = receiverKind;

    for (const name of chain) {
      const resolution = this.resolveOrmMemberLocal(
        currentLabel,
        currentKind,
        name,
      );
      if (!resolution?.resolved || !resolution.item) {
        return { resolved: false, reason: 'member_not_found', failedAt: name };
      }
      currentKind = resolution.item.returnKind ?? currentKind;
      currentLabel = resolution.item.returnModelLabel ?? currentLabel;
    }

    return {
      resolved: true,
      modelLabel: currentLabel,
      receiverKind: currentKind,
    };
  }

  private resolveRelationOnlyLookupPathLocal(
    baseModelLabel: string,
    normalizedValue: string,
    method: string,
  ): LookupPathResolution | undefined {
    const segments = normalizedValue.split('__').filter(Boolean);
    if (segments.length === 0) {
      return undefined;
    }

    let currentModelLabel = baseModelLabel;
    const resolvedSegments: LookupPathItem[] = [];

    for (const [index, segment] of segments.entries()) {
      const model = this.getLookupIndex().models.get(currentModelLabel);
      if (!model) {
        return undefined;
      }

      const field = model.fields.get(segment);
      const relation = this.getLocalRelationInfo(currentModelLabel, segment);
      if (relation && !relationAllowedForMethod(model, relation, method)) {
        return { resolved: false, reason: 'relation_required', baseModelLabel, missingSegment: segment, resolvedSegments };
      }
      const item = this.localLookupFieldItem(
        currentModelLabel,
        segment,
        segments.slice(0, index + 1).join('__')
      );
      if (item) {
        resolvedSegments.push(item);
      }

      const isFinalSegment = index === segments.length - 1;
      if (relation) {
        if (isFinalSegment) {
          return {
            resolved: true,
            baseModelLabel,
            target: item,
            resolvedSegments,
          };
        }
        if (!relation.targetModelLabel) {
          return undefined;
        }
        currentModelLabel = relation.targetModelLabel;
        continue;
      }

      if (field) {
        if (isFinalSegment) {
          return {
            resolved: false,
            reason: 'relation_required',
            baseModelLabel,
            target: item,
            resolvedSegments,
          };
        }
        return {
          resolved: false,
          reason: 'non_relation_intermediate',
          baseModelLabel,
          missingSegment: segment,
          resolvedSegments,
        };
      }

      return undefined;
    }

    return undefined;
  }

  private splitLocalLookupPrefix(
    prefix: string,
    method: string,
  ): { completedSegments: string[]; currentPartial: string } {
    const normalizedPrefix = normalizeLookupPathValue(prefix, method);
    const endsWithSeparator = normalizedPrefix.endsWith('__');
    const rawSegments = normalizedPrefix.split('__').filter(Boolean);
    const currentPartial = endsWithSeparator
      ? ''
      : (rawSegments.pop() ?? '');

    return {
      completedSegments: rawSegments,
      currentPartial,
    };
  }

  private analyzeLocalLookupTraversal(
    baseModelLabel: string,
    parsed: ParsedLookup,
    method: string,
  ): LocalLookupTraversal | undefined {
    if (parsed.resolvedPath.length === 0) {
      return {
        completionMode: 'field',
        currentModelLabel: baseModelLabel,
      };
    }

    const lastResolved = parsed.resolvedPath[parsed.resolvedPath.length - 1];
    if (!lastResolved) {
      return undefined;
    }

    if (
      lastResolved.kind === 'relation' ||
      lastResolved.kind === 'reverse_relation'
    ) {
      const ownerModelLabel = lastResolved.modelLabel ?? baseModelLabel;
      const relation = this.getLocalRelationInfo(ownerModelLabel, lastResolved.name);
      if (!relation) {
        return undefined;
      }

      const lookupField = this.getLookupIndex().models
        .get(ownerModelLabel)
        ?.fields.get(lastResolved.name);
      if (supportsLookupTransforms(method) && lookupField) {
        return {
          completionMode: 'field_and_lookup',
          currentModelLabel: relation.targetModelLabel,
          lookupField,
          lookupFieldOwnerLabel: ownerModelLabel,
        };
      }

      return {
        completionMode: 'field',
        currentModelLabel: relation.targetModelLabel,
      };
    }

    if (
      (lastResolved.kind === 'field' || lastResolved.kind === 'transform') &&
      parsed.finalField &&
      supportsLookupTransforms(method)
    ) {
      return {
        completionMode: 'lookup',
        currentModelLabel: lastResolved.modelLabel ?? baseModelLabel,
        lookupField: parsed.finalField,
        lookupFieldOwnerLabel: lastResolved.modelLabel ?? baseModelLabel,
      };
    }

    return undefined;
  }

  private buildLocalFieldCompletionItems(
    currentModelLabel: string,
    parsed: ParsedLookup,
    currentPartial: string,
    method: string,
  ): LookupPathItem[] {
    const items: LookupPathItem[] = [];
    const candidates = getCompletionCandidates(
      parsed,
      currentPartial,
      this.getLookupIndex(),
      method,
    );

    for (const candidate of candidates) {
      if (candidate.kind !== 'field' && candidate.kind !== 'relation') {
        continue;
      }
      if (candidate.name.includes('__') || this.isHiddenLookupFieldName(candidate.name)) {
        continue;
      }

      const item = this.localLookupItemFromCandidate(currentModelLabel, candidate);
      if (item) {
        items.push(item);
      }
    }

    return items;
  }

  private buildPrefixedLocalLookupItems(
    currentModelLabel: string,
    directItems: LookupPathItem[],
    currentPartial: string,
    method: string,
  ): LookupPathItem[] {
    const model = this.getLookupIndex().models.get(currentModelLabel);
    if (!model) {
      return [];
    }

    const lowerPartial = currentPartial.toLowerCase();
    const itemsByName = new Map<string, LookupPathItem>();

    for (const item of directItems) {
      if (
        item.name.includes('__') ||
        item.fieldKind === 'lookup_operator' ||
        item.fieldKind === 'lookup_transform' ||
        this.isHiddenLookupFieldName(item.name)
      ) {
        continue;
      }
      if (lowerPartial && !item.name.toLowerCase().startsWith(lowerPartial)) {
        continue;
      }

      const field = model.fields.get(item.name);
      if (!field) {
        continue;
      }

      for (const lookupItem of this.buildLocalLookupItems(
        currentModelLabel,
        field,
        '',
        item.name,
        LOCAL_LOOKUP_OPERATOR_METHODS.has(method),
      )) {
        const prefixedName = `${item.name}__${lookupItem.name}`;
        if (lowerPartial && !prefixedName.toLowerCase().startsWith(lowerPartial)) {
          continue;
        }
        itemsByName.set(prefixedName, {
          ...lookupItem,
          name: prefixedName,
        });
      }
    }

    return [...itemsByName.values()];
  }

  private buildLocalDescendantCompletionItems(
    currentModelLabel: string,
    currentPartial: string,
    method: string,
  ): LookupPathItem[] {
    const relationOnly = LOCAL_LOOKUP_RELATION_ONLY_METHODS.has(method);
    const lowerPartial = currentPartial.toLowerCase();
    const itemsByName = new Map<string, LookupPathItem>();

    const walk = (
      modelLabel: string,
      prefixParts: string[],
      depth: number,
      visitedModels: Set<string>,
    ): void => {
      if (depth >= LOCAL_LOOKUP_CHAIN_DEPTH) {
        return;
      }

      for (const field of this.getLocalLookupFieldsForModel(modelLabel)) {
        const model = this.getLookupIndex().models.get(modelLabel);
        const eligibleRelation = this.getLocalRelationInfo(modelLabel, field.name);
        if (model && eligibleRelation && !relationAllowedForMethod(model, eligibleRelation, method)) continue;
        if (relationOnly && (!model || !eligibleRelation || !relationAllowedForMethod(model, eligibleRelation, method))) continue;
        const pathParts = [...prefixParts, field.name];
        const pathName = pathParts.join('__');
        if (
          prefixParts.length > 0 &&
          (!lowerPartial || pathName.toLowerCase().startsWith(lowerPartial)) &&
          (field.isRelation || !relationOnly)
        ) {
          const item = this.localLookupFieldItem(modelLabel, field.name, pathName);
          if (item) {
            itemsByName.set(pathName, item);
          }
        }

        const relation = field.isRelation
          ? this.getLocalRelationInfo(modelLabel, field.name)
          : undefined;
        if (!relation?.targetModelLabel || visitedModels.has(relation.targetModelLabel)) {
          continue;
        }

        const nextVisitedModels = new Set(visitedModels);
        nextVisitedModels.add(relation.targetModelLabel);
        walk(
          relation.targetModelLabel,
          pathParts,
          depth + 1,
          nextVisitedModels,
        );
      }
    };

    walk(currentModelLabel, [], 0, new Set([currentModelLabel]));
    return [...itemsByName.values()];
  }

  private buildLocalLookupItems(
    ownerModelLabel: string,
    field: FieldInfo,
    currentPartial: string,
    fieldPath: string = field.name,
    includeLookups = true,
  ): LookupPathItem[] {
    const lowerPartial = currentPartial.toLowerCase();
    const itemsByName = new Map<string, LookupPathItem>();

    for (const transform of field.transforms) {
      if (lowerPartial && !transform.toLowerCase().startsWith(lowerPartial)) {
        continue;
      }
      itemsByName.set(
        transform,
        this.localLookupOperatorItem(ownerModelLabel, transform, true, fieldPath),
      );
    }

    for (const lookup of includeLookups ? field.lookups : []) {
      if (field.transforms.includes(lookup)) continue;
      if (lowerPartial && !lookup.toLowerCase().startsWith(lowerPartial)) {
        continue;
      }
      itemsByName.set(
        lookup,
        this.localLookupOperatorItem(ownerModelLabel, lookup, false, fieldPath),
      );
    }

    return [...itemsByName.values()];
  }

  private getLocalLookupFieldsForModel(modelLabel: string): FieldInfo[] {
    const model = this.getLookupIndex().models.get(modelLabel);
    if (!model) {
      return [];
    }

    return [...model.fields.values()].filter(
      (field) => !this.isHiddenLookupFieldName(field.name),
    );
  }

  private getLocalRelationInfo(
    modelLabel: string,
    fieldName: string,
  ) {
    const model = this.getLookupIndex().models.get(modelLabel);
    return model?.relations.get(fieldName) ?? model?.reverseRelations.get(fieldName);
  }

  private localLookupItemFromCandidate(
    ownerModelLabel: string,
    candidate: PrefixCandidate,
  ): LookupPathItem | undefined {
    return this.localLookupFieldItem(ownerModelLabel, candidate.name);
  }

  private isHiddenLookupFieldName(name: string): boolean {
    return name.endsWith('+');
  }

  private localLookupFieldItem(
    ownerModelLabel: string,
    fieldName: string,
    itemName: string = fieldName,
  ): LookupPathItem | undefined {
    const model = this.getLookupIndex().models.get(ownerModelLabel);
    const field = model?.fields.get(fieldName);
    if (!field || this.isHiddenLookupFieldName(field.name)) {
      return undefined;
    }

    const relation = this.getLocalRelationInfo(ownerModelLabel, fieldName);
    return {
      name: itemName,
      modelLabel: ownerModelLabel,
      relatedModelLabel: relation?.targetModelLabel,
      fieldKind: field.fieldKind,
      isRelation: field.isRelation,
      fieldPath: itemName,
      relationDirection: relation?.direction,
      source: 'local',
    };
  }

  private localLookupOperatorItem(
    ownerModelLabel: string,
    operator: string,
    isTransform: boolean,
    fieldPath?: string,
  ): LookupPathItem {
    return {
      name: operator,
      modelLabel: ownerModelLabel,
      fieldKind: isTransform ? 'lookup_transform' : 'lookup_operator',
      isRelation: false,
      fieldPath,
      source: isTransform ? 'django_transform' : 'django_lookup',
      lookupOperator: isTransform ? undefined : operator,
    };
  }

  async resolveOrmMemberChain(
    modelLabel: string,
    receiverKind: OrmReceiverKind,
    chain: string[],
    managerName?: string
  ): Promise<OrmMemberChainResolution> {
    return this.cachedRequest<OrmMemberChainResolution>('resolveOrmMemberChain', {
      modelLabel,
      receiverKind,
      chain,
      managerName,
    });
  }

  async stop(): Promise<void> {
    this.restartRevision++;
    this.restartQueued = false;
    this.queuedRestartScope = undefined;
    this.restartPromise = undefined;
    await this.stopProcess();
  }

  private async stopProcess(): Promise<void> {
    const lifecycle = ++this.lifecycleRevision;
    this.surfaceCacheContext = null;
    this.sessionRevision++;
    this.stopRequested = true;
    const cancel = this.cancelStart;
    this.startPromise = undefined;
    this.cancelStart = undefined;
    cancel?.(new Error('Daemon startup belongs to an inactive daemon session.'));
    this.clearResponseCache();
    this.rejectAllPending(new Error('Analysis daemon stopped.'));
    dropNativeFastPath();

    const child = this.process;
    const stdoutReader = this.stdoutReader;

    if (child?.pid !== undefined) {
      this.intentionalExitProcessIds.add(child.pid);
    }

    await this.terminateProcess(child, stdoutReader);

    // Process exit can unblock a new start before this asynchronous stop returns.
    if (lifecycle !== this.lifecycleRevision) return;

    this.updateState({
      phase: 'stopped',
      detail: 'Daemon is stopped.',
      capabilities: this.currentState.capabilities,
      workspaceRoot: this.lastLaunchContext?.workspaceRoot,
      pythonPath: this.lastLaunchContext?.pythonPath,
      pythonSource: this.lastLaunchContext?.pythonSource,
      pythonSourceDetail: this.lastLaunchContext?.pythonSourceDetail,
      settingsModule: this.lastLaunchContext?.settingsModule,
      staticIndex: this.currentState.staticIndex,
      runtime: this.currentState.runtime,
      semanticGraph: this.currentState.semanticGraph,
      startedAt: this.currentState.startedAt,
    });
  }

  dispose(): void {
    void this.stop();
    this.stateEmitter.dispose();
    this.surfaceSnapshotEmitter.dispose();
    this.modelsReindexedEmitter.dispose();
    dropNativeFastPath();
  }

  private async terminateProcess(
    child?: ChildProcessWithoutNullStreams,
    stdoutReader?: readline.Interface
  ): Promise<void> {
    if (!child) {
      this.disposeProcessHandles(child, stdoutReader);
      return;
    }

    const nativeOwner = this.nativeStateOwners.get(child);
    nativeOwner?.beginStop();
    const waitForExit = (timeoutMs: number): Promise<boolean> =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve(true);
          return;
        }
        const timeout = setTimeout(() => {
          child.off('exit', onExit);
          resolve(false);
        }, timeoutMs);
        const onExit = (): void => {
          clearTimeout(timeout);
          resolve(true);
        };
        child.once('exit', onExit);
      });

    try {
      child.stdin.end();
    } catch {
      try {
        child.stdin.destroy();
      } catch {
        // Ignore stdio shutdown races during process teardown.
      }
    }

    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }

    const exited = await waitForExit(1200);
    if (!exited && child.exitCode === null && child.signalCode === null) {
      child.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
      await waitForExit(800);
    }

    await nativeOwner?.waitForStopCleanup();
    this.disposeProcessHandles(child, stdoutReader);
  }

  private async startProcess(
    scope?: vscode.ConfigurationScope
  ): Promise<HealthSnapshot> {
    const lifecycle = ++this.lifecycleRevision;
    this.surfaceCacheContext = null;
    this.clearResponseCache();
    this.surfaceSnapshotDecoder.reset();
    this.surfaceResyncPromise = undefined;
    this.surfaceResyncNeeded = false;
    clearTimeout(this.surfaceResyncRetry);
    this.surfaceResyncRetry = undefined;
    const launchContext = await this.createLaunchContext(scope);
    if (lifecycle !== this.lifecycleRevision) throw new Error('Daemon startup belongs to an inactive daemon session.');
    this.lastLaunchContext = launchContext;
    const serverModuleRoot = path.join(this.context.extensionPath, 'python');
    const environment = buildPythonEnvironment(serverModuleRoot, launchContext.pythonPath);
    if (launchContext.settingsModule) {
      environment.DJANGO_SETTINGS_MODULE = launchContext.settingsModule;
    }
    this.surfaceCacheContext = {
      owner: String(lifecycle), workspaceRoot: launchContext.workspaceRoot,
      pythonPath: launchContext.pythonPath, settingsModule: launchContext.settingsModule?.trim() || null,
      launchEnvironmentFingerprint: fingerprintLaunchEnvironment(environment),
    };
    this.stopRequested = false;
    this.updateState({
      phase: 'starting',
      detail: `Starting analysis daemon with ${launchContext.pythonPath} (${launchContext.pythonSource}).`,
      capabilities: [],
      workspaceRoot: launchContext.workspaceRoot,
      pythonPath: launchContext.pythonPath,
      pythonSource: launchContext.pythonSource,
      pythonSourceDetail: launchContext.pythonSourceDetail,
      settingsModule: launchContext.settingsModule,
    });

    try {
      await this.pythonCompatibility.check(launchContext.pythonPath, launchContext.workspaceRoot);
    } catch (error) {
      if (lifecycle === this.lifecycleRevision) this.updateStateFromError(error);
      throw error;
    }
    if (lifecycle !== this.lifecycleRevision) throw new Error('Daemon startup belongs to an inactive daemon session.');

    const nativeLaunch = daemonProcessLaunch(this.context.extensionPath, launchContext.pythonPath);
    const preparedState = nativeLaunch.stateChannel
      ? prepareNativeDaemonState(environment.TMPDIR || '/tmp', nativeLaunch.command, message => this.log('info', message))
      : undefined;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        nativeLaunch.command,
        [...(preparedState?.argsPrefix ?? []),
          '-m', 'django_orm_intellisense', '--stdio', '--workspace', launchContext.workspaceRoot],
        {
          cwd: launchContext.workspaceRoot,
          env: environment,
          stdio: preparedState?.stdio ?? 'pipe',
          ...(nativeLaunch.argv0 ? { argv0: nativeLaunch.argv0 } : {}),
        }
      ) as ChildProcessWithoutNullStreams; // The first three descriptors are explicitly pipes.
    } catch (error) {
      await preparedState?.disposeUnspawned();
      throw error;
    } finally {
      preparedState?.closeDescriptors();
    }
    const nativeOwner = preparedState?.bind(child);
    if (nativeOwner) this.nativeStateOwners.set(child, nativeOwner);

    this.process = child;
    this.sessionRevision++;
    const stdoutReader = readline.createInterface({ input: child.stdout });
    this.stdoutReader = stdoutReader;

    child.once('spawn', () => {
      this.log('info', `Daemon process spawned with pid ${child.pid ?? 'unknown'}.`);
    });

    child.once('error', (error) => {
      this.log('info', `Daemon failed to spawn: ${error.message}`);
      if (this.process !== child) {
        this.disposeProcessHandles(child, stdoutReader);
        return;
      }
      this.rejectAllPending(error);
      this.disposeProcessHandles(child, stdoutReader);
      if (!this.stopRequested) this.updateStateFromError(error);
    });

    child.once('exit', (code, signal) => {
      if (this.process !== child) {
        this.disposeProcessHandles(child, stdoutReader);
        if (child.pid !== undefined) {
          this.intentionalExitProcessIds.delete(child.pid);
        }
        return;
      }

      const intentional =
        (child.pid !== undefined && this.intentionalExitProcessIds.has(child.pid)) ||
        this.stopRequested;
      if (child.pid !== undefined) {
        this.intentionalExitProcessIds.delete(child.pid);
      }
      this.log(
        'info',
        `Daemon exited with code ${code ?? 'null'} and signal ${signal ?? 'null'}.`
      );
      this.clearResponseCache();
      this.rejectAllPending(
        new Error(
          !intentional
            ? `Analysis daemon exited unexpectedly (${code ?? 'null'}/${signal ?? 'null'}).`
            : 'Analysis daemon stopped.'
        )
      );
      this.disposeProcessHandles(child, stdoutReader);

      if (!intentional) {
        this.updateState({
          phase: 'error',
          detail: 'Analysis daemon exited unexpectedly.',
          capabilities: this.currentState.capabilities,
          workspaceRoot: this.lastLaunchContext?.workspaceRoot,
          pythonPath: this.lastLaunchContext?.pythonPath,
          pythonSource: this.lastLaunchContext?.pythonSource,
          pythonSourceDetail: this.lastLaunchContext?.pythonSourceDetail,
          settingsModule: this.lastLaunchContext?.settingsModule,
        });
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const message = chunk.toString().trim();
      if (message) {
        this.log('info', `[daemon stderr] ${message}`);
      }
    });

    stdoutReader.on('line', (line) => {
      if (this.process === child && !this.stopRequested) this.handleServerMessage(line);
    });

    try {
      this.pendingSourceObservationBoundary = captureNativeSourceBoundary();
      const [initializeResult] = await Promise.all([this.request<InitializeResult>(
        'initialize',
        {
          workspaceRoot: launchContext.workspaceRoot,
          settingsModule: launchContext.settingsModule,
          deferRuntime: true,
          surfaceSnapshotTransport: 1,
          sourceObservationTransport: 1,
          initializeSurfaceTransport: 1,
        },
        INITIALIZE_REQUEST_TIMEOUT_MS,
        false,
        'initialSync'
      ), nativeOwner?.ready]);
      if (lifecycle !== this.lifecycleRevision || this.process !== child || this.stopRequested) {
        throw new Error('Daemon initialization belongs to an inactive daemon session.');
      }
      const snapshot = this.adoptInitializeResult(initializeResult, 'initialize');
      if (this.sourceObservationContext && !this.surfaceSnapshotDecoder.hasBaseline) this.requestSurfaceSnapshotResync();
      return snapshot;
    } catch (error) {
      // Ownership readiness can fail before the initialize request settles.
      // Reject only this still-current child's requests, before detaching it;
      // a later session must retain its independent pending requests.
      if (this.process === child) {
        this.rejectAllPending(error instanceof Error ? error : new Error(String(error)));
      }
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        this.intentionalExitProcessIds.add(child.pid);
      }
      this.disposeProcessHandles(child, stdoutReader);
      if (!child.killed) {
        child.kill();
      }
      if (lifecycle === this.lifecycleRevision) this.updateStateFromError(error);
      throw error;
    }
  }

  private adoptInitializeResult(initializeResult: InitializeResult, reason: string): HealthSnapshot {
    initializeResult = this.surfaceSnapshotDecoder.decodeInitialize(initializeResult,
      Boolean(initializeResult.sourceObservationContext) && isSurfaceSourceProvenance(initializeResult.sourceProvenance));
    const snapshot = this.decorateSnapshot(initializeResult.health);
    const editablePaths = [...new Set(
      (initializeResult.venvInfo?.editableInstalls ?? []).map(entry => entry.path))];
    this.editableSourceRoots = [...new Set(editablePaths.map(normalizeSourcePath))];
    const context = initializeResult.sourceObservationContext;
    if (context) {
      this.editableSourceRoots = [...new Set(context.roots
        .filter(root => root.canonical !== snapshot.workspaceRoot).map(root => root.canonical))];
      const roots = context.roots.map(root => ({...root}));
      const rawWorkspace = this.lastLaunchContext?.workspaceRoot;
      if (rawWorkspace && !roots.some(root => root.raw === rawWorkspace)) {
        roots.push({raw: rawWorkspace, canonical: snapshot.workspaceRoot ?? normalizeSourcePath(rawWorkspace)});
      }
      this.sourceObservationContext = Object.freeze({version: 1 as const,
        boundary: this.pendingSourceObservationBoundary,
        configurationFiles: Object.freeze([...new Set([...context.configurationFiles, ...roots.map(root => root.raw)])]),
        sitePackages: Object.freeze([...context.sitePackages]),
        roots: Object.freeze(roots.map(root => Object.freeze(root)))});
    } else this.sourceObservationContext = undefined;
    this.surfaceIndex = initializeResult.surfaceIndex ?? {};
    this.projectContexts = initializeResult.projectContexts ?? [];
    this.sourceProvenance = initializeResult.sourceProvenance ?? null;
    this.surfaceFingerprints = initializeResult.surfaceFingerprints ?? {};
    this.customLookups = initializeResult.customLookups ?? {};
    this.lookupCatalog = initializeResult.lookupCatalog;
    this.customLookupsFingerprint = initializeResult.customLookupsFingerprint;
    this.staticFallback = initializeResult.staticFallback ?? null;
    this.staticFallbackFingerprint = initializeResult.staticFallbackFingerprint ?? null;
    this.metadataRetired = false;
    this.rebuildModelLabelByName();
    this.rebuildModelNames();
    this.rebuildLocalWorkspaceIndex();
    console.log(`[PERF] daemon initialized: modelNames=${this.modelNames.size} surfaceIndex=${Object.keys(this.surfaceIndex).length} modelLabelByName=${this.modelLabelByName.size}`);
    this.refreshNativeFastPathFromSurface(reason);
    this.updateState(snapshot);
    this.surfaceSnapshotEmitter.fire();
    return snapshot;
  }

  private async createLaunchContext(
    scope?: vscode.ConfigurationScope
  ): Promise<LaunchContext> {
    const resource = scope && 'uri' in scope ? scope.uri : scope instanceof vscode.Uri ? scope
      : vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    const settings = getExtensionSettings(
      resource ?? scope
    );
    const configuredWorkspaceRoot = settings.workspaceRoot
      ? path.resolve(settings.workspaceRoot)
      : undefined;
    const workspaceRoot =
      (configuredWorkspaceRoot && pathExists(configuredWorkspaceRoot)
        ? configuredWorkspaceRoot
        : undefined) ??
      (resource && vscode.workspace.getWorkspaceFolder(resource)?.uri.fsPath) ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      this.context.extensionPath;
    const interpreter = await resolvePythonInterpreter({...settings, workspaceRoot}, resource);
    const validation = validatePythonInterpreterPath(interpreter.path);

    if (!validation.valid) {
      throw new Error(
        `${validation.reason}. Set \`djangoOrmIntellisense.pythonInterpreter\` to a valid Python executable or virtualenv directory.`
      );
    }

    return {
      resource,
      workspaceRoot,
      pythonPath: validation.normalizedPath,
      pythonSource: interpreter.source,
      pythonSourceDetail: interpreter.detail,
      settingsModule: settings.settingsModule,
    };
  }

  private request<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
    background: boolean = false,
    source: IpcRequestSource = this.currentRequestSource()
  ): Promise<T> {
    const child = this.process, session = this.sessionRevision;
    if (!child || !child.stdin.writable) return this.requestRaw<T>(method, params, timeoutMs, background, source);
    if (this.metadataRetired && this.sourceObservationContext && this.currentState.phase === 'error'
        && method !== 'initialize') return Promise.reject(new Error('Source configuration is not ready.'));
    return this.sourceConfigurationRequests.request(
      method, timeoutMs,
      remaining => this.requestRaw<T>(method, params, remaining, background, source),
      () => this.process === child && this.sessionRevision === session && !this.stopRequested,
      this.abortSignalContext.getStore(),
    );
  }

  private requestRaw<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
    background: boolean = false,
    source: IpcRequestSource = this.currentRequestSource()
  ): Promise<T> {
    if (!this.process || !this.process.stdin.writable) {
      return Promise.reject(new Error('Analysis daemon is not running.'));
    }

    const id = `req-${++this.requestSequence}`;
    const message: RequestMessage = { id, method, params, source };
    if (background) {
      message.background = true;
    }
    const ipcStart = performance.now();

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request "${method}" timed out.`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (value: T) => {
          const ipcMs = performance.now() - ipcStart;
          const paramSummary = Object.entries(params).map(([k, v]) =>
            `${k}=${typeof v === 'string' ? v.slice(0, 40) : JSON.stringify(v)}`.slice(0, 60)
          ).join(', ');
          const sourceSummary = `source=${source}`;
          const summary = paramSummary
            ? `${sourceSummary}, ${paramSummary}`
            : sourceSummary;
          // Use logDiagnostic so tests can capture IPC timings via the
          // module-level log buffer.
          this.logDiagnostic(
            `  [IPC] ${method}(${summary}): ${ipcMs.toFixed(1)}ms`
          );
          resolve(value);
        },
        reject,
        timeout,
      });

      const serialized = JSON.stringify(message);
      this.log('debug', `[client->daemon] ${serialized}`);
      this.process?.stdin.write(`${serialized}\n`, 'utf8', (error) => {
        if (!error) {
          return;
        }

        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(error);
      });
    });
  }

  private cachedRequest<T>(
    method: string,
    params: Record<string, unknown>,
    background: boolean = false
  ): Promise<T> {
    const sourceFile = this.documentContext.getStore();
    if (this.projectContexts.length && sourceFile) params = {...params, _sourceFile: sourceFile};
    // Track every cachedRequest invocation (including cache hits) so the
    // per-cycle perf summary's ipc-by-method breakdown captures ALL daemon
    // IPC types, not just the 4 receiver-chain methods we wrapped
    // explicitly. Captain trace 2026-05-12 17:14 showed receiver
    // resolution wall time of 8–20s with only 0–223ms of explicit-method
    // IPCs accounted for — meaning the time was leaking through
    // unwrapped methods like resolveOrmMemberChain, lookupPathCompletions,
    // resolveLookupPath, etc. Instrumenting at this chokepoint surfaces
    // them all without touching each method site.
    const _cachedRequestStart = performance.now();
    const _trackCachedRequest = () => {
      this._trackIpcCall(`cachedRequest:${method}`, performance.now() - _cachedRequestStart);
    };
    // Fast-reject if the caller's abort signal has already fired.
    // This prevents orphaned hover resolution bodies from issuing new IPC
    // calls after the hover has been cancelled / timed out.
    if (this.isAborted()) {
      this.writeOutputLine(
        `  [IPC:abort] ${method} rejected (aborted) pending=${this.pendingRequests.size}`
      );
      _trackCachedRequest();
      return Promise.reject(new Error(`Aborted: ${method}`));
    }

    const source = this.currentRequestSource();
    const effectiveBackground = background || source === 'diagnostic';

    // Cache key ignores background flag so foreground (hover) and background
    // (diagnostic) requests for the same method+params share a single IPC
    // round-trip.  The daemon returns identical results regardless of queue.
    const cacheKey = JSON.stringify({ method, params });
    const cached = this.responseCache.get(cacheKey);
    if (cached) {
      const age = Date.now() - cached.createdAt;
      const effectiveTtl = source === 'diagnostic' || cached.source === 'diagnostic'
        ? DIAGNOSTIC_CACHE_TTL_MS
        : RESPONSE_CACHE_TTL_MS;
      if (age < effectiveTtl) {
        // Re-check abort even on cache hit: the caller may have been
        // cancelled between the top-of-function check and this point
        // (e.g. due to an intervening await in a loop).
        if (this.isAborted()) {
          return Promise.reject(new Error(`Aborted (cache hit): ${method}`));
        }
        // Promote to most-recently-used: delete + reinsert moves this
        // entry to the end of Map's insertion order, turning FIFO eviction
        // at .keys().next() into true LRU.
        this.responseCache.delete(cacheKey);
        this.responseCache.set(cacheKey, cached);
        return cached.promise as Promise<T>;
      }
      // TTL expired — evict and re-request
      this.responseCache.delete(cacheKey);
    }

    // Reject if pending queue is full to prevent backpressure freeze
    if (this.pendingRequests.size >= MAX_PENDING_REQUESTS) {
      this.writeOutputLine(
        `  [IPC] DROPPING ${method} (source=${source}): pending queue full (${this.pendingRequests.size}/${MAX_PENDING_REQUESTS})`
      );
      return Promise.reject(new Error(`Pending request queue full (${MAX_PENDING_REQUESTS}). Dropping ${method}.`));
    }

    // Reject oversized payloads before serialization stalls the event loop
    const serializedParams = JSON.stringify(params);
    if (serializedParams.length > MAX_PAYLOAD_BYTES) {
      this.writeOutputLine(
        `  [IPC] DROPPING ${method} (source=${source}): payload too large (${(serializedParams.length / 1024).toFixed(1)}KB > ${MAX_PAYLOAD_BYTES / 1024}KB)`
      );
      return Promise.reject(new Error(`Payload too large for ${method}: ${(serializedParams.length / 1024).toFixed(1)}KB`));
    }

    // Log queue state when it grows beyond a threshold
    const queueSize = this.pendingRequests.size;
    if (queueSize >= 5 && queueSize % 5 === 0) {
      const pending = [...this.pendingRequests.keys()].join(', ');
      this.writeOutputLine(
        `  [IPC:queue] pending=${queueSize} adding=${method}(source=${source}) ids=[${pending}]`
      );
    }

    const requestPromise = this.request<T>(
      method,
      params,
      REQUEST_TIMEOUT_MS,
      effectiveBackground,
      source
    );
    this.responseCache.set(cacheKey, { promise: requestPromise, createdAt: Date.now(), source });
    this.evictOldestCachedResponse();
    requestPromise.catch(() => {
      if (this.responseCache.get(cacheKey)?.promise === requestPromise) {
        this.responseCache.delete(cacheKey);
      }
    });
    // Settle the perf counter when the underlying IPC resolves, regardless
    // of success/failure. Cache hits return earlier and track only the
    // microsecond cache hit; cache misses incorporate the full IPC wait.
    requestPromise.then(() => _trackCachedRequest(), () => _trackCachedRequest());
    return requestPromise;
  }

  private handleServerMessage(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    this.log('debug', `[daemon->client] ${trimmed}`);

    const message = this.parseServerMessage(trimmed);
    if (!message) {
      return;
    }

    if ('event' in message) {
      this.handleServerNotification(message);
      return;
    }

    const payloadKb = trimmed.length / 1024;
    if (payloadKb >= 10) {
      this.writeOutputLine(
        `  [IPC:recv] ${message.id} payload=${payloadKb.toFixed(1)}KB`
      );
    }

    const pending = this.pendingRequests.get(message.id);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(message.id);
    clearTimeout(pending.timeout);

    if (message.error) {
      pending.reject(new Error(message.error.message));
      return;
    }

    pending.resolve(message.result);
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  private disposeProcessHandles(
    targetProcess?: ChildProcessWithoutNullStreams,
    targetReader?: readline.Interface
  ): void {
    targetReader?.removeAllListeners();
    try {
      targetReader?.close();
    } catch {
      // Ignore reader shutdown races during restart.
    }

    if (!targetProcess || this.process === targetProcess) {
      this.sourceConfigurationRequests.reset();
      this.sourceObservationContext = undefined;
      this.initializationPending = false;
      this.pendingSourceObservationBoundary = undefined;
      if (this.process) this.sessionRevision++;
      this.process = undefined;
      this.surfaceCacheContext = null;
      this.surfaceSnapshotDecoder.reset();
      this.surfaceResyncPromise = undefined;
      this.surfaceResyncNeeded = false;
      clearTimeout(this.surfaceResyncRetry);
      this.surfaceResyncRetry = undefined;
      this.retireMetadata();
    }

    if (!targetReader || this.stdoutReader === targetReader) {
      this.stdoutReader = undefined;
    }
  }

  private retireMetadata(): void {
    this.sourceProvenance = null;
    this.clearResponseCache();
    dropNativeFastPath();
    if (this.metadataRetired) return;
    this.projectContexts = [];
    this.projectViews.clear();
    this.surfaceIndex = {};
    this.surfaceFingerprints = {};
    this.customLookups = {};
    this.lookupCatalog = undefined;
    this.customLookupsFingerprint = undefined;
    this.staticFallback = null;
    this.staticFallbackFingerprint = null;
    this.modelNames = new Set();
    this.modelLabelByName = new Map();
    this.localWorkspaceIndex = createEmptyWorkspaceIndex();
    this.localModelFingerprints = new Map();
    this._shortNameFromFullLabelIndex = null;
    this.metadataRetired = true;
    this.modelsReindexedEmitter.fire();
    this.surfaceSnapshotEmitter.fire();
  }

  private updateState(snapshot: HealthSnapshot): void {
    this.currentState = snapshot;
    this.stateEmitter.fire(snapshot);
  }

  private decorateSnapshot(snapshot: HealthSnapshot): HealthSnapshot {
    return {
      ...snapshot,
      workspaceRoot: snapshot.workspaceRoot ?? this.lastLaunchContext?.workspaceRoot,
      pythonPath: snapshot.pythonPath ?? this.lastLaunchContext?.pythonPath,
      pythonSource: this.lastLaunchContext?.pythonSource,
      pythonSourceDetail: this.lastLaunchContext?.pythonSourceDetail,
      settingsModule: snapshot.settingsModule ?? this.lastLaunchContext?.settingsModule,
    };
  }

  private updateStateFromError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.clearResponseCache();
    this.updateState({
      phase: 'error',
      detail: message,
      capabilities: this.currentState.capabilities,
      workspaceRoot: this.lastLaunchContext?.workspaceRoot,
      pythonPath: this.lastLaunchContext?.pythonPath,
      pythonSource: this.lastLaunchContext?.pythonSource,
      pythonSourceDetail: this.lastLaunchContext?.pythonSourceDetail,
      settingsModule: this.lastLaunchContext?.settingsModule,
      staticIndex: this.currentState.staticIndex,
      runtime: this.currentState.runtime,
      semanticGraph: this.currentState.semanticGraph,
      startedAt: this.currentState.startedAt,
    });
  }

  private async checkForInterpreterChange(scope?: vscode.ConfigurationScope): Promise<void> {
    const previous = this.lastLaunchContext;
    const lifecycle = this.lifecycleRevision;
    if (!previous) {
      return;
    }

    const resource = scope ?? previous.resource ?? vscode.Uri.file(previous.workspaceRoot);
    const nextLaunchContext = await this.createLaunchContext(resource);
    if (lifecycle !== this.lifecycleRevision || this.lastLaunchContext !== previous || this.stopRequested
        || this.currentState.phase === 'stopped') return;
    if (nextLaunchContext.pythonPath === previous.pythonPath
        && nextLaunchContext.workspaceRoot === previous.workspaceRoot
        && nextLaunchContext.settingsModule === previous.settingsModule) {
      return;
    }

    this.log(
      'info',
      `Detected Python interpreter change (${this.lastLaunchContext.pythonPath} -> ${nextLaunchContext.pythonPath}). Restarting analysis daemon.`
    );
    await this.restart(resource);
  }

  private async requiresScopedRestart(
    scope: vscode.ConfigurationScope
  ): Promise<boolean> {
    if (!this.lastLaunchContext) {
      return false;
    }

    const nextLaunchContext = await this.createLaunchContext(scope);
    return (
      nextLaunchContext.workspaceRoot !== this.lastLaunchContext.workspaceRoot ||
      nextLaunchContext.pythonPath !== this.lastLaunchContext.pythonPath ||
      (nextLaunchContext.settingsModule ?? '') !==
        (this.lastLaunchContext.settingsModule ?? '')
    );
  }

  private writeOutputLine(message: string): void {
    try {
      this.output.appendLine(message);
    } catch {
      // The SDK may dispose the channel before a child exits or its pipes
      // finish. Diagnostics must not prevent rejection or handle cleanup.
    }
  }

  /** Write a diagnostic line to the output channel (always, regardless of logLevel). */
  logDiagnostic(message: string): void {
    this.writeOutputLine(message);
    if (isTestLogCaptureEnabled()) {
      testLogBuffer.push(message);
      if (testLogBuffer.length > TEST_LOG_BUFFER_LIMIT) {
        testLogBuffer.splice(0, testLogBuffer.length - TEST_LOG_BUFFER_LIMIT);
      }
    }
  }

  private log(level: 'info' | 'debug', message: string): void {
    const settings = getExtensionSettings();
    if (settings.logLevel === 'off') {
      return;
    }

    if (level === 'debug' && settings.logLevel !== 'debug') {
      return;
    }

    this.writeOutputLine(message);
  }

  private clearResponseCache(): void {
    this.responseCache.clear();
  }

  private evictOldestCachedResponse(): void {
    // Fast path: nothing to do when under the size limit. TTL-expired
    // entries are cleaned lazily on access (see cachedRequest), so a
    // full-Map sweep on every insert is wasted work — it was O(n) per
    // insert and dominated CPU under bursty completion loads.
    if (this.responseCache.size <= RESPONSE_CACHE_LIMIT) {
      return;
    }
    // When over capacity: drop TTL-expired entries first (cheap win),
    // then evict least-recently-used (Map insertion order, which
    // cachedRequest maintains as access order).
    const now = Date.now();
    for (const [key, entry] of this.responseCache) {
      const ttl = entry.source === 'diagnostic' ? DIAGNOSTIC_CACHE_TTL_MS : RESPONSE_CACHE_TTL_MS;
      if (now - entry.createdAt >= ttl) {
        this.responseCache.delete(key);
      }
      if (this.responseCache.size <= RESPONSE_CACHE_LIMIT) {
        return;
      }
    }
    while (this.responseCache.size > RESPONSE_CACHE_LIMIT) {
      const oldestKey = this.responseCache.keys().next().value;
      if (!oldestKey) {
        return;
      }
      this.responseCache.delete(oldestKey);
    }
  }

  private currentRequestSource(): IpcRequestSource {
    return this.requestSourceContext.getStore() ?? 'unknown';
  }

  private handleServerNotification(
    message: Extract<ServerMessage, { event: string }>
  ): void {
    if (this.initializationPending) return;
    if (message.event === 'healthChanged') {
      if (!message.params?.health) {
        return;
      }

      this.clearResponseCache();
      this.updateState(this.decorateSnapshot(message.params.health));
      return;
    }

    if (message.event !== 'surfaceIndexChanged') {
      return;
    }

    if (message.params) {
      try {
        message = { ...message, params: this.surfaceSnapshotDecoder.decode(message.params) };
        if (message.params?.surfaceIndex) {
          this.surfaceResyncNeeded = false;
          clearTimeout(this.surfaceResyncRetry);
          this.surfaceResyncRetry = undefined;
        }
      } catch (error) {
        this.surfaceSnapshotDecoder.reset();
        this.sourceProvenance = null;
        this.surfaceResyncNeeded = true;
        this.log('info', `Surface snapshot requires resynchronization: ${error instanceof Error ? error.message : String(error)}`);
        this.requestSurfaceSnapshotResync();
        return;
      }
    }

    this.clearResponseCache();
    // A partial/legacy publication cannot retain proof from another frame.
    this.sourceProvenance = null;
    if (message.params?.surfaceIndex) {
      this.surfaceIndex = message.params.surfaceIndex;
      this.projectContexts = message.params.projectContexts ?? [];
      this.sourceProvenance = message.params.sourceProvenance ?? null;
      this.surfaceFingerprints = message.params.surfaceFingerprints ?? {};
      this.customLookups = message.params.customLookups ?? {};
      this.lookupCatalog = message.params.lookupCatalog;
      this.customLookupsFingerprint = message.params.customLookupsFingerprint;
      this.staticFallback = message.params.staticFallback ?? null;
      this.staticFallbackFingerprint = message.params.staticFallbackFingerprint ?? null;
      this.metadataRetired = false;
      this.rebuildModelLabelByName();
      this.rebuildModelNames();
      this.rebuildLocalWorkspaceIndex();
      this.refreshNativeFastPathFromSurface('surfaceIndexChanged');
      this.modelsReindexedEmitter.fire();
    }

    const nextSnapshot = message.params?.health
      ? this.decorateSnapshot(message.params.health)
      : this.currentState;
    this.updateState(nextSnapshot);
    this.surfaceSnapshotEmitter.fire();
  }

  private requestSurfaceSnapshotResync(): void {
    if (this.surfaceResyncPromise || !this.process) return;
    clearTimeout(this.surfaceResyncRetry);
    this.surfaceResyncRetry = undefined;
    const session = this.sessionRevision;
    const request = this.request<{ resynced: boolean }>('resyncSurfaceSnapshot', {},
      INITIALIZE_REQUEST_TIMEOUT_MS, false, 'initialSync').then(() => {}, error => {
        if (session === this.sessionRevision) this.log('info', `Surface resynchronization failed: ${String(error)}`);
      }).finally(() => {
        if (this.surfaceResyncPromise !== request) return;
        this.surfaceResyncPromise = undefined;
        if (this.surfaceResyncNeeded && session === this.sessionRevision && this.process) {
          const timer = setTimeout(() => {
            if (this.surfaceResyncRetry !== timer) return;
            this.surfaceResyncRetry = undefined;
            if (session === this.sessionRevision && this.surfaceResyncNeeded) this.requestSurfaceSnapshotResync();
          }, 250);
          this.surfaceResyncRetry = timer;
        }
      });
    this.surfaceResyncPromise = request;
  }

  private parseServerMessage(line: string): ServerMessage | undefined {
    const firstNonWhitespace = line.search(/\S/);
    if (firstNonWhitespace < 0) {
      return undefined;
    }

    if (line[firstNonWhitespace] !== '{') {
      this.log('info', `[daemon stdout ignored] ${line}`);
      return undefined;
    }

    const extracted = extractLeadingJsonObject(line.slice(firstNonWhitespace));
    const candidate = extracted?.jsonText ?? line.slice(firstNonWhitespace);

    try {
      if (extracted?.trailingText.trim()) {
        this.log(
          'info',
          `[daemon stdout trailing noise ignored] ${extracted.trailingText.trim()}`
        );
      }
      const parsed = JSON.parse(candidate);
      // 옵션 C — daemon 이 gzip+b64 envelope 으로 보낸 메시지 unwrap.
      // captain initialize 22MB payload 가 ~2MB 로 줄어 stdout pipe write +
      // JSON.parse 비용 모두 절감.
      if (isCompressedEnvelope(parsed)) {
        return decompressIpcEnvelope<ServerMessage>(
          parsed.data,
          (msg) => this.log('info', msg),
        );
      }
      return parsed as ServerMessage;
    } catch (error) {
      this.log(
        'info',
        `Failed to parse daemon response: ${error instanceof Error ? error.message : String(error)}`
      );
      return undefined;
    }
  }
}

function extractLeadingJsonObject(
  text: string
): { jsonText: string; trailingText: string } | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char !== '}') {
      continue;
    }

    depth -= 1;
    if (depth === 0) {
      return {
        jsonText: text.slice(0, index + 1),
        trailingText: text.slice(index + 1),
      };
    }
  }

  return undefined;
}

function pathExists(targetPath: string): boolean {
  try {
    return fs.existsSync(targetPath);
  } catch {
    return false;
  }
}
