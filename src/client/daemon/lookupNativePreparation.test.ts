// Exercise the compiled daemon and native wrapper at the source-location race.
// The asynchronous native binding is held so the foreground fallback is observable.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getEventListeners } from 'node:events';

const workspaceRoot = '/fixture/project';
const fieldPath = '/fixture/project/blog/models.py';

async function fixture(startPreparation = true) {
  const timers = new Set<NodeJS.Timeout>();
  let finishNative!: (ok: boolean) => void;
  let prepared = false;
  let nativeTasks = 0;
  let nativeQueries = 0;
  let pythonCalls = 0;
  const pythonDispatches: Array<{ at: number; deadline: number | undefined }> = [];
  const binding = {
    nativeInitFromSurfaceChunksAsync: async () => ({ modelCount: 1, fieldCount: 1, edgeCount: 0, elapsedMs: 0, rebuilt: true }),
    nativeEnsureAstModules: () => {
      nativeTasks++;
      return new Promise<boolean>(resolve => { finishNative = ok => { prepared = ok; resolve(ok); }; });
    },
    // The native invalidation fence retains stored field locations. The JS
    // generation owner must prevent retrying those locations after a reset.
    nativeInvalidateAstModules() {},
    nativeDrop() {},
    nativeResolveLookupPath: (_model: string, value: string) => {
      nativeQueries++;
      if (value === 'title__custom') return Buffer.from(JSON.stringify({ resolved: false, reason: 'unknown_lookup' }));
      return Buffer.from(JSON.stringify({
        resolved: true, baseModelLabel: 'blog.Post', lookupOperator: 'icontains',
        target: { name: 'title', modelLabel: 'blog.Post', fieldKind: 'CharField',
          filePath: prepared ? fieldPath : '', line: prepared ? 7 : 0, column: prepared ? 4 : 0 },
      }));
    },
  };
  const context = vm.createContext({
    console, Buffer, performance, AbortController, setImmediate, clearImmediate,
    process: { env: {} },
    setTimeout: (callback: () => void, delay: number) => {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer: NodeJS.Timeout) => { timers.delete(timer); clearTimeout(timer); },
  });
  const load = (name: string, imports: Record<string, unknown>): any => {
    const nodeRequire = createRequire(name);
    const module = { exports: {} };
    const require = (id: string): unknown => Object.hasOwn(imports, id) ? imports[id] : nodeRequire(id);
    const wrapper = vm.runInContext(
      `(function(exports, require, module, __filename, __dirname) {\n${fs.readFileSync(name, 'utf8')}\n})`, context
    );
    wrapper(module.exports, require, module, name, path.dirname(name));
    return module.exports;
  };
  const native = load(path.join(__dirname, 'nativeFastPath.js'), {
    '../native/loader': { tryLoadNative: () => binding },
  }) as typeof import('./nativeFastPath');
  const { AnalysisDaemon } = load(path.join(__dirname, 'analysisDaemon.js'), {
    vscode: {}, '../config/settings': {}, '../python/interpreter': {}, './nativeFastPath': native,
  }) as typeof import('./analysisDaemon');
  // No process is started. Only the external IPC edge is substituted; the
  // real daemon routing, async contexts and native preparation owner execute.
  const daemon: any = Object.create(AnalysisDaemon.prototype);
  Object.assign(daemon, {
    lastLaunchContext: { workspaceRoot }, sessionRevision: 1,
    requestSourceContext: new AsyncLocalStorage<string>(),
    documentContext: new AsyncLocalStorage<string>(), projectContexts: [],
    abortSignalContext: new AsyncLocalStorage<AbortSignal>(),
    deadlineContext: new AsyncLocalStorage<number>(),
    currentState: { runtime: { bootstrapStatus: 'ready' } },
    cachedRequest: async () => { pythonCalls++; pythonDispatches.push({ at: performance.now(), deadline: daemon.deadlineContext.getStore() }); return { resolved: false, reason: 'python_fallback' }; },
  });
  await native.hydrateNativeFastPathFromSurface({ workspaceRoot, surfaceIndex: {
    'blog.Post': { instance: { title: ['scalar', null, 'field', 'CharField'] }, manager: {}, queryset: {} },
  } });
  let preparation: Promise<boolean> | undefined;
  if (startPreparation) {
    preparation = native.ensureNativeAstModules(workspaceRoot);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(nativeTasks, 1, 'The native source preparation is already in flight');
  }
  return {
    daemon, native, timers,
    query(source = 'hover', signal?: AbortSignal, deadline?: number, value = 'title__icontains'): Promise<any> {
      const run = () => daemon.resolveLookupPath('blog.Post', value, 'filter');
      return daemon.withRequestSource(source, () => {
        const timed = () => deadline === undefined ? run() : daemon.withDeadline(deadline, run);
        return signal ? daemon.withAbortSignal(signal, timed) : timed();
      });
    },
    get pythonCalls() { return pythonCalls; },
    get pythonDispatches() { return pythonDispatches; },
    get nativeTasks() { return nativeTasks; },
    get nativeQueries() { return nativeQueries; },
    finish(ok = true) { finishNative?.(ok); },
    async dispose() {
      finishNative?.(false);
      await preparation;
      native.dropNativeFastPath();
      assert.equal(timers.size, 0, 'Every preparation waiter releases its deadline timer');
    },
  };
}

async function withoutPreparationWait<T>(pending: Promise<T>): Promise<T> {
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, true, 'This lookup must finish while the native task is still held');
  return pending;
}

async function main(): Promise<void> {
  {
    const test = await fixture();
    try {
      const hover = test.query('hover');
      const definition = test.query('definition');
      assert.equal(test.pythonCalls, 0,
        'A foreground location-less hit must join the running native preparation before starting Python IPC');
      test.finish();
      for (const result of await Promise.all([hover, definition])) {
        assert.equal(result.resolved, true);
        assert.equal(result.target?.filePath, fieldPath);
        assert.equal(result.target?.line, 7);
        assert.equal(result.target?.column, 4);
        assert.equal(result.target?.fieldKind, 'CharField');
      }
      assert.equal(test.pythonCalls, 0);
      assert.equal(test.nativeTasks, 1, 'Foreground waiters share the existing preparation');
    } finally { await test.dispose(); }
  }
  {
    const test = await fixture();
    const controller = new AbortController();
    try {
      const cancelled = test.query('hover', controller.signal);
      const live = test.query('definition');
      controller.abort();
      await assert.rejects(cancelled, /Aborted/);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      assert.equal(test.pythonCalls, 0);
      test.finish();
      assert.equal((await live).target?.filePath, fieldPath,
        'Cancelling one waiter must preserve native preparation for the other caller');
    } finally { await test.dispose(); }
  }
  {
    const test = await fixture();
    try {
      const deadline = performance.now() + 15;
      await assert.rejects(test.query('hover', undefined, deadline), /Aborted/);
      // A live request may try Python while native source preparation is held.
      // Expiry must prevent a later dispatch, including the next event-loop turn.
      assert.ok(test.pythonCalls <= 1, 'One caller starts at most one fallback');
      assert.ok(test.pythonDispatches.every(call => call.deadline === deadline && call.at < deadline),
        'No fallback may start at or after its deadline');
      const callsAtExpiry = test.pythonCalls;
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(test.pythonCalls, callsAtExpiry, 'Expired lookup cannot start later IPC');
    } finally { await test.dispose(); }
  }
  {
    const test = await fixture();
    try {
      await assert.rejects(test.query('hover', undefined, performance.now() - 1), /Aborted/);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(test.pythonCalls, 0, 'An already-expired lookup never starts IPC');
    } finally { await test.dispose(); }
  }
  {
    const test = await fixture();
    try {
      const pending = test.query();
      test.daemon.sessionRevision++;
      await assert.rejects(pending, /inactive|session/i);
      assert.equal(test.pythonCalls, 0, 'A queued old fallback cannot enter a replacement session');
      assert.equal(test.nativeTasks, 1, 'The existing shared native preparation is preserved');
    } finally { await test.dispose(); }
  }
  {
    const test = await fixture();
    const controller = new AbortController();
    controller.abort();
    try {
      await assert.rejects(test.query('hover', controller.signal), /Aborted/);
      assert.equal(test.pythonCalls, 0);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    } finally { await test.dispose(); }
  }
  {
    const test = await fixture();
    try {
      const pending = test.query();
      test.daemon.sessionRevision++;
      test.finish();
      await assert.rejects(pending, /inactive|session/i);
      assert.equal(test.pythonCalls, 0, 'An older session cannot send a fallback into the new session');
      assert.equal(test.nativeQueries, 1, 'An older session cannot requery the new native state');
    } finally { await test.dispose(); }
  }
  {
    const test = await fixture();
    try {
      const result = await withoutPreparationWait(test.query('diagnostic'));
      assert.equal(result.resolved, true);
      assert.equal(result.target?.filePath, '', 'Background resolution does not wait for a display location');
      assert.equal(test.pythonCalls, 0);
    } finally { await test.dispose(); }
  }
  {
    const test = await fixture();
    try {
      const result = await withoutPreparationWait(test.query('hover', undefined, undefined, 'title__custom'));
      assert.equal(result.reason, 'python_fallback', 'Runtime-only lookup keeps the Python path while AST preparation is held');
      assert.equal(test.pythonCalls, 1);
    } finally { await test.dispose(); }
  }
  {
    const test = await fixture();
    try {
      test.daemon.lastLaunchContext.workspaceRoot = '/fixture/other-project';
      assert.equal((await withoutPreparationWait(test.query())).reason, 'python_fallback', 'Never wait on a different workspace native owner');
      assert.equal(test.nativeTasks, 1, 'No preparation is started for the other workspace');
    } finally { await test.dispose(); }
  }
  {
    const test = await fixture();
    try {
      const pending = test.query();
      const invalidation = test.native.ensureNativeAstModules(workspaceRoot).then(() => {
        test.native.resetNativeAstModulesFlag();
      });
      test.finish();
      const result = await pending;
      await invalidation;
      assert.equal(result.reason, 'python_fallback',
        'A source invalidation after waiter fulfillment must preserve the Python fallback');
      assert.equal(test.nativeQueries, 1,
        'Native generation ownership must remain valid across the await handoff before retry');
      assert.equal(test.pythonCalls, 1);
    } finally { await test.dispose(); }
  }
  for (const mode of ['failure', 'invalidation', 'none'] as const) {
    const test = await fixture(mode !== 'none');
    try {
      const pending = test.query();
      if (mode === 'invalidation') test.native.resetNativeAstModulesFlag();
      test.finish(mode !== 'failure');
      assert.equal((await pending).reason, 'python_fallback');
      assert.equal(test.pythonCalls, 1, `${mode}: preserve the Python fallback`);
      if (mode === 'none') assert.equal(test.nativeTasks, 0, 'A lookup must not start native preparation itself');
      if (mode === 'invalidation') assert.equal(test.nativeQueries, 1, 'Invalidated preparation cannot trigger a stale native retry');
    } finally { await test.dispose(); }
  }
  console.log('lookup native preparation OK: foreground source locations, shared work, cancellation, deadline, session replacement, diagnostic fast path and fallback');
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
