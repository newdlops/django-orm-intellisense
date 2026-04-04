import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as vscode from 'vscode';
import { getExtensionSettings } from '../config/settings';
import { syncManagedPylanceStubPath } from '../pylance/stubPath';
import {
  resolvePythonInterpreter,
  validatePythonInterpreterPath,
} from '../python/interpreter';
import type {
  ExportOriginResolution,
  HealthSnapshot,
  InitializeResult,
  LookupPathCompletionsResult,
  LookupPathResolution,
  ModuleResolution,
  OrmMemberCompletionsResult,
  OrmMemberResolution,
  OrmReceiverKind,
  RelationTargetResolution,
  RelationTargetsResult,
  RequestMessage,
  ResponseMessage,
} from '../protocol';

const REQUEST_TIMEOUT_MS = 8_000;
const INITIALIZE_REQUEST_TIMEOUT_MS = 60_000;
const RESPONSE_CACHE_LIMIT = 512;

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface LaunchContext {
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

export class AnalysisDaemon implements vscode.Disposable {
  private readonly stateEmitter = new vscode.EventEmitter<HealthSnapshot>();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly responseCache = new Map<string, Promise<unknown>>();
  private readonly intentionalExitProcessIds = new Set<number>();
  private readonly output: vscode.OutputChannel;
  private process?: ChildProcessWithoutNullStreams;
  private stdoutReader?: readline.Interface;
  private requestSequence = 0;
  private startPromise?: Promise<HealthSnapshot>;
  private restartPromise?: Promise<HealthSnapshot>;
  private restartQueued = false;
  private queuedRestartScope?: vscode.ConfigurationScope;
  private stopRequested = false;
  private lastLaunchContext?: LaunchContext;
  private interpreterCheck?: Promise<void>;
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

  getState(): HealthSnapshot {
    return this.currentState;
  }

  async start(scope?: vscode.ConfigurationScope): Promise<HealthSnapshot> {
    if (this.startPromise) {
      return this.startPromise;
    }

    if (this.process) {
      return this.refreshHealth();
    }

    const startPromise = this.startProcess(scope);
    this.startPromise = startPromise;

    try {
      return await startPromise;
    } finally {
      if (this.startPromise === startPromise) {
        this.startPromise = undefined;
      }
    }
  }

  async refreshHealth(): Promise<HealthSnapshot> {
    if (this.startPromise) {
      return this.startPromise;
    }

    if (!this.process) {
      return this.currentState;
    }

    const snapshot = this.decorateSnapshot(
      await this.request<HealthSnapshot>('health', {})
    );
    await this.applyWorkspaceIntegrations(snapshot);
    this.updateState(snapshot);
    return snapshot;
  }

  async ensureStarted(scope?: vscode.ConfigurationScope): Promise<void> {
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

    await this.restartIfInterpreterChanged();
  }

  async restart(scope?: vscode.ConfigurationScope): Promise<HealthSnapshot> {
    if (this.restartPromise) {
      this.restartQueued = true;
      if (scope !== undefined) {
        this.queuedRestartScope = scope;
      }
      return this.restartPromise;
    }

    const restartPromise = (async () => {
      let nextScope = scope;
      let lastSnapshot: HealthSnapshot | undefined;
      let lastError: unknown;

      while (true) {
        this.restartQueued = false;
        const restartScope = nextScope;
        nextScope = undefined;

        await this.stop();
        if (this.startPromise) {
          try {
            await this.startPromise;
          } catch {
            // Ignore the terminated start attempt and continue with the queued restart.
          }
        }

        try {
          lastSnapshot = await this.start(restartScope);
          lastError = undefined;
        } catch (error) {
          lastSnapshot = undefined;
          lastError = error;
        }

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

  async restartIfInterpreterChanged(): Promise<void> {
    if (!this.process || this.currentState.phase === 'starting') {
      return;
    }

    if (this.interpreterCheck) {
      await this.interpreterCheck;
      return;
    }

    this.interpreterCheck = this.checkForInterpreterChange();

    try {
      await this.interpreterCheck;
    } finally {
      this.interpreterCheck = undefined;
    }
  }

  async listRelationTargets(prefix: string): Promise<RelationTargetsResult> {
    return this.cachedRequest<RelationTargetsResult>('relationTargets', { prefix });
  }

  async resolveRelationTarget(
    value: string
  ): Promise<RelationTargetResolution> {
    return this.cachedRequest<RelationTargetResolution>('resolveRelationTarget', {
      value,
    });
  }

  async resolveExportOrigin(
    moduleName: string,
    symbol: string
  ): Promise<ExportOriginResolution> {
    return this.cachedRequest<ExportOriginResolution>('resolveExportOrigin', {
      module: moduleName,
      symbol,
    });
  }

  async resolveModule(moduleName: string): Promise<ModuleResolution> {
    return this.cachedRequest<ModuleResolution>('resolveModule', {
      module: moduleName,
    });
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

  async resolveLookupPath(
    baseModelLabel: string,
    value: string,
    method: string
  ): Promise<LookupPathResolution> {
    return this.cachedRequest<LookupPathResolution>('resolveLookupPath', {
      baseModelLabel,
      value,
      method,
    });
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

  async resolveOrmMember(
    modelLabel: string,
    receiverKind: OrmReceiverKind,
    name: string,
    managerName?: string
  ): Promise<OrmMemberResolution> {
    return this.cachedRequest<OrmMemberResolution>('resolveOrmMember', {
      modelLabel,
      receiverKind,
      name,
      managerName,
    });
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.clearResponseCache();
    this.rejectAllPending(new Error('Analysis daemon stopped.'));

    const child = this.process;
    const stdoutReader = this.stdoutReader;

    if (child?.pid !== undefined) {
      this.intentionalExitProcessIds.add(child.pid);
    }

    this.disposeProcessHandles(child, stdoutReader);

    if (child && !child.killed) {
      child.kill();
    }

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
  }

  private async startProcess(
    scope?: vscode.ConfigurationScope
  ): Promise<HealthSnapshot> {
    this.clearResponseCache();
    const launchContext = await this.createLaunchContext(scope);
    this.lastLaunchContext = launchContext;
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

    const serverModuleRoot = path.join(this.context.extensionPath, 'python');
    const environment = buildPythonEnvironment(
      serverModuleRoot,
      launchContext.pythonPath
    );

    if (launchContext.settingsModule) {
      environment.DJANGO_SETTINGS_MODULE = launchContext.settingsModule;
    }

    const child = spawn(
      launchContext.pythonPath,
      ['-m', 'django_orm_intellisense', '--stdio', '--workspace', launchContext.workspaceRoot],
      {
        cwd: launchContext.workspaceRoot,
        env: environment,
      }
    );

    this.process = child;
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
      this.updateStateFromError(error);
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
      this.handleServerMessage(line);
    });

    try {
      const initializeResult = await this.request<InitializeResult>(
        'initialize',
        {
          workspaceRoot: launchContext.workspaceRoot,
          settingsModule: launchContext.settingsModule,
        },
        INITIALIZE_REQUEST_TIMEOUT_MS
      );
      const snapshot = this.decorateSnapshot(initializeResult.health);
      await this.applyWorkspaceIntegrations(snapshot);
      this.updateState(snapshot);
      return snapshot;
    } catch (error) {
      if (child.pid !== undefined) {
        this.intentionalExitProcessIds.add(child.pid);
      }
      this.disposeProcessHandles(child, stdoutReader);
      if (!child.killed) {
        child.kill();
      }
      this.updateStateFromError(error);
      throw error;
    }
  }

  private async createLaunchContext(
    scope?: vscode.ConfigurationScope
  ): Promise<LaunchContext> {
    const settings = getExtensionSettings(
      scope ?? vscode.workspace.workspaceFolders?.[0]?.uri
    );
    const configuredWorkspaceRoot = settings.workspaceRoot
      ? path.resolve(settings.workspaceRoot)
      : undefined;
    const workspaceRoot =
      (configuredWorkspaceRoot && pathExists(configuredWorkspaceRoot)
        ? configuredWorkspaceRoot
        : undefined) ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      this.context.extensionPath;
    const interpreter = await resolvePythonInterpreter(settings);
    const validation = validatePythonInterpreterPath(interpreter.path);

    if (!validation.valid) {
      throw new Error(
        `${validation.reason}. Set \`djangoOrmIntellisense.pythonInterpreter\` to a valid Python executable or virtualenv directory.`
      );
    }

    return {
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
    timeoutMs: number = REQUEST_TIMEOUT_MS
  ): Promise<T> {
    if (!this.process || !this.process.stdin.writable) {
      return Promise.reject(new Error('Analysis daemon is not running.'));
    }

    const id = `req-${++this.requestSequence}`;
    const message: RequestMessage = { id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request "${method}" timed out.`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve,
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
    params: Record<string, unknown>
  ): Promise<T> {
    const cacheKey = JSON.stringify({ method, params });
    const cached = this.responseCache.get(cacheKey);
    if (cached) {
      return cached as Promise<T>;
    }

    const requestPromise = this.request<T>(method, params);
    this.responseCache.set(cacheKey, requestPromise);
    this.evictOldestCachedResponse();
    requestPromise.catch(() => {
      if (this.responseCache.get(cacheKey) === requestPromise) {
        this.responseCache.delete(cacheKey);
      }
    });
    return requestPromise;
  }

  private handleServerMessage(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    this.log('debug', `[daemon->client] ${trimmed}`);

    const response = this.parseServerResponse(trimmed);
    if (!response) {
      return;
    }

    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(response.id);
    clearTimeout(pending.timeout);

    if (response.error) {
      pending.reject(new Error(response.error.message));
      return;
    }

    pending.resolve(response.result);
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
      this.process = undefined;
    }

    if (!targetReader || this.stdoutReader === targetReader) {
      this.stdoutReader = undefined;
    }
  }

  private updateState(snapshot: HealthSnapshot): void {
    this.currentState = snapshot;
    this.stateEmitter.fire(snapshot);
  }

  private decorateSnapshot(snapshot: HealthSnapshot): HealthSnapshot {
    return {
      ...snapshot,
      workspaceRoot: snapshot.workspaceRoot ?? this.lastLaunchContext?.workspaceRoot,
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

  private async applyWorkspaceIntegrations(
    snapshot: HealthSnapshot
  ): Promise<void> {
    try {
      await syncManagedPylanceStubPath(snapshot, this.output);
    } catch (error) {
      this.log(
        'info',
        `[extension] Failed to sync managed Pylance stubPath: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async checkForInterpreterChange(): Promise<void> {
    if (!this.lastLaunchContext) {
      return;
    }

    const nextLaunchContext = await this.createLaunchContext();
    if (nextLaunchContext.pythonPath === this.lastLaunchContext.pythonPath) {
      return;
    }

    this.log(
      'info',
      `Detected Python interpreter change (${this.lastLaunchContext.pythonPath} -> ${nextLaunchContext.pythonPath}). Restarting analysis daemon.`
    );
    await this.restart();
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
      (nextLaunchContext.settingsModule ?? '') !==
        (this.lastLaunchContext.settingsModule ?? '')
    );
  }

  private log(level: 'info' | 'debug', message: string): void {
    const settings = getExtensionSettings();
    if (settings.logLevel === 'off') {
      return;
    }

    if (level === 'debug' && settings.logLevel !== 'debug') {
      return;
    }

    this.output.appendLine(message);
  }

  private clearResponseCache(): void {
    this.responseCache.clear();
  }

  private evictOldestCachedResponse(): void {
    while (this.responseCache.size > RESPONSE_CACHE_LIMIT) {
      const oldestKey = this.responseCache.keys().next().value;
      if (!oldestKey) {
        return;
      }
      this.responseCache.delete(oldestKey);
    }
  }

  private parseServerResponse(line: string): ResponseMessage | undefined {
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
      return JSON.parse(candidate) as ResponseMessage;
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
