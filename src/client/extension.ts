import { lstat } from 'fs/promises';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, State } from 'vscode-languageclient/node';
import { registerClearCacheAndReindexCommand } from './commands/clearCacheAndReindex';
import { registerConfigurePylanceDiagnosticsCommand } from './commands/configurePylanceDiagnostics';
import { registerRestartDaemonCommand } from './commands/restartDaemon';
import { registerSelectSettingsModuleCommand } from './commands/selectSettingsModule';
import { registerSelectPythonInterpreterCommand } from './commands/selectPythonInterpreter';
import { registerShowStatusCommand } from './commands/showStatus';
import { isRelevantConfigurationChange, getExtensionSettings } from './config/settings';
import { AnalysisDaemon } from './daemon/analysisDaemon';
import type { ReindexFileResult } from './protocol';
import { HealthDiagnostics } from './diagnostics/healthDiagnostics';
import {
  registerPythonProviders,
  PythonInteractiveProviderOwner,
  isAnyDiagnosticScanInFlight,
  isAnyInteractiveRequestInFlight,
} from './providers/pythonProviders';
import { applyStubOverrides } from './pylance/stubOverrides';
import { normalizePythonInterpreterSettings } from './python/interpreter';
import { isPylanceAvailable, PYLANCE_EXTENSION_ID } from './python/pylance';
import { registerPythonProviderReadiness } from './python/providerReadiness';
import { registerPythonInterpreterChanges } from './python/interpreterChanges';
import { HealthStatusView } from './status/healthStatus';
import { currentPythonFilesBelowRoot, isWatchedSourcePath, normalizeSourceEventPath, normalizeSourcePath, pythonFilesBelowDirectory, retainPendingSourceEvents, shouldScanSourceDirectory, sourceWatcherRoots } from './sourceWatcher';
import { captureNativeSourceBoundary, createNativeSourceWatcher, createNativePathWatcher, type NativePathSelection, type NativeSourceBatch, type NativeSourceHandle } from './native/sourceWatcher';
import { collectSourceObservationPlan, createSourceObservation, sourceObservationTarget,
  type SourceObservationContext, type SourceObservationHandle } from './sourceObservation';
import { SurfaceCacheContextDelivery, SurfacePublisher } from './surfacePublisher';
import { createOwnedLanguageClient, LanguageServerLifecycle } from './languageServerLifecycle';

const SURFACE_ACKNOWLEDGEMENT_TIMEOUT_MS = 10_000;

let activeDaemon: AnalysisDaemon | undefined;
let languageClient: LanguageClient | undefined;
let languageServerLifecycle: LanguageServerLifecycle | undefined;
let startLanguageClientForTestingImpl: (() => void) | undefined;
let enableAutoRestartsForTestingImpl: (() => vscode.Disposable) | undefined;
const WATCHER_IGNORED_SEGMENTS = new Set([
  '.git',
  '.hg',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.svn',
  '.tox',
  '.venv',
  '__pycache__',
  'build',
  'dist',
  'node_modules',
  'out',
  'venv',
]);

export function getActiveDaemonForTesting(): AnalysisDaemon | undefined {
  return activeDaemon;
}

/** Test-only: start the actual language client through its production path. */
export function startLanguageClientForTesting(): void {
  startLanguageClientForTestingImpl?.();
}

/** Test-only: exercise configuration events through the enabled production path. */
export function enableAutoRestartsForTesting(): vscode.Disposable {
  if (!enableAutoRestartsForTestingImpl) throw new Error('Test capture is not enabled');
  return enableAutoRestartsForTestingImpl();
}

/** Test-only: observe the actual transport and server responses. */
export function getLanguageClientForTesting(): LanguageClient | undefined {
  return languageClient;
}

let promotePythonProvidersImpl: ((reason: string) => void) | undefined;
let pendingSourceEventsForTesting: (() => { files: readonly string[]; deletedPaths: readonly string[] }) | undefined;
let sourceBatchPublicationsForTesting: (() => number) | undefined;
let sourceWatcherStateForTesting: (() => unknown) | undefined;
type SourceWatcherCallbacks = { create(uri: vscode.Uri): void; change(uri: vscode.Uri): void;
  delete(uri: vscode.Uri): void; rootDelete(uri: vscode.Uri): void; rootCreate(uri: vscode.Uri): void };
let captureSourceWatcherCallbacksForTesting: ((root: string) => SourceWatcherCallbacks | undefined) | undefined;

/** Test-only: retain actual registered callbacks to simulate late delivery after disposal. */
export function getSourceWatcherCallbacksForTesting(root: string): SourceWatcherCallbacks | undefined {
  if (process.env.DJLS_TEST_CAPTURE_LOGS !== '1') return undefined;
  return captureSourceWatcherCallbacksForTesting?.(normalizeSourcePath(root));
}

/** Test-only: observe queued source events without draining or injecting them. */
export function getPendingSourceEventsForTesting(): { files: readonly string[]; deletedPaths: readonly string[] } {
  return pendingSourceEventsForTesting?.() ?? { files: [], deletedPaths: [] };
}

/** Test-only: count source batches applied by the server in the current scope. */
export function getSourceBatchPublicationCountForTesting(): number {
  return sourceBatchPublicationsForTesting?.() ?? 0;
}

/** Test-only: observe watcher events and an active batch without changing them. */
export function getSourceWatcherStateForTesting(): unknown {
  return sourceWatcherStateForTesting?.();
}

/** Test-only: trigger a Python provider promotion attempt (with deferral logic). */
export function promotePythonProvidersForTesting(reason: string): void {
  promotePythonProvidersImpl?.(reason);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Django ORM Intellisense');
  // 재배포 검증 마커 — captain 분석 시 production extension 이 옵션 1/2/3 fix 를
  // 반영한 빌드인지 한눈에 확인 가능. log.txt 최상단에서 이 라인이 안 보이면
  // VSCode 가 옛 vsix 를 캐시하고 있다는 신호 (Developer: Reload Window 필요).
  const extensionVersion = (context.extension?.packageJSON?.version ?? 'unknown') as string;
  const recvTimeoutMs = Number(
    process.env.DJLS_RECEIVER_TRACE_TIMEOUT_MS ?? 1500
  ) || 1500;
  const startupSettings = getExtensionSettings();
  output.appendLine(
    `[extension] activate version=${extensionVersion} ` +
    `recvTimeoutMs=${recvTimeoutMs} ` +
    `disableReceiverStepTrace=${process.env.DJLS_DISABLE_RECEIVER_STEP_TRACE === '1'} ` +
    `diagnosticTimeBudgetMs=${process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS ?? '(default)'} ` +
    `autoStart=${startupSettings.autoStart} ` +
    `ormDiagnostics=${startupSettings.diagnosticsEnabled} ` +
    `autoStubOverrides=${startupSettings.pylanceAutoApplyStubOverrides} ` +
    `registryMode=${process.env.DJLS_RUNTIME_REGISTRY_MODE ?? 'full'}`
  );
  const daemon = new AnalysisDaemon(context, output);
  const statusView = new HealthStatusView();
  const diagnostics = new HealthDiagnostics();
  let autoRestartsEnabled = process.env.DJLS_DISABLE_AUTO_RESTARTS !== '1';
  if (process.env.DJLS_TEST_CAPTURE_LOGS === '1') {
    enableAutoRestartsForTestingImpl = () => {
      const previous = autoRestartsEnabled;
      autoRestartsEnabled = true;
      return new vscode.Disposable(() => { autoRestartsEnabled = previous; });
    };
  }
  const pythonSourceWatchers = new Map<string, vscode.Disposable[]>();
  const watcherOwners = new Map<string, object>();
  const deletedSourceRoots = new Map<string, { session: number }>();
  const watcherRegistrationIdsForTesting = new Map<string, number>();
  const watcherCallbacksForTesting = new Map<string, SourceWatcherCallbacks>();
  captureSourceWatcherCallbacksForTesting = root => watcherCallbacksForTesting.get(root);
  let nextWatcherRegistrationIdForTesting = 0;
  let watchedPythonRoots: string[] = [];
  let watchedWorkspaceRoot: string | undefined;
  let sourceWorkspaceGeneration = 0;
  let sourcePublicationGeneration = 0;
  let reindexTimer: ReturnType<typeof setTimeout> | undefined;
  let sourceWatcherRetryTimer: ReturnType<typeof setTimeout> | undefined;
  const initialNativeSourceBoundary = captureNativeSourceBoundary();
  let nativeSessionBoundary: { session: number; boundary: string | undefined } | undefined;
  const nativeSourceGaps = new Map<string, string>();
  let physicalObservation: SourceObservationHandle | undefined;
  let physicalObservationContext: SourceObservationContext | undefined;
  let physicalObservationOwner = 0;
  let physicalObservationPlanning = false;
  let physicalObservationRequestVersion = 0;
  let physicalObservationRequested = false;
  let physicalObservationBoundary: string | undefined;
  const observedSourceAliases = new Map<string, string>();
  const pendingObservationAliases = new Set<string>();
  let reindexFlushRunning = false;
  let sourceWatchersDisposed = false;
  let sourceBatchPublicationCount = 0;
  let languageServerSession = 0;
  const publicationScope = (): string | undefined => {
    if (sourceWatchersDisposed) return undefined;
    if (!languageClient?.isRunning() || (!daemon.isReady() && !daemon.isMetadataRetired())) return undefined;
    // A resolved new owner is allowed to prewarm while Python starts. The
    // old retirement must not clear that new hint after context delivery.
    if (daemon.isMetadataRetired() && daemon.getState().phase === 'starting'
        && !daemon.isSourceConfigurationRefreshing()) return undefined;
    return `${languageServerSession}:${daemon.getSessionRevision()}:${daemon.getState().workspaceRoot ?? ''}:${daemon.isMetadataRetired() ? 'retired' : 'ready'}:${sourcePublicationGeneration}`;
  };
  const surfacePublisher = new SurfacePublisher({
    currentScope: publicationScope,
    isRetired: () => daemon.isMetadataRetired(),
    snapshotTransportEnabled: () => languageClient?.initializeResult?.capabilities.experimental?.djangoSurfaceSnapshotTransport === 1,
    snapshot: () => ({
      sourceProvenance: daemon.sourceProvenance,
      projectContexts: daemon.projectContexts,
      surfaceIndex: daemon.surfaceIndex,
      modelNames: [...daemon.getAllModelNames()],
      surfaceFingerprints: daemon.surfaceFingerprints,
      customLookups: daemon.customLookups,
      lookupCatalog: daemon.lookupCatalog,
      customLookupsFingerprint: daemon.customLookupsFingerprint,
      staticFallback: daemon.staticFallback,
      staticFallbackFingerprint: daemon.staticFallbackFingerprint,
    }),
    send: async (method, params) => {
      const client = languageClient;
      if (!client?.isRunning()) throw new Error('Language server is not running.');
      const scope = publicationScope();
      // Retirement invalidates native prewarm itself. It must be able to
      // clear resident tables while an older context ACK is unavailable.
      if (method !== 'django/clearSurfaceIndex') await publishSurfaceCacheContext();
      if (client !== languageClient || scope !== publicationScope() || !client.isRunning()) {
        throw new Error('Surface cache context belongs to an inactive language server session.');
      }
      const cancellation = new vscode.CancellationTokenSource();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error('Language server surface acknowledgement timed out.'));
          cancellation.cancel();
        }, SURFACE_ACKNOWLEDGEMENT_TIMEOUT_MS);
      });
      try {
        return await Promise.race([
          client.sendRequest<{ applied: boolean }>(method, params, cancellation.token),
          deadline,
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
        cancellation.dispose();
      }
    },
    reportFailure: error => output.appendLine(`[ls] surface delivery failed; retrying current snapshot: ${String(error)}`),
  });
  const cacheContextDelivery = new SurfaceCacheContextDelivery();
  let cacheContextRecovery: { client: LanguageClient; promise: Promise<void> } | undefined;
  const recoverSurfaceCacheConnection = (client: LanguageClient, session: number): void => {
    if (cacheContextRecovery?.client === client) return;
    const promise = client.stop().catch(error => {
      output.appendLine(`[ls] cache context connection stop failed: ${String(error)}`);
    }).then(async () => {
      if (!sourceWatchersDisposed && client === languageClient && session === languageServerSession && !client.isRunning()) {
        await client.start();
      }
    }).catch(error => {
      output.appendLine(`[ls] cache context connection recovery failed: ${String(error)}`);
    });
    const recovery = { client, promise };
    cacheContextRecovery = recovery;
    void promise.finally(() => {
      if (cacheContextRecovery === recovery) cacheContextRecovery = undefined;
    });
  };
  const publishSurfaceCacheContext = (): Promise<void> => {
    const client = languageClient;
    if (!client?.isRunning()) return Promise.resolve();
    const context = daemon.getSurfaceCacheContext();
    const session = languageServerSession;
    const key = `${languageServerSession}:${JSON.stringify(context)}`;
    return cacheContextDelivery.deliver(client, key, async signal => {
      if (signal.aborted || client !== languageClient || session !== languageServerSession || !client.isRunning()) {
        throw new Error('Surface cache context belongs to an inactive language server session.');
      }
      const cancellation = new vscode.CancellationTokenSource();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false, abort = (): void => {};
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          reject(new Error('Language server cache context acknowledgement timed out.'));
          cancellation.cancel();
        }, SURFACE_ACKNOWLEDGEMENT_TIMEOUT_MS);
        abort = () => {
          reject(new Error('Surface cache context delivery is disposed.'));
          cancellation.cancel();
        };
        signal.addEventListener('abort', abort, { once: true });
      });
      try {
        const result = await Promise.race([
          client.sendRequest<{ applied: boolean }>('django/setSurfaceCacheContext', context, cancellation.token),
          deadline,
        ]);
        if (!result.applied) throw new Error('Language server did not apply the selected cache context.');
      } catch (error) {
        if (timedOut && !signal.aborted && client === languageClient && session === languageServerSession) {
          // Closing the old connection also rejects its lost JSON-RPC
          // response entries; repeated timeouts cannot accumulate them.
          recoverSurfaceCacheConnection(client, session);
        }
        if (!signal.aborted) output.appendLine(`[ls] cache context delivery failed: ${String(error)}`);
        throw error;
      } finally {
        if (timeout) clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        cancellation.dispose();
      }
    });
  };
  sourceBatchPublicationsForTesting = () => sourceBatchPublicationCount;
  const providerPromotionTimers = new Set<ReturnType<typeof setTimeout>>();
  const pendingReindexFiles = new Set<string>();
  const pendingDeletedPaths = new Set<string>();
  const pendingSourceRoots = new Set<string>();
  const watcherEventsForTesting: Array<{ kind: string; path: string; at: number }> = [];
  let activeSourceFileForTesting: string | undefined;
  sourceWatcherStateForTesting = () => ({
    physicalObservation: physicalObservation?.state(),
    sourceConfigurationRefreshing: daemon.isSourceConfigurationRefreshing(),
    roots: [...watchedPythonRoots], workspaceRoot: watchedWorkspaceRoot,
    session: daemon.getSessionRevision(), ready: daemon.isReady(),
    running: reindexFlushRunning, activeFile: activeSourceFileForTesting,
    registrations: [...watcherRegistrationIdsForTesting.entries()],
    events: [...watcherEventsForTesting],
  });
  pendingSourceEventsForTesting = () => ({ files: [...pendingReindexFiles], deletedPaths: [...pendingDeletedPaths] });

  const disposePythonSourceWatcher = (): void => {
    disposePhysicalObservation();
    physicalObservationContext = undefined;
    pendingObservationAliases.clear();
    if (sourceWatcherRetryTimer) {
      clearTimeout(sourceWatcherRetryTimer);
      sourceWatcherRetryTimer = undefined;
    }
    const boundary = captureNativeSourceBoundary();
    if (boundary) for (const root of pythonSourceWatchers.keys()) nativeSourceGaps.set(root, boundary);
    // Revoke callbacks before dispose; queued deliveries cannot regain their
    // owner when the same filesystem root is registered again.
    watcherOwners.clear();
    for (const watchers of pythonSourceWatchers.values()) {
      for (const watcher of watchers) watcher.dispose();
    }
    pythonSourceWatchers.clear();
    watcherRegistrationIdsForTesting.clear();
    watcherCallbacksForTesting.clear();
    watchedPythonRoots = [];
  };

  const queueReindexFile = (filePath: string): void => {
    const normalizedPath = normalizeSourceEventPath(filePath, watchedPythonRoots);
    if (watchedPythonRoots.length > 0 && !isWatchedSourcePath(watchedPythonRoots, normalizedPath, WATCHER_IGNORED_SEGMENTS)) {
      return;
    }
    const previousTarget = observedSourceAliases.get(normalizedPath);
    try {
      if ((previousTarget !== undefined && sourceObservationTarget(filePath) !== previousTarget)
          || (previousTarget === undefined && fs.lstatSync(filePath).isSymbolicLink())) {
        pendingObservationAliases.add(normalizedPath);
      }
    } catch { if (previousTarget !== undefined) pendingObservationAliases.add(normalizedPath); }
    pendingReindexFiles.add(normalizedPath);
    if (reindexTimer) {
      clearTimeout(reindexTimer);
    }
    reindexTimer = setTimeout(() => {
      void flushPendingReindexFiles();
    }, 300);
  };

  const queueDeletedSourcePath = (filePath: string): void => {
    const normalizedPath = normalizeSourceEventPath(filePath, watchedPythonRoots);
    if (!watchedPythonRoots.includes(normalizedPath)
      && !isWatchedSourcePath(watchedPythonRoots, normalizedPath, WATCHER_IGNORED_SEGMENTS)) return;
    pendingDeletedPaths.add(normalizedPath);
    if (reindexTimer) clearTimeout(reindexTimer);
    reindexTimer = setTimeout(() => { void flushPendingReindexFiles(); }, 300);
  };

  function disposePhysicalObservation(): void {
    physicalObservationOwner++;
    if (physicalObservation) {
      physicalObservationBoundary ??= captureNativeSourceBoundary();
      physicalObservation.dispose();
      physicalObservation = undefined;
    }
    observedSourceAliases.clear();
  }

  function retryPhysicalObservation(configuration: boolean): void {
    if (sourceWatchersDisposed || sourceWatcherRetryTimer) return;
    const workspace = watchedWorkspaceRoot, session = daemon.getSessionRevision();
    sourceWatcherRetryTimer = setTimeout(() => {
      sourceWatcherRetryTimer = undefined;
      if (sourceWatchersDisposed || workspace !== watchedWorkspaceRoot
          || session !== daemon.getSessionRevision()) return;
      if (configuration) queueSourceConfigurationRefresh();
      else {physicalObservationRequested = true; requestPhysicalObservation();}
    }, 300);
  }

  function queueSourceConfigurationRefresh(): void {
    if (sourceWatchersDisposed || !daemon.getSourceObservationContext()) return;
    const workspace = watchedWorkspaceRoot, session = daemon.getSessionRevision();
    const current = (): boolean => !sourceWatchersDisposed && workspace === watchedWorkspaceRoot
      && session === daemon.getSessionRevision();
    sourcePublicationGeneration++;
    disposePhysicalObservation();
    void daemon.refreshSourceConfiguration(current).then(() => {
      if (current()) {physicalObservationRequested = true; requestPhysicalObservation();}
    }, error => {
      if (!current()) return;
      output.appendLine('[watcher] source configuration refresh failed: ' + String(error));
      retryPhysicalObservation(true);
    });
  }

  function ordinarySourceRootEvent(context: SourceObservationContext, file: string): boolean {
    return context.roots.some(root => {
      const rawName = path.join(normalizeSourcePath(path.dirname(root.raw)), path.basename(root.raw));
      if (file === root.canonical && rawName !== root.canonical) return true;
      if (file !== rawName) return false;
      try { if (fs.lstatSync(root.raw).isSymbolicLink()) return false; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') return false;
      }
      return sourceObservationTarget(root.raw) === root.canonical;
    });
  }

  function registerPhysicalPath(
    root: string, boundary: string | undefined, callback: (batch: NativeSourceBatch) => void,
    selection?: NativePathSelection,
  ): NativeSourceHandle {
    try {
      const native = createNativePathWatcher(root, boundary, callback, selection);
      if (native) return native;
    } catch (error) {
      output.appendLine('[watcher] native physical observation unavailable: ' + String(error));
    }
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
    let closed = false;
    const send = (uri: vscode.Uri, flags: number): void => {
      if (closed || uri.scheme !== 'file') return;
      callback({events: [{path: uri.fsPath, flags: flags | 0x20000, id: '0'}],
        rescan: false, baseChanged: false, historyDone: false});
    };
    const subscriptions = [
      watcher.onDidCreate(uri => send(uri, 0x100)),
      watcher.onDidChange(uri => send(uri, 0x1000)),
      watcher.onDidDelete(uri => send(uri, 0x200)),
    ];
    return {
      dispose(): void {
        if (closed) return;
        closed = true;
        for (const subscription of subscriptions) subscription.dispose();
        watcher.dispose();
      },
      // This adapter adds no separate pending queue; native queue/RAM metrics
      // are unavailable through the VS Code watcher API.
      state: () => ({closed, pendingBytes: 0, pendingEvents: 0,
        capacityBytes: 0, capacityEvents: 0, rescan: false}),
    };
  }

  function requestPhysicalObservation(): void {
    const nextContext = daemon.getSourceObservationContext();
    if (!nextContext) {
      disposePhysicalObservation();
      physicalObservationContext = undefined;
      physicalObservationRequested = false;
      return;
    }
    if (sourceWatchersDisposed || daemon.isSourceConfigurationRefreshing()) return;
    if (!physicalObservationRequested && physicalObservation
        && nextContext === physicalObservationContext) return;
    physicalObservationRequested = true;
    physicalObservationRequestVersion++;
    if (physicalObservationPlanning) return;
    physicalObservationPlanning = true;
    void (async () => {
      while (physicalObservationRequested && !sourceWatchersDisposed
          && !daemon.isSourceConfigurationRefreshing()) {
        physicalObservationRequested = false;
        const context = daemon.getSourceObservationContext();
        if (!context) return;
        if (context !== physicalObservationContext) physicalObservationBoundary = context.boundary;
        disposePhysicalObservation();
        const boundary = physicalObservationBoundary ?? context.boundary ?? captureNativeSourceBoundary();
        const owner = physicalObservationOwner, request = physicalObservationRequestVersion;
        const workspace = watchedWorkspaceRoot, session = daemon.getSessionRevision();
        const publication = sourcePublicationGeneration;
        const current = (): boolean => !sourceWatchersDisposed && owner === physicalObservationOwner
          && request === physicalObservationRequestVersion && workspace === watchedWorkspaceRoot
          && session === daemon.getSessionRevision() && publication === sourcePublicationGeneration
          && context === daemon.getSourceObservationContext() && !daemon.isSourceConfigurationRefreshing();
        try {
          const plan = await collectSourceObservationPlan(context, WATCHER_IGNORED_SEGMENTS, current);
          if (!plan || !current()) continue;
          const handle = createSourceObservation(plan, boundary, current, {
            configurationChanged: paths => {
              if (!current() || paths?.every(file => ordinarySourceRootEvent(context, file))) return;
              queueSourceConfigurationRefresh();
            },
            sourceChanged: file => {
              if (!current()) return;
              queueDeletedSourcePath(file);
              queueReindexFile(file);
            },
            reconcile: () => { if (current()) queueSourceConfigurationRefresh(); },
          }, error => output.appendLine('[watcher] physical source callback failed: ' + String(error)),
          registerPhysicalPath);
          if (!handle || !current()) {handle?.dispose(); continue;}
          physicalObservation = handle;
          physicalObservationContext = context;
          observedSourceAliases.clear();
          for (const item of plan.sourceFiles) {
            for (const name of item.sources) observedSourceAliases.set(
              normalizeSourceEventPath(name, watchedPythonRoots), item.target);
          }
          physicalObservationBoundary = undefined;
        } catch (error) {
          if (!current()) continue;
          const configuration = Boolean((error as {sourceConfigurationChanged?: boolean})?.sourceConfigurationChanged);
          output.appendLine('[watcher] physical source planning failed: ' + String(error));
          retryPhysicalObservation(configuration);
        }
      }
    })().finally(() => {physicalObservationPlanning = false;});
  }

  const flushPendingReindexFiles = async (): Promise<void> => {
    reindexTimer = undefined;
    if (sourceWatchersDisposed || reindexFlushRunning) return;
    if (pendingReindexFiles.size === 0 && pendingDeletedPaths.size === 0 && pendingSourceRoots.size === 0) {
      return;
    }
    if (!daemon.isReady()) {
      reindexTimer = setTimeout(() => {
        void flushPendingReindexFiles();
      }, 300);
      return;
    }

    reindexFlushRunning = true;
    const batchWorkspaceRoot = watchedWorkspaceRoot;
    const batchWorkspaceGeneration = sourceWorkspaceGeneration;
    const batchPublicationGeneration = sourcePublicationGeneration;
    const batchWatcherOwners = new Map(watcherOwners);
    const changedFiles = new Set<string>();
    const changedSourceRoots = new Set<string>();
    let batchObservationBoundary: string | undefined;
    const allBatchOwnersCurrent = (): boolean =>
      [...batchWatcherOwners].every(([root, owner]) => watcherOwners.get(root) === owner);
    const batchSessionRevision = daemon.getSessionRevision();
    const belongsToCurrentBatch = (filePath: string, deleted = false): boolean =>
      !sourceWatchersDisposed && batchWorkspaceRoot === watchedWorkspaceRoot
      && batchWorkspaceGeneration === sourceWorkspaceGeneration
      && batchPublicationGeneration === sourcePublicationGeneration
      && [...batchWatcherOwners].some(([root, owner]) => watcherOwners.get(root) === owner
        && ((deleted && root === filePath)
          || isWatchedSourcePath([root], filePath, WATCHER_IGNORED_SEGMENTS)));
    const batchSessionIsCurrent = (): boolean => batchSessionRevision === daemon.getSessionRevision();
    try {
      const files = new Set(pendingReindexFiles);
      pendingReindexFiles.clear();
      const deletedPaths = [...pendingDeletedPaths];
      pendingDeletedPaths.clear();
      const sourceRoots = [...pendingSourceRoots];
      pendingSourceRoots.clear();
      for (const deletedPath of deletedPaths) {
        if (!belongsToCurrentBatch(deletedPath, true)) continue;
        if (!batchSessionIsCurrent() || !daemon.isReady()) {
          pendingDeletedPaths.add(deletedPath);
          continue;
        }
        try {
          const deletedFiles = await daemon.deletedSourceFiles(deletedPath);
          if (!batchSessionIsCurrent() || !belongsToCurrentBatch(deletedPath, true)) {
            if (belongsToCurrentBatch(deletedPath, true)) pendingDeletedPaths.add(deletedPath);
            continue;
          }
          for (const file of deletedFiles) files.add(file);
        } catch (error) {
          output.appendLine(`[ls] deleted source lookup failed: ${String(error)}`);
          if (belongsToCurrentBatch(deletedPath, true)) pendingDeletedPaths.add(deletedPath);
        }
      }
      let anyChanged = false;
      const surfaceIndexDelta: Record<string, unknown> = {};
      const surfaceFingerprints: Record<string, string> = {};
      const addedLabels = new Set<string>();
      const changedLabels = new Set<string>();
      const removedLabels = new Set<string>();
      let latestStaticFallback: ReindexFileResult['staticFallback'];
      const staticFallbackDelta: NonNullable<ReindexFileResult['staticFallbackDelta']> = {};
      const removedStaticFallbackLabels = new Set<string>();
      let latestStaticFallbackFingerprint: ReindexFileResult['staticFallbackFingerprint'];
      const lookupCatalogDelta: NonNullable<ReindexFileResult['lookupCatalogDelta']> = {};
      const jobs: Array<{ filePath: string; root: boolean }> = [];
      const ownedSourceTrees = sourceRoots.filter(root => belongsToCurrentBatch(root, true));
      for (const root of ownedSourceTrees) {
        if (ownedSourceTrees.some(parent => parent !== root
          && isWatchedSourcePath([parent], root, WATCHER_IGNORED_SEGMENTS))) continue;
        for (const file of files) {
          if (isWatchedSourcePath([root], file, WATCHER_IGNORED_SEGMENTS)) files.delete(file);
        }
        jobs.push({ filePath: root, root: true });
      }
      for (const filePath of files) jobs.push({ filePath, root: false });
      for (const job of jobs) {
        const { filePath } = job;
        const ownsJob = (): boolean => belongsToCurrentBatch(filePath, job.root)
          && (!job.root || allBatchOwnersCurrent());
        const retainJob = (): void => {
          if (job.root) pendingSourceRoots.add(filePath);
          else pendingReindexFiles.add(filePath);
        };
        if (!ownsJob()) continue;
        if (!batchSessionIsCurrent() || !daemon.isReady()) {
          retainJob();
          continue;
        }
        try {
          let observationChanged = job.root || pendingObservationAliases.has(filePath);
          if (!observationChanged && observedSourceAliases.has(filePath)) {
            try {observationChanged = sourceObservationTarget(filePath) !== observedSourceAliases.get(filePath);}
            catch {observationChanged = true;}
          }
          const observationBoundary = observationChanged ? captureNativeSourceBoundary() : undefined;
          output.appendLine(`[ls] reindexing file: ${filePath}`);
          activeSourceFileForTesting = filePath;
          const result = job.root
            ? batchWatcherOwners.has(filePath)
              ? await daemon.reindexSourceRoot(filePath, () => batchSessionIsCurrent() && ownsJob())
              : await daemon.reindexSourceDirectory(filePath, () => batchSessionIsCurrent() && ownsJob())
            : await daemon.reindexFile(filePath, () => batchSessionIsCurrent() && ownsJob());
          if (!batchSessionIsCurrent() || !ownsJob()) {
            if (ownsJob()) retainJob();
            continue;
          }
          if (observationChanged) {
            pendingObservationAliases.delete(filePath);
            batchObservationBoundary ??= observationBoundary;
            physicalObservationRequested = true;
          }
          if (!result.unchanged) {
            anyChanged = true;
            changedFiles.add(filePath);
            if (job.root) changedSourceRoots.add(filePath);
            Object.assign(lookupCatalogDelta, result.lookupCatalogDelta);
            mergeReindexDelta(
              result,
              surfaceIndexDelta,
              surfaceFingerprints,
              addedLabels,
              changedLabels,
              removedLabels,
            );
            if (result.staticFallback !== undefined) {
              latestStaticFallback = result.staticFallback;
              latestStaticFallbackFingerprint = result.staticFallbackFingerprint;
              for (const label of Object.keys(staticFallbackDelta)) delete staticFallbackDelta[label];
              removedStaticFallbackLabels.clear();
            }
            if (result.staticFallbackDelta !== undefined) {
              for (const label of result.removedStaticFallbackLabels ?? []) {
                delete staticFallbackDelta[label];
                removedStaticFallbackLabels.add(label);
              }
              for (const [label, entry] of Object.entries(result.staticFallbackDelta)) {
                removedStaticFallbackLabels.delete(label);
                staticFallbackDelta[label] = entry;
              }
              latestStaticFallbackFingerprint = result.staticFallbackFingerprint;
            }
          }
        } catch (error) {
          output.appendLine(`[ls] reindex failed: ${String(error)}`);
          const recovery = error instanceof Error
            ? (error as Error & { sourceReindexOwnerRetired?: { filePath: string; sessionRevision: number } }).sourceReindexOwnerRetired
            : undefined;
          const currentWorkspaceRoot = daemon.getState().workspaceRoot;
          if (recovery?.filePath === filePath && recovery.sessionRevision === daemon.getSessionRevision()
              && !sourceWatchersDisposed && daemon.isReady() && !daemon.isMetadataRetired()
              && batchWorkspaceRoot !== undefined && batchWorkspaceRoot === watchedWorkspaceRoot
              && currentWorkspaceRoot !== undefined && normalizeSourcePath(currentWorkspaceRoot) === watchedWorkspaceRoot
              && [...watcherOwners.keys()].some(root => pythonSourceWatchers.has(root)
                && ((job.root && root === filePath) || isWatchedSourcePath([root], filePath, WATCHER_IGNORED_SEGMENTS)))) {
            // Never adopt the retired payload or revive its callback. A new
            // batch captures the current registration and validates source.
            if (job.root) {
              pendingSourceRoots.add(filePath);
              queueDeletedSourcePath(filePath);
            } else queueReindexFile(filePath);
          } else if (ownsJob()) {
            retainJob();
          }
        }
      }

      if (!anyChanged || !batchSessionIsCurrent() || sourceWatchersDisposed
          || batchWorkspaceRoot !== watchedWorkspaceRoot || batchWorkspaceGeneration !== sourceWorkspaceGeneration) {
        return;
      }
      if ([...changedFiles].some(file => !belongsToCurrentBatch(file, true))
          || (changedSourceRoots.size > 0 && !allBatchOwnersCurrent())) {
        // A later file can yield while an earlier contributor loses its root.
        // Recover from the current complete state instead of mixing owners.
        surfacePublisher.requestFull();
        return;
      }

      output.appendLine(
        `[ls] sending surfaceIndex delta after reindex: +${addedLabels.size} ~${changedLabels.size} -${removedLabels.size}`
      );
      const scope = publicationScope();
      if (scope !== undefined) {
        const applied = await surfacePublisher.publishDelta({
          projectContexts: daemon.projectContexts,
          surfaceIndexDelta,
          surfaceFingerprints,
          addedLabels: [...addedLabels],
          changedLabels: [...changedLabels],
          removedLabels: [...removedLabels],
          staticFallback: latestStaticFallback,
          staticFallbackDelta,
          removedStaticFallbackLabels: [...removedStaticFallbackLabels],
          staticFallbackFingerprint: latestStaticFallbackFingerprint,
          lookupCatalogDelta,
        }, scope);
        if (applied && batchSessionIsCurrent() && scope === publicationScope()
            && [...changedFiles].every(file => belongsToCurrentBatch(file, true))
            && (changedSourceRoots.size === 0 || allBatchOwnersCurrent())) sourceBatchPublicationCount++;
      }
    } finally {
      activeSourceFileForTesting = undefined;
      reindexFlushRunning = false;
      if (batchObservationBoundary) physicalObservationBoundary = batchObservationBoundary;
      if (physicalObservationRequested) requestPhysicalObservation();
      if (!sourceWatchersDisposed && !reindexTimer
        && (pendingReindexFiles.size > 0 || pendingDeletedPaths.size > 0 || pendingSourceRoots.size > 0)) {
        reindexTimer = setTimeout(() => { void flushPendingReindexFiles(); }, 300);
      }
    }
  };

  const rememberDeletedSourceRoot = (root: string): void => {
    const session = daemon.getSessionRevision();
    if (deletedSourceRoots.get(root)?.session !== session) deletedSourceRoots.set(root, { session });
  };

  const recoverRestoredSourceRoot = async (root: string, ownsWatcher: () => boolean): Promise<void> => {
    const invalidation = deletedSourceRoots.get(root);
    if (!invalidation || !autoRestartsEnabled || !ownsWatcher()) return;
    const workspaceRoot = watchedWorkspaceRoot;
    const workspaceGeneration = sourceWorkspaceGeneration;
    const publicationGeneration = sourcePublicationGeneration;
    const ownsRecovery = (): boolean => !sourceWatchersDisposed && ownsWatcher()
      && watchedWorkspaceRoot === workspaceRoot && sourceWorkspaceGeneration === workspaceGeneration
      && sourcePublicationGeneration === publicationGeneration
      && deletedSourceRoots.get(root) === invalidation
      && invalidation.session === daemon.getSessionRevision();
    const isCurrent = (): boolean => {
      const backendRoot = daemon.getState().workspaceRoot;
      return Boolean(workspaceRoot && backendRoot && ownsRecovery()
        && normalizeSourcePath(backendRoot) === workspaceRoot);
    };
    if (!isCurrent()) return;
    try {
      // Registration can miss earlier file events. Reconcile the entire root
      // through the existing source-verified batch, preserving this session.
      const files = await currentPythonFilesBelowRoot(root, WATCHER_IGNORED_SEGMENTS, isCurrent);
      if (files === undefined || !isCurrent()) return;
      pendingSourceRoots.add(root);
      queueDeletedSourcePath(root);
      for (const file of files) {
        if (!ownsRecovery()) return;
        queueReindexFile(file);
      }
      if (ownsRecovery()) deletedSourceRoots.delete(root);
    } catch (error) {
      if (ownsRecovery()) daemon.logDiagnostic('[watcher] restored source root recovery failed: ' + String(error));
    }
  };

  const updatePythonSourceWatcher = (workspaceRoot?: string): void => {
    if (sourceWatcherRetryTimer) {
      clearTimeout(sourceWatcherRetryTimer);
      sourceWatcherRetryTimer = undefined;
    }
    if (sourceWatchersDisposed) return;
    if (daemon.getState().phase === 'starting' && nativeSessionBoundary?.session !== daemon.getSessionRevision()) {
      nativeSessionBoundary = { session: daemon.getSessionRevision(), boundary: captureNativeSourceBoundary() };
    }
    for (const [root, invalidation] of deletedSourceRoots) {
      if (invalidation.session !== daemon.getSessionRevision()) deletedSourceRoots.delete(root);
    }
    if (!workspaceRoot) {
      if (watchedWorkspaceRoot !== undefined) {
        sourceWorkspaceGeneration++;
        sourcePublicationGeneration++;
      }
      pendingReindexFiles.clear();
      pendingDeletedPaths.clear();
      pendingSourceRoots.clear();
      watchedWorkspaceRoot = undefined;
      disposePythonSourceWatcher();
      return;
    }

    const sourceContext = daemon.getSourceObservationContext();
    const nextWorkspaceRoot = sourceContext ? workspaceRoot : normalizeSourcePath(workspaceRoot);
    const nextRoots = sourceContext
      ? [...new Set(sourceContext.roots.map(root => root.canonical))].sort()
      : sourceWatcherRoots(workspaceRoot, daemon.getEditableSourceRoots());
    for (const root of pendingSourceRoots) {
      if (!nextRoots.includes(root) && !isWatchedSourcePath(nextRoots, root, WATCHER_IGNORED_SEGMENTS)) {
        pendingSourceRoots.delete(root);
      }
    }
    if (nextWorkspaceRoot === watchedWorkspaceRoot && nextRoots.length === watchedPythonRoots.length
      && nextRoots.every((root, index) => root === watchedPythonRoots[index] && pythonSourceWatchers.has(root))) {
      requestPhysicalObservation();
      return;
    }

    if (nextWorkspaceRoot !== watchedWorkspaceRoot) sourceWorkspaceGeneration++;
    if (nextWorkspaceRoot !== watchedWorkspaceRoot || nextRoots.length !== watchedPythonRoots.length
        || nextRoots.some((root, index) => root !== watchedPythonRoots[index])) sourcePublicationGeneration++;
    // Initialize can add editable roots after workspace events were queued.
    // Preserve those events while discarding revoked roots or another workspace.
    retainPendingSourceEvents(watchedWorkspaceRoot, nextWorkspaceRoot, nextRoots,
      pendingReindexFiles, pendingDeletedPaths, WATCHER_IGNORED_SEGMENTS);
    if (nextWorkspaceRoot !== watchedWorkspaceRoot) {
      disposePythonSourceWatcher();
    } else {
      const boundary = captureNativeSourceBoundary();
      const retainedRoots = new Set(nextRoots);
      for (const [root, watchers] of pythonSourceWatchers) {
        if (retainedRoots.has(root)) continue;
        if (boundary) nativeSourceGaps.set(root, boundary);
        watcherOwners.delete(root);
        for (const watcher of watchers) watcher.dispose();
        pythonSourceWatchers.delete(root);
        watcherRegistrationIdsForTesting.delete(root);
        watcherCallbacksForTesting.delete(root);
      }
    }
    watchedWorkspaceRoot = nextWorkspaceRoot;
    watchedPythonRoots = nextRoots;
    // Removed roots can use this session's earlier boundary if added again.
    // Keep only current roots here, rather than retaining every historical path.
    for (const root of nativeSourceGaps.keys()) if (!nextRoots.includes(root)) nativeSourceGaps.delete(root);

    const recordWatcherEvent = (kind: string, uri: vscode.Uri): void => {
      if (process.env.DJLS_TEST_CAPTURE_LOGS !== '1') return;
      watcherEventsForTesting.push({ kind, path: uri.fsPath, at: Date.now() });
      if (watcherEventsForTesting.length > 64) watcherEventsForTesting.shift();
    };
    const onWatcherEvent = (kind: string, uri: vscode.Uri, ownsWatcher: () => boolean): void => {
      recordWatcherEvent(kind, uri);
      if (uri.scheme !== 'file') return;
      if (path.extname(uri.fsPath).toLowerCase() === '.py') {
        queueReindexFile(uri.fsPath);
      } else if (kind === 'create') {
        const workspaceGeneration = sourceWorkspaceGeneration;
        const publicationGeneration = sourcePublicationGeneration;
        const session = daemon.getSessionRevision();
        const isCurrent = (): boolean => ownsWatcher() && workspaceGeneration === sourceWorkspaceGeneration
          && publicationGeneration === sourcePublicationGeneration && session === daemon.getSessionRevision();
        // Watchers may report a populated directory rename as one directory
        // event instead of individual child-file events. Discover its sources
        // so the new module paths replace the old indexed paths.
        void lstat(uri.fsPath)
          // A create event can race with a rename or deletion.
          .catch(() => undefined)
          .then(async entry => {
            if (!entry || (!entry.isDirectory() && !entry.isSymbolicLink()) || !isCurrent()) return;
            const directory = normalizeSourcePath(uri.fsPath);
            if (!shouldScanSourceDirectory(watchedPythonRoots, directory, WATCHER_IGNORED_SEGMENTS)) return;
            const ownedDirectory = watchedPythonRoots.includes(directory)
              || isWatchedSourcePath(watchedPythonRoots, directory, WATCHER_IGNORED_SEGMENTS);
            let files: string[] | undefined;
            try {
              files = ownedDirectory
                ? await currentPythonFilesBelowRoot(directory, WATCHER_IGNORED_SEGMENTS, isCurrent)
                : await pythonFilesBelowDirectory(uri.fsPath, WATCHER_IGNORED_SEGMENTS);
            } catch (error) {
              if (ownedDirectory && isCurrent()) {
                // Keep only a current owned hint. The backend's strict scan
                // rejects partial inventories and the existing timer retries.
                pendingSourceRoots.add(directory);
                queueDeletedSourcePath(directory);
                daemon.logDiagnostic('[watcher] directory scan failed: ' + String(error));
              }
              return;
            }
            if (files === undefined || !isCurrent()) return;
            if (ownedDirectory) {
              pendingSourceRoots.add(directory);
              queueDeletedSourcePath(directory);
            }
            for (const file of files) queueReindexFile(file);
          });
      }
    };

    let retryRegistration = false;
    for (const root of nextRoots) {
      if (pythonSourceWatchers.has(root)) continue;
      const watchers: vscode.Disposable[] = [];
      const owner = {};
      watcherOwners.set(root, owner);
      const ownsWatcher = (): boolean => !sourceWatchersDisposed
        && watchedWorkspaceRoot === nextWorkspaceRoot && watcherOwners.get(root) === owner
        && pythonSourceWatchers.get(root) === watchers;
      const callbacks: SourceWatcherCallbacks = {
        create: uri => { if (ownsWatcher()) onWatcherEvent('create', uri, ownsWatcher); },
        change: uri => { if (ownsWatcher()) onWatcherEvent('change', uri, ownsWatcher); },
        delete: uri => {
          if (!ownsWatcher()) return;
          recordWatcherEvent('delete', uri);
          if (uri.scheme === 'file') {
            if (normalizeSourcePath(uri.fsPath) === root) rememberDeletedSourceRoot(root);
            queueDeletedSourcePath(uri.fsPath);
          }
        },
        rootDelete: uri => {
          if (!ownsWatcher()) return;
          if (uri.scheme === 'file' && normalizeSourcePath(uri.fsPath) === root) {
            rememberDeletedSourceRoot(root);
            queueDeletedSourcePath(root);
          }
        },
        rootCreate: uri => {
          if (!ownsWatcher()) return;
          if (uri.scheme === 'file' && normalizeSourcePath(uri.fsPath) === root) {
            void recoverRestoredSourceRoot(root, ownsWatcher);
          }
        },
      };
      try {
        let rescanRequested = false;
        let rescanRunning = false;
        const rescanCurrentSource = (baseChanged: boolean): void => {
          if (!ownsWatcher()) return;
          if (baseChanged) {
            // The parent itself moved: the old stream no longer owns this
            // namespace. Close it now and let existing registration retry run.
            const boundary = captureNativeSourceBoundary();
            if (boundary) nativeSourceGaps.set(root, boundary);
            rememberDeletedSourceRoot(root);
            queueDeletedSourcePath(root);
            watcherOwners.delete(root);
            for (const watcher of watchers) watcher.dispose();
            pythonSourceWatchers.delete(root);
            watcherRegistrationIdsForTesting.delete(root);
            watcherCallbacksForTesting.delete(root);
            updatePythonSourceWatcher(workspaceRoot);
            return;
          }
          rescanRequested = true;
          if (rescanRunning) return;
          rescanRunning = true;
          void (async () => {
            try {
              while (rescanRequested && ownsWatcher()) {
                rescanRequested = false;
                if (autoRestartsEnabled) {
                  rememberDeletedSourceRoot(root);
                  await recoverRestoredSourceRoot(root, ownsWatcher);
                } else {
                  queueDeletedSourcePath(root);
                  const files = await pythonFilesBelowDirectory(root, WATCHER_IGNORED_SEGMENTS);
                  if (ownsWatcher()) for (const file of files) queueReindexFile(file);
                }
              }
            } catch (error) {
              if (ownsWatcher()) daemon.logDiagnostic(`[watcher] native source recovery failed: ${String(error)}`);
            } finally {
              rescanRunning = false;
            }
          })();
        };
        const nativeWatcher = createNativeSourceWatcher(root,
          nativeSourceGaps.get(root) ?? nativeSessionBoundary?.boundary ?? initialNativeSourceBoundary,
          WATCHER_IGNORED_SEGMENTS, {
            create: file => callbacks.create(vscode.Uri.file(file)),
            change: file => callbacks.change(vscode.Uri.file(file)),
            delete: file => callbacks.delete(vscode.Uri.file(file)),
            rootCreate: file => callbacks.rootCreate(vscode.Uri.file(file)),
            rootDelete: file => callbacks.rootDelete(vscode.Uri.file(file)),
            rescan: rescanCurrentSource,
          }, error => daemon.logDiagnostic(`[watcher] native source callback failed: ${String(error)}`));
        if (nativeWatcher) {
          watchers.push(nativeWatcher);
        } else {
          const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
          watchers.push(watcher);
          watcher.onDidCreate(callbacks.create);
          watcher.onDidChange(callbacks.change);
          watcher.onDidDelete(callbacks.delete);
          const parent = path.dirname(root);
          if (parent !== root) {
            const rootDeletionWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(parent, '*'), false, true, false);
            watchers.push(rootDeletionWatcher);
            rootDeletionWatcher.onDidCreate(callbacks.rootCreate);
            rootDeletionWatcher.onDidDelete(callbacks.rootDelete);
          }
        }
        nativeSourceGaps.delete(root);
        pythonSourceWatchers.set(root, watchers);
        void recoverRestoredSourceRoot(root, ownsWatcher);
        if (process.env.DJLS_TEST_CAPTURE_LOGS === '1') {
          watcherRegistrationIdsForTesting.set(root, ++nextWatcherRegistrationIdForTesting);
          watcherCallbacksForTesting.set(root, callbacks);
        }
      } catch (error) {
        watcherOwners.delete(root);
        for (const watcher of watchers) watcher.dispose();
        retryRegistration = true;
        output.appendLine(`[watcher] source root registration failed; retrying: ${root}: ${String(error)}`);
      }
    }
    if (retryRegistration) {
      const timer = setTimeout(() => {
        if (sourceWatcherRetryTimer !== timer) return;
        sourceWatcherRetryTimer = undefined;
        updatePythonSourceWatcher(workspaceRoot);
      }, 300);
      sourceWatcherRetryTimer = timer;
    }
    output.appendLine(
      `[watcher] watching source roots: ${nextRoots.join(', ')}`
    );
    requestPhysicalObservation();
  };

  activeDaemon = daemon;
  context.subscriptions.push(registerPythonInterpreterChanges(resource => {
    if (!autoRestartsEnabled) return;
    const state = daemon.getState();
    // Selection readiness never starts a daemon the user has not requested.
    if (!state.workspaceRoot || state.phase === 'stopped') return;
    if (resource) {
      const changedRoot = vscode.workspace.getWorkspaceFolder(resource)?.uri.fsPath;
      const daemonRoot = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(state.workspaceRoot))?.uri.fsPath;
      if (changedRoot && daemonRoot && normalizeSourcePath(changedRoot) !== normalizeSourcePath(daemonRoot)) return;
    }
    void daemon.restartIfInterpreterChanged().catch(error => {
      output.appendLine(`[interpreter] Failed to follow the selected Python environment: ${String(error)}`);
    });
  }, message => output.appendLine(message)));
  const pythonProviderOwner = new PythonInteractiveProviderOwner();
  context.subscriptions.push(pythonProviderOwner);
  context.subscriptions.push(registerPythonProviderReadiness(
    () => pythonProviderOwner.promoteSignatureHelpPriority(),
    message => daemon.logDiagnostic(message)
  ));

  if (!startupSettings.diagnosticsEnabled) {
    output.appendLine(
      '[extension] ORM diagnostics are disabled by configuration; no diagnostic scans will be scheduled.'
    );
  } else if (!isPylanceAvailable()) {
    output.appendLine(
      '[extension] Pylance not detected. ORM diagnostics are disabled to reduce noisy errors and startup cost.'
    );
  }

  daemon.onDidChangeState((snapshot) => {
    publishSurfaceCacheContext();
    statusView.update(snapshot);
    diagnostics.update(snapshot);
    updatePythonSourceWatcher(snapshot.workspaceRoot);
    if (daemon.isReady() && (pendingReindexFiles.size > 0 || pendingDeletedPaths.size > 0 || pendingSourceRoots.size > 0)) {
      if (reindexTimer) {
        clearTimeout(reindexTimer);
      }
      reindexTimer = setTimeout(() => {
        void flushPendingReindexFiles();
      }, 50);
    }
  });
  context.subscriptions.push(daemon.onDidReplaceSurfaceSnapshot(() => {
    publishSurfaceCacheContext();
    surfacePublisher.requestFull();
  }));

  statusView.update(daemon.getState());
  diagnostics.update(daemon.getState());
  let pythonProviderRegistration = vscode.Disposable.from(
    ...registerPythonProviders(daemon, pythonProviderOwner)
  );
  let didPromoteProvidersAfterPylanceActivation = false;
  let lastDaemonReady = daemon.isReady();
  let lastAppliedActivePythonProviderFingerprint: string | undefined;

  const currentActivePythonProviderFingerprint = (): string | undefined => {
    const activeDocument = vscode.window.activeTextEditor?.document;
    if (
      activeDocument?.languageId !== 'python' ||
      activeDocument.uri.scheme !== 'file'
    ) {
      return undefined;
    }
    return activeDocument.uri.toString();
  };

  let lastProviderRegistrationTime = 0;
  const PROVIDER_REGISTRATION_MIN_INTERVAL_MS = 200;
  const PROVIDER_PROMOTE_DEFER_DELAY_MS = 250;
  const PROVIDER_PROMOTE_MAX_DEFERRALS = 40; // ~10s cap, matches diagnostic budget
  let providerPromoteDeferTimer: ReturnType<typeof setTimeout> | undefined;
  let providerPromoteThrottleTimer: ReturnType<typeof setTimeout> | undefined;
  let throttledProviderPromotion: {
    reason: string;
    fingerprint?: string;
    deferredCount: number;
    force: boolean;
  } | undefined;

  const promotePythonProviders = (
    reason: string,
    expectedActivePythonProviderFingerprint?: string,
    deferredCount = 0,
    force = false
  ): void => {
    // Throttle all re-registrations (fingerprinted or not) to avoid
    // disposing in-flight hover/completion requests too aggressively.
    const now = Date.now();
    if (now - lastProviderRegistrationTime < PROVIDER_REGISTRATION_MIN_INTERVAL_MS) {
      // Keep the latest ordering request while preserving the registration floor.
      // A provider registered after the last promotion still needs a later slot.
      throttledProviderPromotion = {
        reason, fingerprint: expectedActivePythonProviderFingerprint, deferredCount, force,
      };
      if (providerPromoteThrottleTimer === undefined) {
        providerPromoteThrottleTimer = setTimeout(() => {
          providerPromoteThrottleTimer = undefined;
          const pending = throttledProviderPromotion;
          throttledProviderPromotion = undefined;
          if (pending) promotePythonProviders(
            pending.reason, pending.fingerprint, pending.deferredCount, pending.force
          );
        }, PROVIDER_REGISTRATION_MIN_INTERVAL_MS - (now - lastProviderRegistrationTime));
      }
      return;
    }

    if (expectedActivePythonProviderFingerprint) {
      const currentFingerprint = currentActivePythonProviderFingerprint();
      if (
        !currentFingerprint ||
        currentFingerprint !== expectedActivePythonProviderFingerprint ||
        lastAppliedActivePythonProviderFingerprint ===
          expectedActivePythonProviderFingerprint
      ) {
        return;
      }
    } else {
      // Preserve lastAppliedActivePythonProviderFingerprint so subsequent
      // tab-switch events for the same file are correctly deduplicated.
    }

    // Priority changes must wait for live interactive responses. The existing
    // diagnostic deferral limit still applies to scans, while interactive
    // handlers release their guard on result, cancellation, timeout or error.
    // While a scan is in flight, ALWAYS defer or coalesce —
    // never fall through to dispose+recreate. The original guard only
    // checked `providerPromoteDeferTimer === undefined`, which let a
    // second promote with a DIFFERENT reason bypass the defer and kill
    // the in-flight scan.
    const interactiveBusy = isAnyInteractiveRequestInFlight();
    if (interactiveBusy || (!force && isAnyDiagnosticScanInFlight()
      && deferredCount < PROVIDER_PROMOTE_MAX_DEFERRALS)) {
      const work = interactiveBusy ? 'interactive requests' : 'diagnostic scan';
      if (providerPromoteDeferTimer !== undefined) {
        daemon.logDiagnostic(
          `[extension] Coalesced Python provider promotion (${reason}) — ${work} in flight; another defer is already pending.`
        );
        return;
      }
      daemon.logDiagnostic(
        `[extension] Deferred Python provider promotion (${reason}) — ${work} in flight (defer ${deferredCount + 1}/${PROVIDER_PROMOTE_MAX_DEFERRALS}).`
      );
      providerPromoteDeferTimer = setTimeout(() => {
        providerPromoteDeferTimer = undefined;
        promotePythonProviders(
          reason,
          expectedActivePythonProviderFingerprint,
          deferredCount + 1,
          force
        );
      }, PROVIDER_PROMOTE_DEFER_DELAY_MS);
      return;
    }

    // Queue the replacement before removing the current providers. The
    // workbench applies these registrations asynchronously; unregistering
    // first can leave an interleaved completion without a provider. Hover
    // keeps its API adapter alive, including requests not dispatched yet.
    // A failed replacement also leaves the current registration available.
    const nextPythonProviderRegistration = vscode.Disposable.from(
      ...registerPythonProviders(daemon, pythonProviderOwner)
    );
    // Generic delegate refreshes must not consume the one extra signature
    // registration before the selected Python language service finishes its
    // initial provider registration.

    if (expectedActivePythonProviderFingerprint) {
      lastAppliedActivePythonProviderFingerprint =
        expectedActivePythonProviderFingerprint;
    }

    lastProviderRegistrationTime = Date.now();
    const previousPythonProviderRegistration = pythonProviderRegistration;
    pythonProviderRegistration = nextPythonProviderRegistration;
    previousPythonProviderRegistration.dispose();
    const priorityRefresh = pythonProviderOwner.refreshSignatureHelpPriority();
    const reportPromotion = (): void => daemon.logDiagnostic(
      `[extension] Re-registered Python providers (${reason}) to prioritize Django ORM hover/completion.`
    );
    if (priorityRefresh) void priorityRefresh.then(reportPromotion, reportPromotion);
    else reportPromotion();
  };

  promotePythonProvidersImpl = (reason: string): void => {
    promotePythonProviders(reason);
  };

  const schedulePythonProviderPromotion = (
    reason: string,
    delayMs = 75,
    expectedActivePythonProviderFingerprint?: string,
    force = false
  ): void => {
    const timer = setTimeout(() => {
      providerPromotionTimers.delete(timer);
      promotePythonProviders(
        reason,
        expectedActivePythonProviderFingerprint,
        0,
        force
      );
    }, delayMs);
    providerPromotionTimers.add(timer);
  };

  const clearProviderPromotionTimers = (): void => {
    for (const timer of providerPromotionTimers) {
      clearTimeout(timer);
    }
    providerPromotionTimers.clear();
    if (providerPromoteThrottleTimer !== undefined) {
      clearTimeout(providerPromoteThrottleTimer);
      providerPromoteThrottleTimer = undefined;
    }
    throttledProviderPromotion = undefined;
    if (providerPromoteDeferTimer !== undefined) {
      clearTimeout(providerPromoteDeferTimer);
      providerPromoteDeferTimer = undefined;
    }
  };

  const schedulePythonProviderPromotionBurst = (
    reason: string,
    delayMsList: number[],
    expectedActivePythonProviderFingerprint?: string,
    force = false
  ): void => {
    clearProviderPromotionTimers();
    for (const delayMs of delayMsList) {
      schedulePythonProviderPromotion(
        reason,
        delayMs,
        expectedActivePythonProviderFingerprint,
        force
      );
    }
  };

  context.subscriptions.push(
    output,
    daemon,
    statusView,
    diagnostics,
    registerShowStatusCommand(daemon, output),
    registerRestartDaemonCommand(daemon),
    registerClearCacheAndReindexCommand(daemon, output),
    registerConfigurePylanceDiagnosticsCommand(output),
    registerSelectSettingsModuleCommand(daemon, output),
    registerSelectPythonInterpreterCommand(daemon, output),
    new vscode.Disposable(() => {
      pythonProviderRegistration.dispose();
    }),
    new vscode.Disposable(() => {
      clearProviderPromotionTimers();
      pendingSourceEventsForTesting = undefined;
      sourceBatchPublicationsForTesting = undefined;
      sourceWatcherStateForTesting = undefined;
      captureSourceWatcherCallbacksForTesting = undefined;
      startLanguageClientForTestingImpl = undefined;
      enableAutoRestartsForTestingImpl = undefined;
      sourceWatchersDisposed = true;
      deletedSourceRoots.clear();
      languageServerLifecycle?.deactivate();
      cacheContextDelivery.dispose();
      surfacePublisher.dispose();
      if (reindexTimer) {
        clearTimeout(reindexTimer);
      }
      disposePythonSourceWatcher();
    }),
    vscode.workspace.onDidSaveTextDocument(document => {
      // Watchers may still be attaching, and LSP save delivery requires a
      // running client. The IDE save itself is an owned source event.
      if (sourceWatchersDisposed || !watchedWorkspaceRoot
        || document.uri.scheme !== 'file' || document.languageId !== 'python') return;
      queueReindexFile(document.uri.fsPath);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!autoRestartsEnabled) {
        return;
      }
      if (!isRelevantConfigurationChange(event)) {
        return;
      }
      if (!event.affectsConfiguration('djangoOrmIntellisense')) {
        // Following Python's default selection preserves lazy startup when
        // no ORM request has started this workspace yet.
        void daemon.restartIfInterpreterChanged().catch(error => {
          output.appendLine(`[interpreter] Failed to follow Python configuration: ${String(error)}`);
        });
        return;
      }

      output.appendLine(
        '[extension] Configuration changed. Restarting analysis daemon.'
      );
      const nextSettings = getExtensionSettings();
      if (nextSettings.autoStart) {
        ensureLanguageClientStarted();
      }
      schedulePythonProviderPromotionBurst('configuration-changed', [
        0,
        250,
      ], undefined, true);
      // Restart at the active document's scope so createLaunchContext reads the
      // settings of the project the user is working in, rather than always
      // re-deriving from workspaceFolders[0] (which made per-folder/per-project
      // settings appear ignored after any config change).
      const restartScope = vscode.window.activeTextEditor?.document.uri;
      void daemon.restart(restartScope).catch((error) => {
        output.appendLine(`[extension] Failed to restart daemon: ${String(error)}`);
      });
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (!autoRestartsEnabled) {
        return;
      }
      output.appendLine('[extension] Workspace folders changed. Restarting analysis daemon.');
      void daemon.restart().catch((error) => {
        output.appendLine(`[extension] Failed to restart daemon: ${String(error)}`);
      });
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document.languageId !== 'python') {
        return;
      }
      // Only promote on the very first Python tab activation; subsequent tab
      // switches reuse the already-registered providers so hover results are
      // preserved and don't flicker back to "Loading…".
      if (lastAppliedActivePythonProviderFingerprint !== undefined) {
        return;
      }
      // If daemon-ready already registered providers, skip the burst to avoid
      // disposing in-flight hover/completion requests.
      if (lastDaemonReady) {
        return;
      }
      const activePythonProviderFingerprint = editor.document.uri.toString();
      schedulePythonProviderPromotionBurst('active-python-editor', [
        0,
        150,
        750,
      ], activePythonProviderFingerprint);
    })
  );

  const pylanceExtension = vscode.extensions.getExtension(PYLANCE_EXTENSION_ID);
  if (pylanceExtension) {
    if (pylanceExtension.isActive) {
      didPromoteProvidersAfterPylanceActivation = true;
      schedulePythonProviderPromotionBurst('pylance-already-active', [
        0,
        250,
      ]);
    }
    context.subscriptions.push(
      vscode.extensions.onDidChange(() => {
        if (didPromoteProvidersAfterPylanceActivation) {
          return;
        }
        if (!vscode.extensions.getExtension(PYLANCE_EXTENSION_ID)?.isActive) {
          return;
        }
        didPromoteProvidersAfterPylanceActivation = true;
        schedulePythonProviderPromotionBurst('pylance-activated', [
          0,
          250,
        ]);
      })
    );
  }
  if (startupSettings.pylanceAutoApplyStubOverrides) {
    void applyStubOverrides(output).catch((error) => {
      output.appendLine(
        `[pylance] Failed to apply Django stub overrides: ${String(error)}`
      );
    });
  }

  void normalizePythonInterpreterSettings()
    .then((normalization) => {
      if (normalization === 'migrated') {
        output.appendLine(
          '[interpreter] Migrated legacy djangoOrmIntellisense.pythonPath into djangoOrmIntellisense.pythonInterpreter.'
        );
      } else if (normalization === 'cleared') {
        output.appendLine(
          '[interpreter] Removed legacy djangoOrmIntellisense.pythonPath because djangoOrmIntellisense.pythonInterpreter is already set.'
        );
      }
    })
    .catch((error) => {
      output.appendLine(
        `[interpreter] Failed to normalize legacy interpreter settings: ${String(error)}`
      );
    });

  const ensureLanguageClientStarted = (): void => {
    if (languageClient) {
      return;
    }

    const serverModule = context.asAbsolutePath(
      path.join('out', 'server', 'server.js')
    );
    const clientOptions: LanguageClientOptions = {
      documentSelector: [{ scheme: 'file', language: 'python' }],
      outputChannel: output,
    };
    const owned = createOwnedLanguageClient(
      'djangoOrmLs',
      'Django ORM Language Server',
      serverModule,
      clientOptions,
      () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      error => output.appendLine(`[ls] lifecycle: ${String(error)}`),
    );
    languageClient = owned.client;
    languageServerLifecycle = owned.lifecycle;
    context.subscriptions.push(languageClient);
    context.subscriptions.push(languageClient.onDidChangeState(event => {
      if (event.newState === State.Running) {
        languageServerSession++;
        publishSurfaceCacheContext();
        surfacePublisher.requestFull();
      }
    }));
    context.subscriptions.push(languageClient.onNotification('django/fileNeedsReindex', (params: { uri: string }) => {
      const uri = params?.uri;
      if (!uri) return;
      try { queueReindexFile(vscode.Uri.parse(uri).fsPath); } catch { queueReindexFile(uri); }
    }));
    void languageClient.start().then(() => {
      output.appendLine('[ls] Language Server started');
      publishSurfaceCacheContext();
      schedulePythonProviderPromotionBurst('language-client-started', [
        0,
        250,
      ]);
      surfacePublisher.requestFull();
    }).catch(error => output.appendLine(`[ls] Initial Language Server start failed; current demand will retry: ${String(error)}`));
  };

  const settings = getExtensionSettings();
  startLanguageClientForTestingImpl = ensureLanguageClientStarted;
  const initialEditor = vscode.window.activeTextEditor;
  if (settings.autoStart) {
    ensureLanguageClientStarted();
  }
  if (
    initialEditor?.document.languageId === 'python' &&
    settings.autoStart
  ) {
    schedulePythonProviderPromotionBurst('initial-python-editor', [
      75,
      350,
      1200,
    ]);
  }
  if (settings.autoStart && initialEditor?.document.languageId === 'python') {
    void daemon.start(initialEditor.document.uri).catch((error) => {
      output.appendLine(`[extension] Failed to start daemon: ${String(error)}`);
    });
  }

  daemon.onDidChangeState(() => {
    const isReady = daemon.isReady();
    if (isReady && !lastDaemonReady) {
      schedulePythonProviderPromotion('daemon-ready', 75);
    }
    lastDaemonReady = isReady;
  });
}

function mergeReindexDelta(
  result: ReindexFileResult,
  surfaceIndexDelta: Record<string, unknown>,
  surfaceFingerprints: Record<string, string>,
  addedLabels: Set<string>,
  changedLabels: Set<string>,
  removedLabels: Set<string>,
): void {
  const delta = result.surfaceIndexDelta ?? {};
  for (const [label, value] of Object.entries(delta)) {
    surfaceIndexDelta[label] = value;
  }
  for (const [label, fingerprint] of Object.entries(result.surfaceFingerprints ?? {})) {
    surfaceFingerprints[label] = fingerprint;
  }
  for (const label of result.removedLabels ?? []) {
    removedLabels.add(label);
    addedLabels.delete(label);
    changedLabels.delete(label);
    delete surfaceIndexDelta[label];
    delete surfaceFingerprints[label];
  }
  for (const label of result.addedLabels ?? []) {
    removedLabels.delete(label);
    changedLabels.delete(label);
    addedLabels.add(label);
  }
  for (const label of result.changedLabels ?? []) {
    if (addedLabels.has(label)) {
      continue;
    }
    removedLabels.delete(label);
    changedLabels.add(label);
  }
}

export async function deactivate(): Promise<void> {
  languageServerLifecycle?.deactivate();
  if (languageClient) {
    await languageClient.stop();
    languageClient = undefined;
  }
  languageServerLifecycle = undefined;
  if (!activeDaemon) {
    return;
  }

  await activeDaemon.stop();
  activeDaemon = undefined;
}
