import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';
import * as vscode from 'vscode';
import { getExtensionSettings } from '../config/settings';
import type {
  HealthSnapshot,
  InitializeResult,
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
  private readonly output: vscode.OutputChannel;
  private process?: ChildProcessWithoutNullStreams;
  private stdoutReader?: readline.Interface;
  private requestSequence = 0;
  private stopRequested = false;
  private lastLaunchContext?: LaunchContext;
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

    const launchContext = this.createLaunchContext();
    this.lastLaunchContext = launchContext;
    this.stopRequested = false;
    this.updateState({
      phase: 'starting',
      detail: `Starting analysis daemon with ${launchContext.pythonPath}.`,
      capabilities: [],
      workspaceRoot: launchContext.workspaceRoot,
      pythonPath: launchContext.pythonPath,
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
    this.stdoutReader = readline.createInterface({ input: child.stdout });

    child.once('spawn', () => {
      this.log('info', `Daemon process spawned with pid ${child.pid ?? 'unknown'}.`);
    });

    child.once('error', (error) => {
      this.log('info', `Daemon failed to spawn: ${error.message}`);
      this.rejectAllPending(error);
      this.disposeProcessHandles();
      this.updateStateFromError(error);
    });

    child.once('exit', (code, signal) => {
      const unexpected = !this.stopRequested;
      this.log(
        'info',
        `Daemon exited with code ${code ?? 'null'} and signal ${signal ?? 'null'}.`
      );
      this.rejectAllPending(
        new Error(
          unexpected
            ? `Analysis daemon exited unexpectedly (${code ?? 'null'}/${signal ?? 'null'}).`
            : 'Analysis daemon stopped.'
        )
      );
      this.disposeProcessHandles();

      if (unexpected) {
        this.updateState({
          phase: 'error',
          detail: 'Analysis daemon exited unexpectedly.',
          capabilities: this.currentState.capabilities,
          workspaceRoot: this.lastLaunchContext?.workspaceRoot,
          pythonPath: this.lastLaunchContext?.pythonPath,
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

    this.stdoutReader.on('line', (line) => {
      this.handleServerMessage(line);
    });

    try {
      const initializeResult = await this.request<InitializeResult>('initialize', {
        workspaceRoot: launchContext.workspaceRoot,
        settingsModule: launchContext.settingsModule,
      });
      this.updateState(initializeResult.health);
      return initializeResult.health;
    } catch (error) {
      this.updateStateFromError(error);
      throw error;
    }
  }

  async refreshHealth(): Promise<HealthSnapshot> {
    if (!this.process) {
      return this.currentState;
    }

    const snapshot = await this.request<HealthSnapshot>('health', {});
    this.updateState(snapshot);
    return snapshot;
  }

  async restart(): Promise<HealthSnapshot> {
    await this.stop();
    return this.start();
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.rejectAllPending(new Error('Analysis daemon stopped.'));

    const child = this.process;
    this.disposeProcessHandles();

    if (child && !child.killed) {
      child.kill();
    }

    this.updateState({
      phase: 'stopped',
      detail: 'Daemon is stopped.',
      capabilities: this.currentState.capabilities,
      workspaceRoot: this.lastLaunchContext?.workspaceRoot,
      pythonPath: this.lastLaunchContext?.pythonPath,
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

  private createLaunchContext(): LaunchContext {
    const settings = getExtensionSettings();
    const workspaceRoot =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.context.extensionPath;

    return {
      workspaceRoot,
      pythonPath: settings.pythonPath ?? 'python3',
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

  private disposeProcessHandles(): void {
    this.stdoutReader?.removeAllListeners();
    this.stdoutReader?.close();
    this.stdoutReader = undefined;
    this.process = undefined;
  }

  private updateState(snapshot: HealthSnapshot): void {
    this.currentState = snapshot;
    this.stateEmitter.fire(snapshot);
  }

  private updateStateFromError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.updateState({
      phase: 'error',
      detail: message,
      capabilities: this.currentState.capabilities,
      workspaceRoot: this.lastLaunchContext?.workspaceRoot,
      pythonPath: this.lastLaunchContext?.pythonPath,
      settingsModule: this.lastLaunchContext?.settingsModule,
      staticIndex: this.currentState.staticIndex,
      runtime: this.currentState.runtime,
      semanticGraph: this.currentState.semanticGraph,
      startedAt: this.currentState.startedAt,
    });
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
