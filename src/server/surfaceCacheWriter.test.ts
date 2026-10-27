import * as assert from 'node:assert/strict';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { SurfaceCacheWriter } from './surfaceCacheWriter';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function main(): Promise<void> {
  {
    const calls: string[] = [], done = deferred();
    const writer = new SurfaceCacheWriter<string>(async value => { calls.push(value); done.resolve(); }, 15);
    writer.schedule('obsolete');
    await delay(5);
    writer.schedule('latest');
    await delay(5);
    assert.deepEqual(calls, [], 'each update restarts the quiet interval');
    await done.promise;
    assert.deepEqual(calls, ['latest']);
    console.log('PASS: only the latest request after the quiet interval is written');
  }
  {
    const calls: number[] = [], started = deferred(), release = deferred(), done = deferred();
    let active = 0, maximum = 0;
    const writer = new SurfaceCacheWriter<number>(async value => {
      active++; maximum = Math.max(maximum, active); calls.push(value);
      if (value === 0) { started.resolve(); await release.promise; }
      active--;
      if (value === 16) done.resolve();
    }, 1);
    writer.schedule(0); await started.promise;
    for (let value = 1; value <= 16; value++) { writer.schedule(value); await delay(5); }
    assert.deepEqual(calls, [0]);
    release.resolve(); await done.promise;
    assert.deepEqual(calls, [0, 16], 'obsolete ready requests must not accumulate behind an active save');
    assert.equal(maximum, 1, 'writes to the same cache path never overlap');
    console.log('PASS: a held save plus16 ready updates writes only first/latest with one active writer');
  }
  {
    const calls: string[] = [], started = deferred(), release = deferred(), done = deferred();
    const writer = new SurfaceCacheWriter<string>(async value => {
      calls.push(value);
      if (value === 'active') { started.resolve(); await release.promise; }
      else done.resolve();
    }, 25);
    writer.schedule('active'); await started.promise;
    writer.schedule('new'); release.resolve(); await nextTurn();
    assert.deepEqual(calls, ['active'], 'finishing a save must not bypass the latest quiet interval');
    await done.promise;
    assert.deepEqual(calls, ['active', 'new']);
    console.log('PASS: active completion preserves the pending quiet interval');
  }
  {
    const calls: string[] = [], started = deferred(), release = deferred(), done = deferred();
    const writer = new SurfaceCacheWriter<string>(async value => {
      calls.push(value);
      if (value === 'active') { started.resolve(); await release.promise; }
      else done.resolve();
    }, 15);
    writer.schedule('active'); await started.promise;
    writer.schedule('retired'); await delay(25);
    writer.clear(); writer.schedule('new-session');
    release.resolve(); await nextTurn();
    assert.deepEqual(calls, ['active'], 'retired ready work must not revive against a new session');
    await done.promise;
    assert.deepEqual(calls, ['active', 'new-session']);
    console.log('PASS: clear revokes ready pending work without bypassing a new session timer');
  }
  {
    const calls: string[] = [], done = deferred();
    const writer = new SurfaceCacheWriter<string>(async value => { calls.push(value); done.resolve(); }, 1);
    writer.schedule('cancelled'); writer.clear(); await delay(5);
    assert.deepEqual(calls, []);
    writer.schedule('restart'); await done.promise;
    assert.deepEqual(calls, ['restart']);
    console.log('PASS: clear cancels an unstarted timer and allows a later save');
  }
  {
    const calls: string[] = [], started = deferred(), release = deferred(), done = deferred();
    const writer = new SurfaceCacheWriter<string>(async value => {
      calls.push(value);
      if (value === 'failure') { started.resolve(); await release.promise; throw new Error('held failure'); }
      done.resolve();
    }, 1);
    writer.schedule('failure'); await started.promise;
    writer.schedule('recovery'); await delay(5);
    release.resolve(); await done.promise;
    assert.deepEqual(calls, ['failure', 'recovery']);
    console.log('PASS: a failed active write does not discard the latest ready request');
  }
  {
    const calls: string[] = [], done = deferred();
    const writer = new SurfaceCacheWriter<string>(value => {
      calls.push(value);
      if (value === 'failure') throw new Error('synchronous failure');
      done.resolve(); return Promise.resolve();
    }, 1);
    writer.schedule('failure'); await delay(5);
    writer.schedule('recovery'); await done.promise;
    assert.deepEqual(calls, ['failure', 'recovery']);
    console.log('PASS: a synchronous write error does not poison later saves');
  }
  {
    const calls: string[] = [], done = deferred();
    const writer = new SurfaceCacheWriter<string>(async value => {
      calls.push(value);
      if (value === 'first') writer.schedule('reentrant');
      else done.resolve();
    }, 1);
    writer.schedule('first'); await done.promise;
    assert.deepEqual(calls, ['first', 'reentrant']);
    console.log('PASS: a request scheduled during a write is retained');
  }
}

const watchdog = setTimeout(() => {
  console.error('Surface cache writer tests did not complete');
  process.exitCode = 1;
}, 5000);
void main().then(() => clearTimeout(watchdog), error => {
  clearTimeout(watchdog);
  console.error(error);
  process.exitCode = 1;
});
