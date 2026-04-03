import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';
import * as vscode from 'vscode';
import { getExtensionSettings } from '../config/settings';
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
  RelationTargetResolution,
  RelationTargetsResult,
  RequestMessage,
  ResponseMessage,
} from '../protocol';

const REQUEST_TIMEOUT_MS = 8_000;

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

function mergePythonPath(extensionPythonRoot: string): string {
  const segments = [extensionPythonRoot];

  if (process.env.PYTHONPATH) {
    segments.push(process.env.PYTHONPATH);
  }

  return segments.join(path.delimiter);
}

export class AnalysisDaemon implements vscode.Disposable {
  private readonly stateEmitter = new vscode.EventEmitter<HealthSnapshot>();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly intentionalExitProcessIds = new Set<number>();
  private readonly output: vscode.OutputChannel;
  private process?: ChildProcessWithoutNullStreams;
  private stdoutReader?: readline.Interface;
  private requestSequence = 0;
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

  async start(): Promise<HealthSnapshot> {
    if (this.process) {
      return this.refreshHealth();
    }

    const launchContext = await this.createLaunchContext();
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
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      DJANGO_ORM_INTELLISENSE: '1',
      PYTHONPATH: mergePythonPath(serverModuleRoot),
      PYTHONUNBUFFERED: '1',
    };

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
      this.rejectAllPending(error);
      this.disposeProcessHandles(child, stdoutReader);
      this.updateStateFromError(error);
    });

    child.once('exit', (code, signal) => {
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
      const initializeResult = await this.request<InitializeResult>('initialize', {
        workspaceRoot: launchContext.workspaceRoot,
        settingsModule: launchContext.settingsModule,
      });
      const snapshot = this.decorateSnapshot(initializeResult.health);
      this.updateState(snapshot);
      return snapshot;
    } catch (error) {
      this.updateStateFromError(error);
      throw error;
    }
  }

  async refreshHealth(): Promise<HealthSnapshot> {
    if (!this.process) {
      return this.currentState;
    }

    const snapshot = this.decorateSnapshot(
      await this.request<HealthSnapshot>('health', {})
    );
    this.updateState(snapshot);
    return snapshot;
  }

  async ensureStarted(): Promise<void> {
    if (!this.process) {
      await this.start();
    }
  }

  async restart(): Promise<HealthSnapshot> {
    await this.stop();
    return this.start();
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
    return this.request<RelationTargetsResult>('relationTargets', { prefix });
  }

  async resolveRelationTarget(
    value: string
  ): Promise<RelationTargetResolution> {
    return this.request<RelationTargetResolution>('resolveRelationTarget', {
      value,
    });
  }

  async resolveExportOrigin(
    moduleName: string,
    symbol: string
  ): Promise<ExportOriginResolution> {
    return this.request<ExportOriginResolution>('resolveExportOrigin', {
      module: moduleName,
      symbol,
    });
  }

  async listLookupPathCompletions(
    baseModelLabel: string,
    prefix: string,
    method: string
  ): Promise<LookupPathCompletionsResult> {
    return this.request<LookupPathCompletionsResult>('lookupPathCompletions', {
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
    return this.request<LookupPathResolution>('resolveLookupPath', {
      baseModelLabel,
      value,
      method,
    });
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
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

  private async createLaunchContext(): Promise<LaunchContext> {
    const settings = getExtensionSettings();
    const workspaceRoot =
      settings.workspaceRoot ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      this.context.extensionPath;
    const interpreter = await resolvePythonInterpreter(settings);
    const validation = validatePythonInterpreterPath(interpreter.path);

    if (!validation.valid) {
      throw new Error(
        `${validation.reason}. Set \`djangoOrmIntellisense.pythonInterpreter\` to the actual Python executable, or clear it so the extension can follow the Python extension selected interpreter.`
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
    params: Record<string, unknown>
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
      }, REQUEST_TIMEOUT_MS);

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

  private handleServerMessage(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    this.log('debug', `[daemon->client] ${trimmed}`);

    let response: ResponseMessage;

    try {
      response = JSON.parse(trimmed) as ResponseMessage;
    } catch (error) {
      this.log(
        'info',
        `Failed to parse daemon response: ${error instanceof Error ? error.message : String(error)}`
      );
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
}
