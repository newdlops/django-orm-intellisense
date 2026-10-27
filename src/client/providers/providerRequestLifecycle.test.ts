// Exercise the real compiled provider callbacks with controlled daemon bodies.
// Invoke: node out/client/providers/providerRequestLifecycle.test.js
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';

const kinds = ['hover', 'completion', 'definition', 'signature'] as const;
type Kind = typeof kinds[number] | 'inlay';
type Disposable = { dispose(): void };

export class Token {
  isCancellationRequested = false;
  readonly listeners = new Set<() => void>();
  onCancellationRequested(listener: () => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }
  cancel(): void {
    this.isCancellationRequested = true;
    for (const listener of [...this.listeners]) listener();
  }
}

export function fixture(providerSource?: string, realTimers = false, stableProviders = false) {
  const callbacks = new Map<Kind, (...args: any[]) => Promise<unknown>>();
  const handles = new Map<Kind, number>();
  const adapters = new Map<number, { kind: Kind; callback: (...args: any[]) => Promise<unknown>; provider: Record<string, any> }>();
  const eventSources = new Map<string, Set<(...args: any[]) => void>>();
  const emitters = new Set<{ listenerCount: number }>();
  const timers = new Map<number | NodeJS.Timeout, () => void>();
  let sequence = 0;
  let nextHandle = 0;
  const disposable = (): Disposable => ({ dispose() {} });
  class TestDisposable {
    constructor(private readonly callback: () => void) {}
    dispose(): void { this.callback(); }
  }
  class TestEventEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();
    private disposed = false;
    readonly event = (listener: (value: T) => void, thisArg?: unknown, disposables?: Disposable[]) => {
      const bound = (value: T) => listener.call(thisArg, value);
      if (!this.disposed) this.listeners.add(bound);
      const subscription = { dispose: () => { this.listeners.delete(bound); } };
      disposables?.push(subscription);
      return subscription;
    };
    constructor() { emitters.add(this); }
    get listenerCount(): number { return this.listeners.size; }
    fire(value: T): void { if (!this.disposed) for (const listener of [...this.listeners]) listener(value); }
    dispose(): void { this.disposed = true; this.listeners.clear(); emitters.delete(this); }
  }
  const on = (name: string) => (listener: (...args: any[]) => void): Disposable => {
    let listeners = eventSources.get(name);
    if (!listeners) eventSources.set(name, listeners = new Set());
    listeners.add(listener);
    return { dispose: () => { listeners!.delete(listener); } };
  };
  const fire = (name: string, ...args: any[]) => {
    for (const listener of [...eventSources.get(name) ?? []]) listener(...args);
  };
  const register = (kind: Kind, method: string) => (_selector: unknown, provider: Record<string, any>) => {
    const callback = provider[method].bind(provider), handle = ++nextHandle;
    callbacks.set(kind, callback);
    handles.set(kind, handle);
    adapters.set(handle, { kind, callback, provider });
    return { dispose() {
      // VSCode removes the extension-host adapter immediately on disposal,
      // even when the workbench already selected it for a queued request.
      adapters.delete(handle);
      if (handles.get(kind) === handle) {
        handles.delete(kind);
        callbacks.delete(kind);
      }
    } };
  };
  const vscode = {
    Disposable: TestDisposable,
    EventEmitter: TestEventEmitter,
    Position: class { constructor(readonly line: number, readonly character: number) {} },
    CompletionList: class {},
    languages: {
      createDiagnosticCollection: () => ({ clear() {}, delete() {}, dispose() {} }),
      registerHoverProvider: register('hover', 'provideHover'),
      registerCompletionItemProvider: register('completion', 'provideCompletionItems'),
      registerDefinitionProvider: register('definition', 'provideDefinition'),
      registerSignatureHelpProvider: register('signature', 'provideSignatureHelp'),
      registerInlayHintsProvider: register('inlay', 'provideInlayHints'),
    },
    window: { visibleTextEditors: [], onDidChangeVisibleTextEditors: disposable,
      onDidChangeTextEditorVisibleRanges: disposable },
    workspace: {
      workspaceFolders: [], onDidOpenTextDocument: disposable, onDidChangeTextDocument: disposable,
      onDidCloseTextDocument: disposable, onDidSaveTextDocument: disposable,
      onDidChangeConfiguration: on('configuration'),
      getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    },
  };
  const signalContext = new AsyncLocalStorage<AbortSignal>();
  let sourceCalls = 0;
  let body: (callback: () => unknown) => unknown = () => Promise.resolve(undefined);
  let ensureStarted = () => Promise.resolve();
  let ready = false;
  const signals: Array<AbortSignal | undefined> = [];
  const daemon = {
    isReady: () => ready, getSessionRevision: () => 0, logDiagnostic() {},
    isAborted: () => signalContext.getStore()?.aborted === true,
    ensureStarted: () => ensureStarted(),
    onDidChangeState: on('state'), onDidReindexModels: on('models'),
    withDeadline: (_deadline: number, callback: () => unknown) => callback(),
    withAbortSignal: (next: AbortSignal, callback: () => unknown) => signalContext.run(next, callback),
    withRequestSource: (_source: string, callback: () => unknown) => {
      sourceCalls++;
      signals.push(signalContext.getStore());
      return body(callback);
    },
  };
  const filename = path.join(__dirname, 'pythonProviders.js');
  const nodeRequire = createRequire(filename);
  const modules = new Map<string, { exports: any }>();
  const context = vm.createContext({
    console, performance, AbortController, queueMicrotask,
    process: { env: {} },
    setTimeout: (callback: () => void, delay: number) => {
      if (realTimers) {
        const id = setTimeout(() => { timers.delete(id); callback(); }, delay);
        timers.set(id, callback);
        return id;
      }
      timers.set(++sequence, callback);
      return sequence;
    },
    clearTimeout: (id: number | NodeJS.Timeout) => { timers.delete(id); if (realTimers) clearTimeout(id); },
  });
  const load = (name: string): any => {
    const cached = modules.get(name);
    if (cached) return cached.exports;
    const module = { exports: {} };
    modules.set(name, module);
    const require = (id: string): any => {
      if (id === 'vscode') return vscode;
      if (id === '../config/settings') return { CONFIGURATION_SECTION: 'djangoOrmIntellisense',
        getExtensionSettings: () => ({ diagnosticsEnabled: false }) };
      if (id === '../python/pylance') return { isPylanceAvailable: () => false };
      if (id === './providerRequestLifetime') return load(path.join(__dirname, 'providerRequestLifetime.js'));
      return nodeRequire(id);
    };
    const source = name === filename && providerSource !== undefined ? providerSource : fs.readFileSync(name, 'utf8');
    const wrapper = vm.runInContext(`(function(exports, require, module, __filename, __dirname) {\n${source}\n})`, context);
    wrapper(module.exports, require, module, name, path.dirname(name));
    return module.exports;
  };
  const providers = load(filename);
  const providerOwner = stableProviders && providers.PythonInteractiveProviderOwner
    ? new providers.PythonInteractiveProviderOwner() : undefined;
  let registrations: Disposable[] = providers.registerPythonProviders(daemon, providerOwner);
  let text = 'pass';
  const document = {
    uri: { fsPath: '/fixture/query.py', toString: () => 'file:///fixture/query.py' },
    version: 1, languageId: 'python', lineCount: 1,
    getText: () => text, lineAt: () => ({ text }),
    offsetAt: (position: { character: number }) => position.character,
    positionAt: (offset: number) => ({ line: 0, character: offset }),
    getWordRangeAtPosition: () => undefined,
  };
  return {
    timers, signals, providers, get sourceCalls() { return sourceCalls; },
    isAborted: () => daemon.isAborted(),
    createOwner() { return new (load(path.join(__dirname, 'providerRequestLifetime.js')).ProviderRequestOwner)(); },
    setBody(next: () => Promise<unknown>) { body = next; },
    executeBody() { body = callback => callback(); },
    setEnsureStarted(next: () => Promise<void>) { ensureStarted = next; },
    setReady(next: boolean) { ready = next; },
    setText(next: string) { text = next; },
    subscribeInlayChanges(listener: () => void): Disposable {
      const provider = adapters.get(handles.get('inlay')!)?.provider;
      assert.equal(typeof provider?.onDidChangeInlayHints, 'function',
        'The live inlay adapter must expose refresh events even when its last result was empty');
      return provider!.onDidChangeInlayHints(listener);
    },
    fireConfiguration(section: string) {
      fire('configuration', { affectsConfiguration: (candidate: string) => candidate === section });
    },
    fireState(phase: string) { fire('state', { phase }); },
    fireModels() { fire('models'); },
    get eventSourceListenerCount() { return [...eventSources.values()].reduce((sum, listeners) => sum + listeners.size, 0); },
    get emitterCount() { return emitters.size; },
    get emitterListenerCount() { return [...emitters].reduce((sum, emitter) => sum + emitter.listenerCount, 0); },
    invoke(kind: Kind, token: Token): Promise<unknown> {
      const args: unknown[] = [document, kind === 'inlay'
        ? { start: { line: 0, character: 0 }, end: { line: 0, character: text.length } }
        : { line: 0, character: text === 'pass' ? 0 : text.length }, token];
      if (kind === 'signature') args.push({ triggerKind: 1 });
      return callbacks.get(kind)!(...args);
    },
    queueProvider(kind: Kind, token: Token) {
      const handle = handles.get(kind)!;
      const args: unknown[] = [document, kind === 'inlay'
        ? { start: { line: 0, character: 0 }, end: { line: 0, character: text.length } }
        : { line: 0, character: text === 'pass' ? 0 : text.length }, token];
      if (kind === 'signature') args.push({ triggerKind: 1 });
      return () => adapters.get(handle)?.callback(...args);
    },
    queueProviderWithLifetime(kind: Kind, token: Token) {
      const handle = handles.get(kind)!;
      const dispatch = this.queueProvider(kind, token);
      return { dispatch, isRegistered: () => adapters.has(handle) };
    },
    registerSignatureFallback() {
      const provider = { provideSignatureHelp: () => Promise.resolve(undefined) };
      const registration = vscode.languages.registerSignatureHelpProvider('python', provider);
      return { provider, registration };
    },
    promoteSignatureHelpPriority() {
      return providerOwner?.promoteSignatureHelpPriority();
    },
    get signatureAdapterCount() {
      return [...adapters.values()].filter(adapter => adapter.kind === 'signature').length;
    },
    get latestSignatureProvider() {
      return adapters.get(handles.get('signature')!)?.provider;
    },
    promote() {
      const replacement: Disposable[] = providers.registerPythonProviders(daemon, providerOwner);
      for (const registration of registrations) registration.dispose();
      registrations = replacement;
    },
    get hoverAdapters() { return [...adapters.values()].filter(adapter => adapter.kind === 'hover').length; },
    get adapterCount() { return adapters.size; },
    dispose() {
      for (const registration of registrations) registration.dispose();
      providerOwner?.dispose();
    },
    fireTimers() {
      for (const [id, callback] of [...timers]) {
        timers.delete(id);
        if (realTimers) clearTimeout(id);
        callback();
      }
    },
  };
}

async function drain(): Promise<void> {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}

async function main(): Promise<void> {
  const observations = [];
  for (const kind of kinds) {
    const test = fixture(), token = new Token();
    try {
      for (let i = 0; i < 32; i++) await test.invoke(kind, token);
      observations.push({ kind, completed: 32, retainedTimers: test.timers.size,
        retainedTokenListeners: token.listeners.size, sourceCalls: test.sourceCalls });
    } finally { test.dispose(); }
  }
  console.log(JSON.stringify({ normalRequests: observations }));
  for (const row of observations) {
    assert.equal(row.sourceCalls, 32, `${row.kind}: real provider wrapper reaches its daemon body`);
    assert.equal(row.retainedTimers, 0, `${row.kind}: completed requests release all deadline timers`);
    assert.equal(row.retainedTokenListeners, 0, `${row.kind}: completed requests release token listeners`);
  }
  for (const kind of kinds) {
    const test = fixture(), token = new Token();
    let release!: (value: undefined) => void;
    test.setBody(() => new Promise(resolve => { release = resolve; }));
    let settled = false;
    const pending = test.invoke(kind, token).then(result => { settled = true; return result; });
    token.cancel();
    await drain();
    assert.ok(settled, `${kind}: cancellation releases the caller even while the daemon body is held`);
    assert.ok(test.signals[0]?.aborted, `${kind}: cancellation reaches the daemon async context`);
    assert.equal(await pending, undefined);
    assert.equal(token.listeners.size, 0);
    assert.equal(test.timers.size, 0);
    release(undefined);
    await drain();
    assert.equal(test.providers.isAnyInteractiveRequestInFlight(), false);
    test.dispose();
  }
  {
    const test = fixture(), token = new Token();
    let entered = false, abortedAfterAwait = false, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    test.setText('Post.objects.create(ti');
    test.setEnsureStarted(async () => { entered = true; await gate; abortedAfterAwait = test.isAborted(); });
    test.executeBody();
    const pending = test.invoke('signature', token);
    await drain();
    assert.ok(entered, 'actual signature resolution reaches the held daemon startup');
    token.cancel();
    assert.equal(await pending, undefined);
    assert.ok(test.signals[0]?.aborted, 'signature cancellation remains visible after the held await');
    release();
    await drain();
    assert.ok(abortedAfterAwait, 'a late signature body keeps its cancelled daemon async context');
    assert.equal(test.sourceCalls, 1);
    assert.equal(test.timers.size, 0);
    assert.equal(token.listeners.size, 0);
    test.dispose();
  }
  for (const kind of kinds) {
    const test = fixture(), token = new Token();
    test.setBody(() => Promise.reject(new Error('controlled body failure')));
    await test.invoke(kind, token).catch(() => undefined);
    assert.equal(token.listeners.size, 0, `${kind}: failure releases token listeners`);
    assert.equal(test.timers.size, 0, `${kind}: failure releases deadline timers`);
    assert.ok(test.signals[0]?.aborted, `${kind}: failure closes the daemon context`);
    test.dispose();
  }
  for (const kind of kinds.filter(value => value !== 'signature')) {
    const test = fixture(), token = new Token();
    let release!: (value: undefined) => void;
    test.setBody(() => new Promise(resolve => { release = resolve; }));
    const pending = test.invoke(kind, token);
    test.fireTimers();
    assert.equal(await pending, undefined, `${kind}: deadline releases a held body`);
    assert.ok(test.signals[0]?.aborted);
    assert.equal(test.timers.size, 0);
    assert.equal(token.listeners.size, 0);
    release(undefined);
    test.dispose();
  }
  {
    const test = fixture(), tokens = kinds.map(() => new Token());
    const releases: Array<(value: undefined) => void> = [];
    test.setBody(() => new Promise(resolve => { releases.push(resolve); }));
    const pending = kinds.map((kind, index) => test.invoke(kind, tokens[index]));
    test.dispose();
    assert.deepEqual(await Promise.all(pending), kinds.map(() => undefined));
    assert.ok(test.signals.every(signal => signal?.aborted), 'registration disposal aborts every active daemon context');
    assert.equal(test.timers.size, 0);
    assert.ok(tokens.every(token => token.listeners.size === 0));
    for (const release of releases) release(undefined);
    await drain();
    assert.equal(test.providers.isAnyInteractiveRequestInFlight(), false);
  }
  for (const kind of kinds) {
    const test = fixture(), token = new Token();
    token.cancel();
    assert.equal(await test.invoke(kind, token), undefined);
    assert.equal(test.sourceCalls, 0);
    assert.equal(test.timers.size, 0);
    assert.equal(token.listeners.size, 0);
    test.dispose();
  }
  {
    const test = fixture(), owner = test.createOwner(), token = new Token();
    token.onCancellationRequested = listener => {
      token.isCancellationRequested = true;
      listener();
      token.listeners.add(listener);
      return { dispose: () => { token.listeners.delete(listener); } };
    };
    const scope = owner.begin(token, 1200);
    assert.ok(scope.signal.aborted, 'synchronous cancellation while subscribing aborts the scope');
    assert.equal(await scope.cancelled, undefined);
    assert.equal(token.listeners.size, 0);
    assert.equal(test.timers.size, 0);
    scope.dispose(); owner.dispose(); test.dispose();
  }
  {
    const test = fixture(), owner = test.createOwner(), token = new Token();
    owner.dispose();
    const scope = owner.begin(token, 1200);
    assert.ok(scope.signal.aborted, 'a disposed owner cannot acquire a new live request');
    assert.equal(await scope.cancelled, undefined);
    assert.equal(token.listeners.size, 0);
    assert.equal(test.timers.size, 0);
    scope.dispose(); test.dispose();
  }
  for (const stable of [false, true]) {
    const test = fixture(undefined, false, stable), token = new Token();
    let release!: () => void;
    const startup = new Promise<void>(resolve => { release = resolve; });
    let startupCalls = 0, returned = false, refreshes = 0;
    test.setText('Post.objects.filter(title__icontains="draft")');
    test.executeBody();
    test.setEnsureStarted(() => { startupCalls++; return startup; });
    const listener = test.subscribeInlayChanges(() => { refreshes++; });
    const pending = test.invoke('inlay', token).then(value => { returned = true; return value; });
    await drain();
    try {
      assert.equal(returned, true, 'An unready background inlay must return without waiting for foreground startup');
      const hints = await pending;
      assert.ok(Array.isArray(hints));
      assert.equal(hints.length, 0);
      assert.equal(startupCalls, 0, 'An unready background inlay must not enter daemon startup');
      assert.equal(test.sourceCalls, 0);
      assert.equal(test.providers.isAnyInteractiveRequestInFlight(), false);
      assert.equal(token.listeners.size, 0);
      assert.equal(test.timers.size, 0);
      test.setReady(true);
      test.fireState('ready');
      test.fireModels();
      assert.equal(refreshes, 2, 'Readiness and metadata changes must refresh a previously empty inlay');
      test.setBody(() => Promise.resolve([]));
      assert.ok(Array.isArray(await test.invoke('inlay', token)));
      assert.equal(test.sourceCalls, 2, 'A refreshed ready inlay retains both existing diagnostic stages');
      assert.equal(token.listeners.size, 0);
      assert.equal(test.timers.size, 0);
      assert.equal(test.providers.isAnyInteractiveRequestInFlight(), false);
    } finally {
      release();
      token.cancel();
      await pending;
      listener.dispose();
      test.dispose();
      assert.equal(test.eventSourceListenerCount, 0);
      assert.equal(test.emitterCount, 0);
      assert.equal(test.emitterListenerCount, 0);
      assert.equal(test.adapterCount, 0);
    }
  }
  for (const ending of ['cancel', 'dispose']) {
    const test = fixture(undefined, false, true), token = new Token();
    let release: ((value: undefined) => void) | undefined;
    test.setReady(true);
    test.setText('Post.objects.filter(title__icontains="draft")');
    test.setBody(() => new Promise(resolve => { release = resolve; }));
    const pending = test.invoke('inlay', token);
    await drain();
    try {
      assert.equal(test.providers.isAnyInteractiveRequestInFlight(), true,
        'An entered inlay request must prevent replacement of its live implementation');
      if (ending === 'cancel') token.cancel();
      else test.dispose();
      assert.equal(await pending, undefined, `${ending}: a held inlay request must release its caller`);
      assert.ok(test.signals[0]?.aborted, `${ending}: inlay cancellation reaches its daemon context`);
      assert.equal(token.listeners.size, 0);
      assert.equal(test.timers.size, 0);
      assert.equal(test.providers.isAnyInteractiveRequestInFlight(), false);
    } finally {
      token.cancel();
      release?.(undefined);
      await pending;
      test.dispose();
    }
  }
  {
    const test = fixture(undefined, false, true), token = new Token();
    test.setReady(true);
    test.setText('Post.objects.filter(title__icontains="draft")');
    test.setBody(() => Promise.resolve([]));
    try {
      for (let request = 0; request < 32; request++) {
        assert.ok(Array.isArray(await test.invoke('inlay', token)));
        assert.equal(token.listeners.size, 0);
        assert.equal(test.timers.size, 0);
        assert.equal(test.providers.isAnyInteractiveRequestInFlight(), false);
      }
      assert.equal(test.sourceCalls, 64, 'Completed inlay requests retain both diagnostic-sourced stages');
    } finally { test.dispose(); }
  }
  for (const ending of ['pre-cancelled', 'startup-failure']) {
    const test = fixture(undefined, false, true), token = new Token();
    test.setReady(true);
    test.setText('Post.objects.filter(title__icontains="draft")');
    if (ending === 'pre-cancelled') token.cancel();
    else test.setBody(() => Promise.reject(new Error('controlled inlay startup failure')));
    try {
      const hints = await test.invoke('inlay', token);
      if (ending === 'pre-cancelled') {
        assert.equal(hints, undefined);
        assert.equal(test.sourceCalls, 0, 'A pre-cancelled inlay request must not reach the daemon');
      } else {
        assert.ok(Array.isArray(hints));
        assert.equal(hints.length, 0, 'Inlay startup failure preserves the empty-result fallback');
        assert.equal(test.sourceCalls, 1);
        assert.ok(test.signals[0]?.aborted);
      }
      assert.equal(token.listeners.size, 0);
      assert.equal(test.timers.size, 0);
      assert.equal(test.providers.isAnyInteractiveRequestInFlight(), false);
    } finally { test.dispose(); }
  }
  {
    const test = fixture(undefined, false, true);
    const hover = { contents: ['Field kind: `UUIDField`'] };
    test.setBody(() => Promise.resolve(hover));
    for (let i = 0; i < 32; i++) {
      const token = new Token();
      const dispatch = test.queueProvider('hover', token);
      test.promote();
      assert.equal(await dispatch(), hover, 'A hover selected before promotion must survive delayed dispatch');
      assert.equal(test.hoverAdapters, 1, 'Promotion must not accumulate hover API registrations');
      assert.equal(test.adapterCount, 5, 'Promotion must retain exactly one adapter for each language feature');
      assert.equal(token.listeners.size, 0);
      assert.equal(test.timers.size, 0);
    }
    test.dispose();
    assert.equal(test.adapterCount, 0, 'Final disposal must release the stable hover registration');
    assert.equal(test.providers.isAnyInteractiveRequestInFlight(), false);
  }
  {
    const test = fixture(undefined, false, true);
    const queued = test.queueProviderWithLifetime('signature', new Token());
    const originalProductAdapter = test.latestSignatureProvider;
    const fallback = test.registerSignatureFallback();
    try {
      assert.equal(test.latestSignatureProvider, fallback.provider,
        'A later Python extension initially owns signature priority');
      test.promoteSignatureHelpPriority();
      assert.equal(test.latestSignatureProvider, originalProductAdapter,
        'Promotion must register the same stable product adapter after the later provider');
      assert.equal(test.signatureAdapterCount, 3,
        'Keep the prior product adapter registered so a request selected before promotion can still dispatch');
      assert.equal(queued.isRegistered(), true,
        'Promotion must preserve the API handle captured by a queued pre-callback request');
      await queued.dispatch();
      assert.equal(test.adapterCount, 7,
        'A single promotion adds only one signature adapter and does not duplicate other provider kinds');
      test.promoteSignatureHelpPriority();
      assert.equal(test.signatureAdapterCount, 3, 'Priority promotion is idempotent');
    } finally {
      fallback.registration.dispose();
      test.dispose();
    }
    assert.equal(test.adapterCount, 0, 'Owner disposal releases both retained signature registrations');
  }
  for (const kind of kinds.filter(value => value !== 'hover')) {
    const test = fixture(undefined, false, true);
    const token = new Token();
    try {
      const dispatch = test.queueProvider(kind, token);
      test.promote();
      const pending = dispatch();
      assert.ok(
        test.providers.isAnyInteractiveRequestInFlight(),
        `${kind}: an adapter selected before promotion must dispatch to the replacement provider`
      );
      test.dispose();
      await pending;
      await drain();
      assert.equal(test.adapterCount, 0, `${kind}: final disposal releases its stable adapter`);
      assert.equal(test.providers.isAnyInteractiveRequestInFlight(), false);
      assert.equal(token.listeners.size, 0);
      assert.equal(test.timers.size, 0);
    } finally {
      test.dispose();
    }
  }
  {
    const test = fixture(undefined, false, true);
    test.setReady(true);
    try {
      for (let promotion = 0; promotion < 32; promotion++) {
        const token = new Token();
        const dispatch = test.queueProvider('inlay', token);
        test.promote();
        const hints = await dispatch();
        assert.ok(Array.isArray(hints), 'An inlay request selected before promotion must reach the new delegate');
        assert.equal(hints.length, 0, 'A document without lookup candidates has an empty hint result');
        assert.equal(test.adapterCount, 5, 'Inlay promotion must not accumulate language-feature adapters');
        assert.equal(token.listeners.size, 0);
        assert.equal(test.timers.size, 0);
      }
    } finally {
      test.dispose();
      assert.equal(test.adapterCount, 0);
    }
  }
  for (const stable of [false, true]) {
    const test = fixture(undefined, false, stable);
    let refreshes = 0;
    const listener = test.subscribeInlayChanges(() => { refreshes++; });
    try {
      assert.equal((await test.invoke('inlay', new Token()) as unknown[]).length, 0);
      test.fireConfiguration('editor.fontSize');
      assert.equal(refreshes, 0, 'Unrelated configuration must not refresh hints');
      for (let promotion = 0; promotion < (stable ? 32 : 1); promotion++) {
        const before: number = refreshes;
        test.fireConfiguration('djangoOrmIntellisense.inlayHints.enabled');
        test.fireState('ready');
        test.fireModels();
        assert.equal(refreshes, before + 3,
          'Settings, readiness and model refreshes must reach an empty-result provider with diagnostics disabled');
        assert.equal(test.eventSourceListenerCount, 3, 'Exactly one live implementation owns the refresh sources');
        if (stable) {
          test.promote();
          assert.equal(refreshes, before + 4, 'Changing the delegate must refresh the persistent adapter');
          assert.equal(test.adapterCount, 5);
          assert.equal(test.emitterCount, 2, 'Only the owner and current implementation emitters may remain');
          assert.equal(test.emitterListenerCount, 2, 'Only the editor and delegate-forwarding subscriptions may remain');
        }
      }
    } finally {
      test.dispose();
      const before: number = refreshes;
      test.fireConfiguration('djangoOrmIntellisense.inlayHints.enabled');
      test.fireState('ready');
      test.fireModels();
      assert.equal(refreshes, before, 'Disposed providers must not notify the editor');
      assert.equal(test.eventSourceListenerCount, 0);
      assert.equal(test.emitterCount, 0);
      assert.equal(test.emitterListenerCount, 0);
      assert.equal(test.adapterCount, 0);
      assert.equal(test.timers.size, 0);
      listener.dispose();
    }
  }
  console.log('provider request lifecycle OK: real compiled hover/completion/definition/signature wrappers and queued inlay dispatch; normal, cancel, failure, deadline, owner disposal, pre-cancelled entry, queued provider dispatch and bounded inlay refresh ownership across promotion');
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
