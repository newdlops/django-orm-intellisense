import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Module = require('node:module');

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class Emitter<T> {
  readonly listeners = new Set<(value: T) => void>();
  readonly event = (callback: (value: T) => void) => {
    this.listeners.add(callback);
    return { dispose: () => this.listeners.delete(callback) };
  };
  fire(value: T): void { for (const listener of this.listeners) listener(value); }
}

const pythonFile = () => ({ languageId: 'python', uri: { scheme: 'file' } });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(initialPythonDocument = false, pythonActive = false) {
  const opened = new Emitter<unknown>();
  const changed = new Emitter<void>();
  const ready = deferred();
  const activated = deferred<{ ready: Promise<void> }>();
  const api = { ready: ready.promise };
  let activateCalls = 0, promotions = 0;
  const logs: string[] = [];
  const python = {
    isActive: pythonActive,
    exports: pythonActive ? api : undefined as { ready: Promise<void> } | undefined,
    activate: async () => {
      activateCalls++;
      const value = await activated.promise;
      python.isActive = true;
      python.exports = value;
      return value;
    },
  };
  const pylance = { isActive: true };
  const dependencies = new Map<string, unknown>([
    ['ms-python.python', python], ['ms-python.vscode-pylance', pylance],
  ]);
  const documents: unknown[] = initialPythonDocument ? [pythonFile()] : [];
  const vscode = {
    workspace: { textDocuments: documents, onDidOpenTextDocument: opened.event },
    extensions: { getExtension: (id: string) => dependencies.get(id), onDidChange: changed.event },
    Disposable: class { constructor(private readonly callback: () => void) {} dispose() { this.callback(); } },
  };
  const filename = path.join(__dirname, 'providerReadiness.js');
  const loader = new Module(filename, module);
  loader.filename = filename;
  loader.paths = (Module as unknown as { _nodeModulePaths(path: string): string[] })._nodeModulePaths(__dirname);
  const originalRequire = loader.require.bind(loader);
  loader.require = (id: string) => id === 'vscode' ? vscode : originalRequire(id);
  (loader as unknown as { _compile(source: string, file: string): void })._compile(fs.readFileSync(filename, 'utf8'), filename);
  const registration = loader.exports.registerPythonProviderReadiness(
    () => { promotions++; }, (message: string) => logs.push(message)
  );
  return { opened, changed, ready, activated, api, python, pylance, dependencies, documents, logs, registration,
    get activateCalls() { return activateCalls; }, get promotions() { return promotions; },
    open(document: unknown = pythonFile()) { documents.push(document); opened.fire(document); },
    dispose() { registration.dispose(); },
  };
}

async function run(): Promise<void> {
  let cases = 0;
  {
    const f = fixture();
    try {
      f.open({ languageId: 'typescript', uri: { scheme: 'file' } });
      f.open({ languageId: 'python', uri: { scheme: 'untitled' } });
      await flush();
      assert.equal(f.activateCalls, 0, 'Non-file/non-Python contexts must preserve lazy dependencies');
      assert.equal(f.promotions, 0);
    } finally { f.dispose(); }
    cases++;
  }
  {
    const f = fixture();
    try {
      for (let i = 0; i < 32; i++) f.open();
      assert.equal(f.activateCalls, 1, 'Overlapping Python opens must share one activation wait');
      f.activated.resolve(f.api); await flush();
      assert.equal(f.promotions, 0, 'Activation completion is not full Python readiness');
      f.ready.resolve(); await flush();
      assert.equal(f.promotions, 1);
      assert.equal(f.opened.listeners.size + f.changed.listeners.size, 0, 'One-shot readiness must release its event subscriptions');
      f.changed.fire(); f.open(); await flush();
      assert.equal(f.promotions, 1);
    } finally { f.dispose(); }
    cases++;
  }
  {
    const f = fixture(true, true);
    try {
      assert.equal(f.activateCalls, 0, 'Already-active Python must use its existing public API');
      f.ready.resolve(); await flush();
      assert.equal(f.promotions, 1);
    } finally { f.dispose(); }
    cases++;
  }
  for (const phase of ['activation', 'ready'] as const) {
    const f = fixture(true);
    if (phase === 'ready') { f.activated.resolve(f.api); await flush(); }
    f.dispose(); f.activated.resolve(f.api); f.ready.resolve(); await flush();
    assert.equal(f.promotions, 0, `${phase}: disposal must invalidate pending readiness`);
    assert.equal(f.opened.listeners.size + f.changed.listeners.size, 0);
    cases++;
  }
  {
    const f = fixture(true, true);
    try {
      const nextReady = deferred();
      const nextApi = { ready: nextReady.promise };
      f.python.exports = nextApi;
      f.changed.fire();
      await flush();
      nextReady.resolve(); await flush();
      assert.equal(f.promotions, 1, 'A replaced dependency must progress without awaiting its abandoned old promise');
      f.ready.resolve(); await flush();
      assert.equal(f.promotions, 1, 'An old readiness completion must not publish after replacement');
    } finally { f.dispose(); }
    cases++;
  }
  {
    const f = fixture(true, true);
    try {
      f.documents.length = 0;
      f.ready.resolve(); await flush();
      assert.equal(f.promotions, 0, 'Closing the Python context must not consume the extra registration');
      f.open(); await flush();
      assert.equal(f.promotions, 1, 'Reopening Python may use the same completed readiness');
      assert.equal(f.activateCalls, 0);
    } finally { f.dispose(); }
    cases++;
  }
  {
    const f = fixture(true, true);
    try {
      f.pylance.isActive = false;
      f.ready.resolve(); await flush();
      assert.equal(f.promotions, 1,
        'Completed initial Python readiness must not become dormant behind an inactive, unselected Pylance');
      assert.equal(f.activateCalls, 0);
    } finally { f.dispose(); }
    cases++;
  }
  {
    const f = fixture(true, true);
    try {
      f.ready.reject(new Error('readiness failed')); await flush();
      assert.equal(f.promotions, 0);
      assert.ok(f.logs.some(message => message.includes('readiness failed')));
      for (let i = 0; i < 32; i++) f.open();
      await flush();
      assert.equal(f.promotions, 0);
      assert.equal(f.logs.length, 1, 'A rejected API must not create an event-driven retry loop');
    } finally { f.dispose(); }
    cases++;
  }
  {
    const f = fixture();
    try {
      f.dependencies.delete('ms-python.vscode-pylance'); f.open();
      assert.equal(f.activateCalls, 1, 'A supported Python document may activate Python even when Pylance is absent');
      f.activated.resolve(f.api); f.ready.resolve(); await flush();
      assert.equal(f.promotions, 1);
    } finally { f.dispose(); }
    cases++;
  }
  console.log(`Python provider readiness passed ${cases} controlled cases; no polling timers.`);
}

void run().catch(error => { console.error(error); process.exitCode = 1; });
