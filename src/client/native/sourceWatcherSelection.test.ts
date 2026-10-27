import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { createSourceObservation } from '../sourceObservation';
import type { NativePathSelection, NativeSourceBindings, NativeSourceHandle } from './sourceWatcher';

const supported = process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch);

function withBindings(bindings: NativeSourceBindings,
  run: (api: typeof import('./sourceWatcher')) => void): void {
  const moduleLoader = require('node:module') as { _load: (...args: unknown[]) => unknown };
  const original = moduleLoader._load;
  const id = require.resolve('./sourceWatcher'), previous = require.cache[id];
  delete require.cache[id];
  moduleLoader._load = function(this: unknown, request: unknown, ...args: unknown[]): unknown {
    if (typeof request === 'string' && request.endsWith(path.sep + 'source-watcher.node')) return bindings;
    return Reflect.apply(original, this, [request, ...args]);
  };
  try { run(require(id) as typeof import('./sourceWatcher')); }
  finally {
    moduleLoader._load = original;
    delete require.cache[id];
    if (previous) require.cache[id] = previous;
  }
}

function fixture(capability?: number): {bindings: NativeSourceBindings; calls: unknown[][]} {
  const calls: unknown[][] = [];
  const bindings: NativeSourceBindings = {
    watermark: () => '1', liveStreams: () => 0, pathObservationVersion: () => 1,
    start(...args: unknown[]): NativeSourceHandle {
      calls.push(args);
      let closed = false;
      return {dispose: () => {closed = true;}, state: () => ({closed,
        pendingBytes: 0, pendingEvents: 0, capacityBytes: 65536, capacityEvents: 256, rescan: false})};
    },
  };
  if (capability !== undefined) bindings.pathSelectionVersion = () => capability;
  return {bindings, calls};
}

test('physical path selection forwards every owned hint only to an advertised binding', {skip: !supported}, () => {
  const {bindings, calls} = fixture(1);
  const selection: NativePathSelection = {files: Array.from({length: 5000}, (_, i) => '/selected/file_' + i + '.py'),
    directories: ['/selected/site-packages']};
  withBindings(bindings, api => {
    const delivered: unknown[] = [];
    const handle = api.createNativePathWatcher('/selected', '12', batch => delivered.push(batch), selection);
    assert.ok(handle);
    assert.equal(calls.length, 1); assert.equal(calls[0].length, 6);
    assert.equal(calls[0][4], true); assert.equal(calls[0][5], selection);
    assert.equal((calls[0][5] as NativePathSelection).files.length, 5000);
    const callback = calls[0][3] as (value: unknown) => void;
    const batch = {events: [], rescan: true, baseChanged: false, historyDone: false};
    callback(batch); assert.deepEqual(delivered, [batch]);
    handle.dispose(); callback(batch); assert.deepEqual(delivered, [batch]);
    assert.equal(handle.state().capacityEvents, 256);
    assert.equal(handle.state().capacityBytes, 65536);
  });
});

test('older and unknown selection capabilities retain unfiltered physical observation', {skip: !supported}, () => {
  for (const version of [undefined, 0, 2]) {
    const {bindings, calls} = fixture(version);
    withBindings(bindings, api => {
      const handle = api.createNativePathWatcher('/selected', undefined, () => {}, {files: [], directories: []});
      assert.ok(handle); assert.equal(calls[0].length, 5); assert.equal(calls[0][4], true);
      handle.dispose();
    });
  }
});

test('selection does not substitute for missing physical observation support', {skip: !supported}, () => {
  const {bindings, calls} = fixture(1); bindings.pathObservationVersion = () => 0;
  withBindings(bindings, api => {
    assert.equal(api.createNativePathWatcher('/selected', '12', () => {}, {files: [], directories: []}), undefined);
    assert.deepEqual(calls, []);
  });
});

test('physical observation owns complete hint arrays and releases them on disposal', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'djls-observation-selection-'));
  let handle: ReturnType<typeof createSourceObservation>;
  try {
    const metadata = path.join(temporary, 'site-packages'); fs.mkdirSync(metadata);
    const configuration = path.join(temporary, 'pyvenv.cfg'); fs.writeFileSync(configuration, 'version = 3.12\n');
    const target = path.join(temporary, 'opaque.bin'); fs.writeFileSync(target, 'value = 1\n');
    const logical = path.join(temporary, 'source.py');
    const plan = {configurationFiles: [configuration], sitePackages: [metadata],
      sourceFiles: [{target, sources: [logical]}]};
    const selections: NativePathSelection[] = [];
    handle = createSourceObservation(plan, '1', () => true,
      {configurationChanged: () => {}, sourceChanged: () => {}, reconcile: () => {}},
      error => {throw error;}, (_root, _boundary, _callback, hints) => {
        assert.ok(hints); selections.push(hints);
        return fixture().bindings.start('/unused', null, [], () => {});
      });
    assert.ok(handle); const selection = selections[0]; assert.ok(selection);
    assert.deepEqual([...selection.files].sort(), [fs.realpathSync.native(configuration), fs.realpathSync.native(target)].sort());
    assert.deepEqual(selection.directories, [fs.realpathSync.native(metadata)]);
    handle.dispose();
    assert.deepEqual(selection.files, []); assert.deepEqual(selection.directories, []);
    assert.deepEqual(plan.configurationFiles, [configuration]);
    assert.deepEqual(plan.sitePackages, [metadata]);
    assert.deepEqual(plan.sourceFiles, [{target, sources: [logical]}]);
  } finally { handle?.dispose(); fs.rmSync(temporary, {recursive: true, force: true}); }
});
