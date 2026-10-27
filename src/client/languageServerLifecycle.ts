import { fork } from 'node:child_process';
import { setImmediate as nextTurn } from 'node:timers/promises';
import {
  Emitter, ErrorCodes, IPCMessageReader, IPCMessageWriter,
  type DataCallback, type Message, type MessageReader, type MessageWriter, type ResponseMessage,
} from 'vscode-jsonrpc/node';
import type { LanguageClient, LanguageClientOptions, MessageTransports } from 'vscode-languageclient/node';

export interface OwnedServerTransport extends MessageTransports {
  invalidate(startSettled?: Promise<unknown>): void;
  retire(startSettled?: Promise<unknown>): Promise<void>;
}

interface LifecycleOptions {
  open(onFault: (error: unknown) => void): OwnedServerTransport;
  start(): Promise<void>;
  stop(timeoutMs: number): Promise<void>;
  isRunning(): boolean;
  report(error: unknown): void;
  initializeTimeoutMs?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
}

/** One owned process, one startup attempt, and one retry for current demand. */
export class LanguageServerLifecycle {
  private transport?: OwnedServerTransport;
  private sdkStart?: Promise<void>;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private abortStart?: AbortController;
  private retry?: ReturnType<typeof setTimeout>;
  private wanted = false;
  private disposed = false;
  private failures = 0;
  private revision = 0;

  constructor(private readonly options: LifecycleOptions) {}

  open(): OwnedServerTransport {
    if (!this.wanted || this.disposed || this.transport || !this.abortStart || this.abortStart.signal.aborted) {
      throw new Error('Language server transport has no active owner.');
    }
    const transport = this.options.open(error => {
      queueMicrotask(() => {
        if (this.transport !== transport || !this.wanted || this.disposed) return;
        transport.invalidate(this.sdkStart);
        if (!this.starting) void this.recover().catch(() => {});
        this.options.report(error);
      });
    });
    this.transport = transport;
    return transport;
  }

  start(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Language server lifecycle is disposed.'));
    this.wanted = true;
    this.clearRetry();
    if (this.stopping) {
      const revision = this.revision;
      return this.stopping.then(() => {
        if (revision !== this.revision || !this.wanted) throw new Error('Language server startup was cancelled.');
        return this.start();
      });
    }
    if (this.starting) return this.starting;
    if (this.options.isRunning()) return Promise.resolve();
    const task = this.startAttempt();
    this.starting = task;
    void task.then(() => {
      if (this.starting === task) this.starting = undefined;
      this.failures = 0;
    }, error => {
      if (this.starting === task) this.starting = undefined;
      if (this.wanted && !this.disposed) {
        this.options.report(error);
        this.failures++;
        this.scheduleRetry();
      }
    });
    return task;
  }

  stop(timeoutMs = 2000): Promise<void> {
    this.revision++;
    this.wanted = false;
    this.clearRetry();
    return this.stopAttempt(timeoutMs);
  }

  deactivate(): void {
    this.revision++;
    this.disposed = true;
    this.wanted = false;
    this.clearRetry();
    this.abortStart?.abort();
    void this.stopAttempt(2000).catch(error => this.options.report(error));
  }

  private async startAttempt(): Promise<void> {
    const revision = this.revision;
    await this.retireTransport();
    if (revision !== this.revision || !this.wanted || this.disposed) throw new Error('Language server startup was cancelled.');
    const abort = new AbortController();
    this.abortStart = abort;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort!: () => void;
    const deadline = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('Language server startup was cancelled.'));
      abort.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        this.transport?.invalidate(this.sdkStart);
        reject(new Error('Language server initialization timed out.'));
      }, this.options.initializeTimeoutMs ?? 10_000);
    });
    try {
      this.sdkStart = this.options.start();
      await Promise.race([this.sdkStart, deadline]);
      if (revision !== this.revision || !this.wanted || this.disposed) throw new Error('Language server startup was cancelled.');
    } catch (error) {
      await this.retireTransport();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      abort.signal.removeEventListener('abort', onAbort);
      if (this.abortStart === abort) this.abortStart = undefined;
      this.sdkStart = undefined;
    }
  }

  private stopAttempt(timeoutMs: number): Promise<void> {
    if (this.stopping) return this.stopping;
    const task = (async () => {
      const starting = this.starting;
      if (starting) {
        this.abortStart?.abort();
        this.transport?.invalidate(this.sdkStart);
        await starting.catch(() => {});
      }
      try {
        if (this.options.isRunning()) await this.options.stop(timeoutMs);
      } catch (error) {
        this.options.report(error);
      } finally {
        await this.retireTransport();
      }
    })();
    this.stopping = task;
    void task.then(() => { if (this.stopping === task) this.stopping = undefined; }, () => {
      if (this.stopping === task) this.stopping = undefined;
    });
    return task;
  }

  private async recover(): Promise<void> {
    try {
      await this.stopAttempt(2000);
      if (this.wanted && !this.disposed) await this.start();
    } catch (error) {
      if (this.wanted && !this.disposed) { this.failures++; this.scheduleRetry(); }
      throw error;
    }
  }

  private async retireTransport(): Promise<void> {
    const transport = this.transport;
    if (!transport) return;
    await transport.retire(this.sdkStart);
    if (this.transport === transport) this.transport = undefined;
  }

  private scheduleRetry(): void {
    if (this.retry || !this.wanted || this.disposed) return;
    const delay = Math.min(this.options.maxRetryDelayMs ?? 5000,
      (this.options.retryDelayMs ?? 300) * 2 ** Math.min(this.failures - 1, 10));
    this.retry = setTimeout(() => {
      this.retry = undefined;
      if (this.wanted && !this.disposed) void this.start().catch(() => {});
    }, delay);
  }

  private clearRetry(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
  }
}

/** Retirement fails pending requests before the SDK can forget a connection. */
export class OwnedIpcServerTransport implements OwnedServerTransport {
  readonly reader: MessageReader;
  readonly writer: MessageWriter;
  private pending = new Set<string | number>();
  private callback?: DataCallback;
  private sdkDisposed = false;
  private invalid = false;
  private closeForwarded?: Promise<void>;
  private retiring?: Promise<void>;
  private exited = false;
  private readonly closed = new Emitter<void>();
  private readonly child;
  private readonly exit: Promise<void>;

  constructor(modulePath: string, cwd: string | undefined, append: (text: string) => void, onFault: (error: unknown) => void) {
    this.child = fork(modulePath, ['--node-ipc', `--clientProcessId=${process.pid}`], {
      cwd, silent: true, execArgv: [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' },
    });
    this.exit = new Promise(resolve => this.child.once('close', () => { this.exited = true; resolve(); }));
    this.child.stdout?.on('data', data => append(String(data)));
    this.child.stderr?.on('data', data => append(String(data)));
    const rawReader = new IPCMessageReader(this.child), rawWriter = new IPCMessageWriter(this.child);
    const fault = (error: unknown): void => { if (!this.invalid && !this.sdkDisposed) onFault(error); };
    this.child.on('error', fault);
    rawReader.onClose(() => fault(new Error('Language server transport closed.')));
    rawReader.onError(fault);
    rawWriter.onError(([error]) => fault(error));
    let subscription: { dispose(): void } | undefined;
    this.reader = {
      onError: rawReader.onError, onClose: this.closed.event, onPartialMessage: rawReader.onPartialMessage,
      listen: callback => {
        this.callback = callback;
        subscription = rawReader.listen(message => {
          if (this.invalid || this.sdkDisposed) return;
          if ('id' in message && !('method' in message)) this.pending.delete(message.id as string | number);
          callback(message);
        });
        return subscription;
      },
      dispose: () => {
        this.sdkDisposed = true;
        this.pending.clear(); this.callback = undefined;
        subscription?.dispose(); rawReader.dispose(); this.closed.dispose();
      },
    };
    this.writer = {
      onError: rawWriter.onError, onClose: this.closed.event,
      write: (message: Message) => {
        // JSONRPC 8 uses an async Promise executor for sendRequest and throws
        // after a rejected write. Deliver a response error instead, after its
        // response waiter has been installed, including writes racing close.
        if (this.invalid || this.sdkDisposed) { this.rejectRequest(message); return Promise.resolve(); }
        if ('id' in message && 'method' in message) this.pending.add(message.id as string | number);
        return rawWriter.write(message).catch(error => { this.rejectRequest(message); fault(error); });
      },
      end: () => rawWriter.end(), dispose: () => rawWriter.dispose(),
    };
  }

  private rejectRequest(message: Message): void {
    if (!('method' in message) || !('id' in message)
      || typeof message.id !== 'string' && typeof message.id !== 'number') return;
    const id = message.id;
    this.pending.delete(id);
    setImmediate(() => {
      if (this.sdkDisposed) return;
      const response: ResponseMessage = { jsonrpc: '2.0', id,
        error: { code: ErrorCodes.PendingResponseRejected, message: 'Language server transport retired.' } };
      this.callback?.(response);
    });
  }

  invalidate(startSettled?: Promise<unknown>): void {
    if (this.invalid) return;
    this.invalid = true;
    if (!this.sdkDisposed) {
      for (const id of this.pending) {
        const response: ResponseMessage = { jsonrpc: '2.0', id,
          error: { code: ErrorCodes.PendingResponseRejected, message: 'Language server transport retired.' } };
        this.callback?.(response);
      }
    }
    this.pending.clear();
    this.closeForwarded = (async () => {
      // SDK initialization cleanup must finish before its close handler can
      // reset the public start promise. Only public transport events are used.
      await startSettled?.catch(() => {});
      if (!this.sdkDisposed) this.closed.fire();
      await nextTurn();
    })();
  }

  retire(startSettled?: Promise<unknown>): Promise<void> {
    if (this.retiring) return this.retiring;
    this.invalidate(startSettled);
    const task = (async () => {
      if (!this.exited) this.child.kill('SIGTERM');
      if (!await this.waitForExit(2000)) {
        this.child.kill('SIGKILL');
        if (!await this.waitForExit(2000)) throw new Error('Language server process did not exit; replacement is deferred.');
      }
      await this.closeForwarded;
      this.reader.dispose(); this.writer.dispose();
    })();
    this.retiring = task;
    void task.catch(() => { if (this.retiring === task) this.retiring = undefined; });
    return task;
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.exit.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}

/** Construct lazily so pure lifecycle tests do not need the VS Code runtime. */
export function createOwnedLanguageClient(id: string, name: string, modulePath: string, options: LanguageClientOptions,
  cwd: () => string | undefined, report: (error: unknown) => void): { client: LanguageClient; lifecycle: LanguageServerLifecycle } {
  const sdk: typeof import('vscode-languageclient/node') = require('vscode-languageclient/node');
  let lifecycle!: LanguageServerLifecycle;
  let initializeCleanup = false;
  class OwnedClient extends sdk.LanguageClient {
    override start(): Promise<void> { return lifecycle.start(); }
    override stop(timeout?: number): Promise<void> {
      // The public initialization-failed callback asks the SDK to stop. The
      // owned attempt already drains that transport; do not cancel its retry.
      if (initializeCleanup) { initializeCleanup = false; return Promise.resolve(); }
      return lifecycle.stop(timeout);
    }
    override dispose(timeout?: number): Promise<void> { lifecycle.deactivate(); return super.dispose(timeout); }
    sdkStart(): Promise<void> { return super.start(); }
    sdkStop(timeout: number): Promise<void> { return super.stop(timeout); }
  }
  const client = new OwnedClient(id, name, async () => lifecycle.open(), {
    ...options,
    initializationFailedHandler: () => { initializeCleanup = true; return false; },
    errorHandler: {
      error: error => { report(error); return { action: sdk.ErrorAction.Continue, handled: true }; },
      closed: () => ({ action: sdk.CloseAction.DoNotRestart, handled: true }),
    },
  });
  lifecycle = new LanguageServerLifecycle({
    open: onFault => new OwnedIpcServerTransport(modulePath, cwd(), text => {
      // A disposed diagnostic channel must not interrupt the owned transport.
      try { options.outputChannel?.append(text); } catch {}
    }, onFault),
    start: () => client.sdkStart(), stop: timeout => client.sdkStop(timeout), isRunning: () => client.isRunning(), report,
  });
  return { client, lifecycle };
}
