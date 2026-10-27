import type * as vscode from 'vscode';

const EXTENSION_ID = 'newdlops.django-orm-intellisense';
let nextCapture = 0;

interface NativeSignatureService {
  _adapter: Map<number, unknown>;
  _transformDocumentSelector(selector: vscode.DocumentSelector, extension: unknown): unknown;
  _proxy: {
    $registerSignatureHelpProvider(handle: number, selector: unknown, metadata: {
      triggerCharacters: string[]; retriggerCharacters: string[];
    }): unknown;
  };
  $provideSignatureHelp: unknown;
}

interface InspectorSession {
  connect(): void;
  disconnect(): void;
  post(method: string, parameters: Record<string, unknown>, callback: (error: Error | null, reply?: unknown) => void): void;
}

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === 'object' ? value as ObjectValue : undefined;
}

function service(value: unknown): NativeSignatureService | undefined {
  try {
    const candidate = object(value);
    const proxy = object(candidate?._proxy);
    return candidate?._adapter instanceof Map
      && typeof candidate.$provideSignatureHelp === 'function'
      && typeof candidate._transformDocumentSelector === 'function'
      && typeof proxy?.$registerSignatureHelpProvider === 'function'
      ? candidate as unknown as NativeSignatureService : undefined;
  } catch { return undefined; }
}

function properties(reply: unknown): ObjectValue[] {
  const values = object(reply)?.result;
  return Array.isArray(values) ? values.filter(value => object(value)) as ObjectValue[] : [];
}

/** Capture the real API's service without dependency activation or a debugger spin. */
export async function captureNativeSignatureService(
  register: unknown,
  signal: AbortSignal,
  createSession?: () => Promise<InspectorSession>
): Promise<NativeSignatureService | undefined> {
  if (signal.aborted || typeof register !== 'function') return undefined;
  let session: InspectorSession;
  try {
    session = createSession ? await createSession()
      : new (await import('node:inspector')).Session() as unknown as InspectorSession;
  } catch { return undefined; }
  if (signal.aborted) { try { session.disconnect(); } catch { /* Not connected. */ } return undefined; }
  const root = globalThis as unknown as ObjectValue;
  let key: string;
  do { key = `__djlsSignatureCapture_${process.pid}_${++nextCapture}`; }
  while (Object.prototype.hasOwnProperty.call(root, key));
  const box = { active: true, token: key, register, value: undefined as unknown };
  try { Object.defineProperty(root, key, { value: box, configurable: true }); }
  catch {
    try { session.disconnect(); } catch { /* Not connected. */ }
    return undefined;
  }
  const close = (): void => {
    box.active = false;
    try { session.disconnect(); } catch { /* Only this session is owned. */ }
  };
  const post = (method: string, parameters: Record<string, unknown>): Promise<unknown> =>
    new Promise(resolve => {
      if (signal.aborted) { resolve(undefined); return; }
      let finished = false;
      const finish = (value: unknown): void => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', abort);
        resolve(value);
      };
      const abort = (): void => finish(undefined);
      signal.addEventListener('abort', abort, { once: true });
      try { session.post(method, parameters, (error, reply) => finish(error ? undefined : reply)); }
      catch { finish(undefined); }
    });
  signal.addEventListener('abort', close, { once: true });
  try {
    session.connect();
    const evaluated = object(await post('Runtime.evaluate', {
      expression: `globalThis[${JSON.stringify(key)}].register`, returnByValue: false,
    }));
    const functionId = object(evaluated?.result)?.objectId;
    if (typeof functionId !== 'string' || signal.aborted) return undefined;
    const details = object(await post('Runtime.getProperties', {
      objectId: functionId, ownProperties: false, accessorPropertiesOnly: false,
    }));
    const internal = details?.internalProperties;
    const scope = Array.isArray(internal) ? internal.find(value => object(value)?.name === '[[Scopes]]') : undefined;
    const scopeId = object(object(scope)?.value)?.objectId;
    if (typeof scopeId !== 'string' || signal.aborted) return undefined;
    const scopes = properties(await post('Runtime.getProperties', { objectId: scopeId }));
    for (const scopeEntry of scopes) {
      if (signal.aborted) return undefined;
      const entryId = object(scopeEntry.value)?.objectId;
      if (typeof entryId !== 'string') continue;
      const variables = properties(await post('Runtime.getProperties', { objectId: entryId }));
      for (const variable of variables) {
        if (signal.aborted) return undefined;
        const variableId = object(variable.value)?.objectId;
        if (typeof variableId !== 'string') continue;
        await post('Runtime.callFunctionOn', {
          objectId: variableId,
          functionDeclaration: `function(key) {
            const box = globalThis[key];
            if (!box || !box.active || box.token !== key) return false;
            const method = name => {
              let current = this;
              for (let depth = 0; current && depth < 4; depth++, current = Object.getPrototypeOf(current)) {
                const descriptor = Object.getOwnPropertyDescriptor(current, name);
                if (descriptor) return typeof descriptor.value === 'function';
              }
              return false;
            };
            const adapters = Object.getOwnPropertyDescriptor(this, '_adapter');
            if (adapters?.value instanceof Map && method('$provideSignatureHelp') && method('_transformDocumentSelector')) {
              if (box.active && globalThis[key] === box) box.value = this;
              return true;
            }
            return false;
          }`,
          arguments: [{ value: key }], returnByValue: true,
        });
        if (!signal.aborted && box.active) {
          const found = service(box.value);
          if (found) return found;
        }
      }
    }
    return undefined;
  } catch { return undefined; }
  finally {
    close();
    signal.removeEventListener('abort', close);
    if (Object.getOwnPropertyDescriptor(root, key)?.value === box) delete root[key];
  }
}

type Capture = (register: unknown, signal: AbortSignal) => Promise<NativeSignatureService | undefined>;

/** Refresh only the main registry slot; both selected ExtHost handles stay alive. */
export class NativeSignaturePriority implements vscode.Disposable {
  private disposed = false;
  private readonly lifetime = new AbortController();
  private captureAttempted = false;
  private captured: NativeSignatureService | undefined;
  private captureTask: Promise<NativeSignatureService | undefined> | undefined;
  private pending: Promise<boolean> | undefined;
  private dirty = false;

  constructor(
    private readonly provider: vscode.SignatureHelpProvider,
    private readonly selector: vscode.DocumentSelector,
    private readonly register: unknown,
    private readonly enabled: boolean,
    private readonly capture: Capture = captureNativeSignatureService
  ) {}

  prepare(): void { void this.findService(); }

  refresh(): Promise<boolean> | undefined {
    if (this.disposed || !this.enabled) return undefined;
    this.dirty = true;
    if (this.pending) return this.pending;
    let resolve!: (value: boolean) => void;
    const completion = new Promise<boolean>(done => { resolve = done; });
    this.pending = completion;
    const finish = (published: boolean): void => {
      if (this.dirty && !this.disposed) {
        void this.drain().then(finish, () => finish(false));
        return;
      }
      if (this.pending === completion) this.pending = undefined;
      resolve(published && !this.disposed);
    };
    void this.drain().then(finish, () => finish(false));
    return completion;
  }

  private findService(): Promise<NativeSignatureService | undefined> {
    if (this.disposed || !this.enabled) return Promise.resolve(undefined);
    if (this.captured) return Promise.resolve(this.captured);
    if (this.captureTask) return this.captureTask;
    if (this.captureAttempted) return Promise.resolve(undefined);
    this.captureAttempted = true;
    const attempt = Promise.resolve().then(() => this.disposed ? undefined
      : this.capture(this.register, this.lifetime.signal));
    const task = this.untilDisposed(attempt).then(found => {
        if (!this.disposed) this.captured = service(found);
        return this.disposed ? undefined : this.captured;
      }, () => undefined).finally(() => { if (this.captureTask === task) this.captureTask = undefined; });
    this.captureTask = task;
    return task;
  }

  private async drain(): Promise<boolean> {
    let published = false;
    do {
      this.dirty = false;
      const native = this.captured ?? await this.findService();
      if (this.disposed || !native) return false;
      // All promotions received during capture are covered by this publication.
      this.dirty = false;
      const matches: Array<{ handle: number; extension: unknown }> = [];
      for (const [handle, value] of native._adapter) {
        const row = object(value), adapter = object(row?.adapter), extension = object(row?.extension);
        if (adapter?._provider !== this.provider) continue;
        if (!Number.isSafeInteger(handle) || handle < 0
            || object(extension?.identifier)?.value !== EXTENSION_ID
            || typeof adapter.releaseSignatureHelp !== 'function') return false;
        matches.push({ handle, extension });
      }
      if (matches.length !== 2) return false;
      const latest = matches[0].handle > matches[1].handle ? matches[0] : matches[1];
      const transformed = native._transformDocumentSelector(this.selector, latest.extension);
      if (this.disposed) return false;
      const publication = native._proxy.$registerSignatureHelpProvider(latest.handle, transformed, {
        triggerCharacters: ['(', ','], retriggerCharacters: [','],
      });
      published = await this.settlePublication(publication);
      if (!published) return false;
    } while (this.dirty && !this.disposed);
    return published && !this.disposed;
  }

  private async settlePublication(value: unknown): Promise<boolean> {
    return await this.untilDisposed(Promise.resolve(value).then(() => true, () => false)) === true;
  }

  private untilDisposed<T>(value: PromiseLike<T>): Promise<T | undefined> {
    return new Promise(resolve => {
      if (this.disposed) { resolve(undefined); return; }
      let finished = false;
      const finish = (result: T | undefined): void => {
        if (finished) return;
        finished = true;
        this.lifetime.signal.removeEventListener('abort', abort);
        resolve(result);
      };
      const abort = (): void => finish(undefined);
      this.lifetime.signal.addEventListener('abort', abort, { once: true });
      void Promise.resolve(value).then(finish, () => finish(undefined));
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dirty = false;
    this.lifetime.abort();
    this.captured = undefined;
  }
}
