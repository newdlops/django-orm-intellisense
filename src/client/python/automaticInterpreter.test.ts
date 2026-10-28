import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Module = require('node:module');

class Uri {
  readonly scheme = 'file';
  constructor(readonly fsPath: string) {}
  static file(value: string): Uri { return new Uri(value); }
}
class Emitter<T> {
  readonly listeners = new Set<(value: T) => void>();
  readonly event = (callback: (value: T) => void) => {
    this.listeners.add(callback);
    return { dispose: () => this.listeners.delete(callback) };
  };
  fire(value: T): void { for (const listener of [...this.listeners]) listener(value); }
  dispose(): void { this.listeners.clear(); }
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djls-auto-interpreter-'));
const first = path.join(root, 'first'), second = path.join(root, 'second'), empty = path.join(root, 'empty');
for (const dir of [first, second, empty]) fs.mkdirSync(dir);
const opened = new Emitter<any>();
const extensionChanges = new Emitter<void>();
const configurations = new Map<string, Map<string, unknown>>();
const documents: any[] = [];
let python: any;
let active: any;
let spawnCalls = 0;
const folderFor = (uri?: Uri) => [first, second, empty].sort((a, b) => b.length - a.length)
  .find(folder => uri && (uri.fsPath === folder || uri.fsPath.startsWith(folder + path.sep)));
const vscode: any = {
  Uri, EventEmitter: Emitter,
  Disposable: class { constructor(private readonly callback: () => void) {} dispose() { this.callback(); } },
  workspace: {
    workspaceFolders: [first, second, empty].map(dir => ({ uri: Uri.file(dir) })),
    textDocuments: documents,
    getWorkspaceFolder: (uri: Uri) => { const folder = folderFor(uri); return folder ? { uri: Uri.file(folder) } : undefined; },
    getConfiguration: (section: string, uri?: Uri) => ({
      get: (key: string, fallback?: unknown) => configurations.get(folderFor(uri) ?? '')?.get(section + '.' + key) ?? fallback,
    }),
    onDidOpenTextDocument: opened.event,
  },
  window: { get activeTextEditor() { return active; } },
  extensions: { getExtension: (id: string) => id === 'ms-python.python' ? python : undefined,
    onDidChange: extensionChanges.event },
};
const originalLoad = (Module as any)._load;
let interpreter: typeof import('./interpreter');
let changes: typeof import('./interpreterChanges');
let Daemon: typeof import('../daemon/analysisDaemon').AnalysisDaemon;
(Module as any)._load = function(name: string, ...args: unknown[]) {
  if (name === 'vscode') return vscode;
  if (name === 'child_process') return { ...require('node:child_process'), spawn: () => {
    spawnCalls++; throw new Error('The control fixture must never launch a real daemon');
  } };
  return Reflect.apply(originalLoad, this, [name, ...args]);
};
try {
  interpreter = require('./interpreter');
  changes = require('./interpreterChanges');
  Daemon = require('../daemon/analysisDaemon').AnalysisDaemon;
} finally { (Module as any)._load = originalLoad; }
const settings = (workspaceRoot: string, pythonInterpreter?: string) => ({ workspaceRoot, pythonInterpreter,
  logLevel: 'off' as const, autoStart: false, diagnosticsEnabled: false, diagnosticsFullDocument: false,
  pylanceAutoApplyStubOverrides: false });
const resource = (folder: string) => Uri.file(path.join(folder, 'views.py')) as any;
function environment(folder: string, name = '.venv'): string {
  const env = path.join(folder, name);
  fs.mkdirSync(path.join(env, process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true });
  fs.writeFileSync(path.join(env, 'pyvenv.cfg'), 'version = 3.11.15\n');
  const executable = path.join(env, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  fs.writeFileSync(executable, '#!/bin/sh\nprintf "3.11.15\\n"\n', { mode: 0o755 });
  return executable;
}
const firstPython = environment(first), secondPython = environment(second);
const external = environment(root, 'selected-environment');
function daemonFixture(): any {
  return new Daemon({ extensionPath: path.resolve(__dirname, '../../..'), asAbsolutePath: (p: string) => p } as any,
    { appendLine() {}, dispose() {} } as any);
}

async function run(): Promise<void> {
  let cases = 0;
  active = { document: { uri: resource(second) } };
  let result = await interpreter.resolvePythonInterpreter(settings(first), resource(first));
  assert.equal(result.source, 'workspace-venv');
  assert.equal(result.path, firstPython, 'The requesting file owns selection even when another editor is active'); cases++;

  python = { isActive: true, exports: { environments: { getActiveEnvironmentPath: (uri: Uri) => {
    assert.equal(folderFor(uri), first); return { path: external };
  } } } };
  result = await interpreter.resolvePythonInterpreter(settings(first, firstPython), resource(first));
  assert.equal(result.source, 'djangoOrmIntellisense.pythonInterpreter');
  assert.equal(result.path, firstPython); cases++;
  result = await interpreter.resolvePythonInterpreter(settings(first), resource(first));
  assert.equal(result.source, 'python-extension'); assert.equal(result.path, external); cases++;

  python.exports.environments.getActiveEnvironmentPath = () => ({ path: 'python' });
  result = await interpreter.resolvePythonInterpreter(settings(first), resource(first));
  assert.equal(result.path, firstPython, 'The public API default command must not mask the local environment'); cases++;
  python.exports.environments.getActiveEnvironmentPath = () => ({ path: path.join(root, 'removed-python') });
  result = await interpreter.resolvePythonInterpreter(settings(first), resource(first));
  assert.equal(result.path, firstPython, 'A stale public selection must not hide a usable local environment'); cases++;
  python = undefined;
  configurations.set(first, new Map([['python.defaultInterpreterPath', path.dirname(path.dirname(external))]]));
  result = await interpreter.resolvePythonInterpreter(settings(first), resource(first));
  assert.equal(result.source, 'python.defaultInterpreterPath'); assert.equal(result.path, external); cases++;
  configurations.set(first, new Map([['djangoOrmIntellisense.pythonPath', secondPython]]));
  result = await interpreter.resolvePythonInterpreter(settings(first), resource(first));
  assert.equal(result.source, 'djangoOrmIntellisense.pythonInterpreter'); assert.equal(result.path, secondPython); cases++;
  configurations.clear();

  if (process.platform !== 'win32') {
    const base = path.join(root, 'base-python'); fs.writeFileSync(base, 'base Python', { mode: 0o755 });
    const aliasRoot = path.join(empty, 'alias-project'); fs.mkdirSync(aliasRoot);
    const alias = environment(aliasRoot); fs.unlinkSync(alias); fs.symlinkSync(base, alias);
    python = { isActive: true, exports: { environments: { getActiveEnvironmentPath: () => ({ path: base }) } } };
    result = await interpreter.resolvePythonInterpreter(settings(aliasRoot), resource(aliasRoot));
    assert.equal(result.path, alias, 'A resolved base executable must retain the project virtualenv and its dependencies');
    assert.equal(result.source, 'python-extension'); cases++;
    const outside = environment(root, 'outside-venv'); fs.unlinkSync(outside); fs.symlinkSync(base, outside);
    python.exports.environments.getActiveEnvironmentPath = () => ({ path: outside });
    result = await interpreter.resolvePythonInterpreter(settings(aliasRoot), resource(aliasRoot));
    assert.equal(result.path, outside, 'An explicitly selected external virtualenv keeps its own installed packages'); cases++;
    python = undefined;
  }

  const nested = path.join(first, 'services/api'); fs.mkdirSync(nested, { recursive: true });
  const nestedPython = environment(nested);
  result = await interpreter.resolvePythonInterpreter(settings(first), resource(nested));
  assert.equal(result.path, nestedPython, 'Nested project environments are found without scanning the repository'); cases++;
  result = await interpreter.resolvePythonInterpreter(settings(empty), resource(empty));
  assert.equal(result.source, 'fallback');
  assert.notEqual(result.path, external, 'Searching must stop at the current workspace boundary'); cases++;

  {
    const daemon = daemonFixture();
    const context = await daemon.createLaunchContext(resource(first));
    assert.equal(context.workspaceRoot, first); assert.equal(context.pythonPath, firstPython);
    const other = await daemon.createLaunchContext(resource(second));
    assert.equal(other.workspaceRoot, second); assert.equal(other.pythonPath, secondPython);
    await daemon.stop(); cases++;
  }
  {
    const daemon = daemonFixture();
    const previous = await daemon.createLaunchContext(resource(first));
    daemon.lastLaunchContext = { ...previous, pythonPath: external };
    daemon.currentState = { phase: 'error', capabilities: [], workspaceRoot: first };
    daemon.stopRequested = false; // A requested start failed its compatibility check.
    const restarts: any[] = [];
    daemon.restart = async (scope: any) => {
      restarts.push(scope); daemon.lastLaunchContext = await daemon.createLaunchContext(scope);
      daemon.currentState = { phase: 'ready', capabilities: [] }; return daemon.currentState;
    };
    await Promise.all(Array.from({ length: 32 }, () => daemon.restartIfInterpreterChanged()));
    assert.equal(restarts.length, 1, 'Late environment readiness recovers a failed start exactly once');
    assert.equal(daemon.lastLaunchContext.pythonPath, firstPython);
    assert.equal(restarts[0].fsPath, resource(first).fsPath, 'Recovery retains its original workspace scope');
    await daemon.stop(); cases++;
  }
  {
    const daemon = daemonFixture();
    daemon.lastLaunchContext = await daemon.createLaunchContext(resource(first));
    daemon.currentState = { phase: 'error', capabilities: [] };
    let retries = 0; daemon.restart = async () => { retries++; };
    await daemon.restartIfInterpreterChanged();
    assert.equal(retries, 0, 'An unchanged failing interpreter must not create a readiness restart loop');
    const held = deferred<any>();
    daemon.createLaunchContext = () => held.promise;
    const pending = daemon.restartIfInterpreterChanged();
    await daemon.stop(); held.resolve({ ...daemon.lastLaunchContext, pythonPath: external }); await pending;
    assert.equal(retries, 0, 'Stopping a session revokes an in-flight environment reconciliation'); cases++;
  }
  {
    const daemon = daemonFixture();
    daemon.lastLaunchContext = await daemon.createLaunchContext(resource(first));
    daemon.currentState = { phase: 'ready', capabilities: [] };
    const stopped = deferred(); daemon.terminateProcess = () => stopped.promise;
    let retries = 0; daemon.restart = async () => { retries++; };
    const stopping = daemon.stop();
    await daemon.restartIfInterpreterChanged();
    assert.equal(retries, 0, 'Environment readiness cannot undo an explicit stop while teardown is pending');
    stopped.resolve(); await stopping; cases++;
  }
  {
    const daemon = daemonFixture();
    const held = deferred();
    daemon.pythonCompatibility.check = () => held.promise;
    const starting = daemon.start(resource(first));
    await flush(); await daemon.stop(); held.resolve();
    await assert.rejects(starting, /inactive daemon session/);
    assert.equal(spawnCalls, 0, 'A stopped compatibility check must never launch a daemon later'); cases++;
  }
  {
    const daemon = daemonFixture();
    daemon.pythonCompatibility.check = async () => { throw new Error('Python 3.9 is incompatible; Python 3.10 or newer is required.'); };
    await assert.rejects(daemon.start(resource(first)), /Python 3.10/);
    assert.equal(daemon.getState().phase, 'error');
    assert.equal(daemon.getState().pythonPath, firstPython);
    assert.equal(spawnCalls, 0, 'An incompatible interpreter is rejected before daemon module imports');
    await daemon.stop(); cases++;
  }
  {
    const ready = deferred(); const activated = deferred<any>(); const selections = new Emitter<any>();
    let activationCalls = 0; const observed: any[] = [];
    const api = { ready: ready.promise, environments: { onDidChangeActiveEnvironmentPath: selections.event } };
    python = { isActive: false, exports: undefined, activate: async () => {
      activationCalls++; const value = await activated.promise; python.isActive = true; python.exports = value; return value;
    } };
    documents.length = 0;
    const registration = changes.registerPythonInterpreterChanges(uri => observed.push(uri), () => {});
    try {
      opened.fire({ languageId: 'typescript', uri: resource(first) }); await flush(); assert.equal(activationCalls, 0);
      const document = { languageId: 'python', uri: resource(first) }; documents.push(document);
      for (let n = 0; n < 32; n++) opened.fire(document);
      assert.equal(activationCalls, 1, 'Python opens share one background activation');
      activated.resolve(api); await flush(); assert.equal(observed.length, 0);
      ready.resolve(); await flush(); assert.equal(observed.length, 1);
      selections.fire({ resource: { uri: resource(second) } });
      assert.equal(observed[1].fsPath, resource(second).fsPath);
    } finally { registration.dispose(); }
    assert.equal(selections.listeners.size + opened.listeners.size + extensionChanges.listeners.size, 0);
    cases++;
  }
  {
    const ready = deferred(); const selections = new Emitter<any>(); let calls = 0;
    python = { isActive: true, exports: { ready: ready.promise, environments: { onDidChangeActiveEnvironmentPath: selections.event } } };
    const registration = changes.registerPythonInterpreterChanges(() => { calls++; }, () => {});
    registration.dispose(); ready.resolve(); await flush();
    assert.equal(calls, 0); assert.equal(selections.listeners.size, 0);
    assert.equal(opened.listeners.size + extensionChanges.listeners.size, 0); cases++;
  }
  console.log(`automatic-interpreter: ${cases} controls passed (selection, workspace ownership, failed-start recovery, cancellation, lazy readiness and listener disposal)`);
}
run().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch(error => { console.error(error); process.exitCode = 1; });
