import * as assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { SurfaceCacheContextDelivery, SurfacePublisher, type SurfaceUpdateMethod } from './surfacePublisher';
import { SurfaceSnapshotDecoder } from './daemon/surfaceSnapshotTransport';
import type { SurfaceIndexChangedNotificationMessage } from './protocol';

type Snapshot = NonNullable<SurfaceIndexChangedNotificationMessage['params']> & { future?: unknown };
function completeSnapshot(revision: number): Snapshot {
  return {
    surfaceIndex: {
      'app.A': { instance: { [`field${revision}`]: ['scalar', null, 'field', 'IntegerField'] } },
      'app.B': { instance: { title: ['scalar', null, 'field', 'CharField'] } }, 'app.C': {},
    },
    surfaceFingerprints: { 'app.A': `a${revision}`, 'app.B': 'b', 'app.C': 'c' },
    modelNames: ['A', 'B', 'C'], customLookups: { IntegerField: [`lookup${revision}`] },
    customLookupsFingerprint: `registry${revision}`, lookupCatalog: { types: {}, fields: {} },
    staticFallback: null, staticFallbackFingerprint: null,
    future: { complete: ['all', 'metadata', revision] },
  };
}

async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, 'Publisher did not reach the expected transport state');
    await delay(5);
  }
}

async function recoversLatestState(): Promise<void> {
  let snapshot = { fields: ['before'] };
  const messages: Array<{ method: SurfaceUpdateMethod; params: unknown }> = [];
  let rejectDelta = true;
  let errors = 0;
  const publisher = new SurfacePublisher({
    currentScope: () => 'session-a', snapshot: () => snapshot,
    send: async (method, params) => {
      messages.push({ method, params });
      if (method.endsWith('Delta') && rejectDelta) {
        rejectDelta = false;
        throw new Error('transport failed');
      }
      return { applied: true };
    },
    reportFailure: () => { errors++; }, retryDelayMs: 20,
  });
  try {
    publisher.requestFull();
    await until(() => messages.length === 1);
    snapshot = { fields: ['changed'] };
    assert.equal(await publisher.publishDelta({ fields: ['changed'] }, 'session-a'), false);
    snapshot = { fields: ['latest'] };
    assert.equal(await publisher.publishDelta({ fields: ['latest'] }, 'session-a'), false);
    await until(() => messages.length === 3);
    assert.deepEqual(messages[2], { method: 'django/updateSurfaceIndex', params: snapshot });
    assert.equal(errors, 1);
    // Empty state is an authoritative snapshot, including deletion of all models.
    snapshot = { fields: [] };
    publisher.requestFull();
    await until(() => messages.length === 4);
    assert.deepEqual(messages[3].params, { fields: [] });
  } finally { publisher.dispose(); }
}

async function rejectsUnappliedDelta(): Promise<void> {
  let snapshot = { fields: ['old'] };
  const methods: SurfaceUpdateMethod[] = [];
  const publisher = new SurfacePublisher({
    currentScope: () => 'session-a', snapshot: () => snapshot,
    send: async method => {
      methods.push(method);
      return { applied: !method.endsWith('Delta') };
    }, reportFailure: () => {}, retryDelayMs: 10,
  });
  try {
    publisher.requestFull();
    await until(() => methods.length === 1);
    snapshot = { fields: ['new'] };
    assert.equal(await publisher.publishDelta(snapshot, 'session-a'), false);
    await until(() => methods.length === 3);
    assert.deepEqual(methods, ['django/updateSurfaceIndex', 'django/updateSurfaceIndexDelta', 'django/updateSurfaceIndex']);
  } finally { publisher.dispose(); }
}

async function serializesScopeChanges(): Promise<void> {
  let scope = 'old-session';
  const snapshots: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let active = 0;
  let maximum = 0;
  const publisher = new SurfacePublisher({
    currentScope: () => scope, snapshot: () => scope,
    send: async (_, params) => {
      active++;
      maximum = Math.max(maximum, active);
      snapshots.push(params as string);
      try { if (snapshots.length === 1) await gate; }
      finally { active--; }
      return { applied: true };
    }, reportFailure: () => {},
  });
  try {
    publisher.requestFull();
    await until(() => snapshots.length === 1);
    scope = 'new-session';
    publisher.requestFull();
    release();
    await until(() => snapshots.length === 2);
    assert.deepEqual(snapshots, ['old-session', 'new-session']);
    assert.equal(maximum, 1);
    // A queued delta from the old scope must cause a fresh current snapshot.
    assert.equal(await publisher.publishDelta('stale delta', 'old-session'), false);
    await until(() => snapshots.length === 3);
    assert.equal(snapshots[2], 'new-session');
  } finally { release(); publisher.dispose(); }
}

async function waitsForAvailableScope(): Promise<void> {
  let scope: string | undefined;
  let sends = 0;
  const publisher = new SurfacePublisher({
    currentScope: () => scope, snapshot: () => ({}),
    send: async method => { assert.equal(method, 'django/updateSurfaceIndex'); sends++; return { applied: true }; },
    reportFailure: () => {}, retryDelayMs: 5,
  });
  try {
    publisher.requestFull();
    await delay(25);
    assert.equal(sends, 0);
    scope = 'ready';
    assert.equal(await publisher.publishDelta('first delta', scope), true);
    assert.equal(sends, 1);
  } finally { publisher.dispose(); }
}

async function coalescesChangesDuringAcknowledgement(): Promise<void> {
  let revision = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sent: unknown[] = [];
  const publisher = new SurfacePublisher({
    currentScope: () => 'same-session', snapshot: () => revision,
    send: async (_, params) => {
      sent.push(params);
      if (sent.length === 1) await gate;
      return { applied: true };
    }, reportFailure: () => {},
  });
  try {
    publisher.requestFull();
    await until(() => sent.length === 1);
    for (revision = 1; revision <= 100; revision++) publisher.requestFull();
    release();
    await until(() => sent.length === 2);
    assert.deepEqual(sent, [0, 101]);
    await delay(25);
    assert.equal(sent.length, 2, 'State changes must coalesce instead of retaining a snapshot queue');
  } finally { release(); publisher.dispose(); }
}

async function backsOffAndDisposes(): Promise<void> {
  const attempts: number[] = [];
  const publisher = new SurfacePublisher({
    currentScope: () => 'ready', snapshot: () => ({}),
    send: async () => {
      attempts.push(performance.now());
      throw new Error('persistent failure');
    }, reportFailure: () => {}, retryDelayMs: 10, maxRetryDelayMs: 30,
  });
  publisher.requestFull();
  await until(() => attempts.length === 4);
  publisher.dispose();
  assert.ok(attempts[1] - attempts[0] >= 8);
  assert.ok(attempts[2] - attempts[1] >= 18);
  assert.ok(attempts[3] - attempts[2] >= 28);
  await delay(60);
  assert.equal(attempts.length, 4, 'Disposed publishers must stop retrying');
}

async function disposesPendingAcknowledgement(): Promise<void> {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let sends = 0;
  const publisher = new SurfacePublisher({
    currentScope: () => 'ready', snapshot: () => ({}),
    send: async () => { sends++; await gate; return { applied: true }; }, reportFailure: () => {},
  });
  publisher.requestFull();
  await until(() => sends === 1);
  publisher.requestFull();
  publisher.dispose();
  release();
  await delay(25);
  assert.equal(sends, 1);
}

async function serializesConcurrentDeltasAfterAcknowledgement(): Promise<void> {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let active = 0;
  let maximum = 0;
  let fullSends = 0;
  const deltas: number[] = [];
  const publisher = new SurfacePublisher({
    currentScope: () => 'ready', snapshot: () => ({}),
    send: async (method, params) => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        if (method === 'django/updateSurfaceIndex') {
          fullSends++;
          await gate;
        } else {
          deltas.push(params as number);
          await delay(10);
        }
        return { applied: true };
      } finally { active--; }
    }, reportFailure: () => {},
  });
  const requests: Array<Promise<boolean>> = [];
  try {
    publisher.requestFull();
    await until(() => fullSends === 1);
    for (let revision = 0; revision < 40; revision++) requests.push(publisher.publishDelta(revision, 'ready'));
    release();
    assert.ok((await Promise.all(requests)).every(applied => applied));
    assert.equal(maximum, 1, 'Delta callers released from one ACK must recheck the active transport before sending');
    assert.equal(fullSends, 1);
    assert.deepEqual(deltas, Array.from({ length: 40 }, (_, revision) => revision));
  } finally {
    release();
    await Promise.allSettled(requests);
    publisher.dispose();
  }
}

async function negotiatesCompleteSnapshotTransport(): Promise<void> {
  let snapshot = completeSnapshot(0);
  let enabled = false;
  const decoder = new SurfaceSnapshotDecoder();
  const frames: Snapshot[] = [];
  let application: Snapshot | undefined;
  const publisher = new SurfacePublisher({
    currentScope: () => 'ready', snapshot: () => snapshot,
    snapshotTransportEnabled: () => enabled,
    send: async (method, params) => {
      if (method.endsWith('Delta')) {
        // Source replies mutate the public table without becoming a wire baseline.
        Object.assign(application!.surfaceIndex!, (params as Snapshot).surfaceIndexDelta);
      } else {
        frames.push(params as Snapshot);
        application = decoder.decode(params as Snapshot);
        assert.deepStrictEqual(application, snapshot);
      }
      return { applied: true };
    }, reportFailure: error => { throw error; },
  });
  const publish = async (): Promise<void> => {
    const count = frames.length;
    publisher.requestFull();
    await until(() => frames.length === count + 1);
  };
  try {
    await publish();
    assert.equal(frames[0].surfaceTransport, undefined, 'Older server receives the original full snapshot');
    enabled = true;
    await publish();
    assert.equal(frames[1].surfaceTransport?.kind, 'full');
    snapshot = completeSnapshot(1);
    await publish();
    assert.equal(frames[2].surfaceTransport?.kind, 'delta');
    assert.deepStrictEqual(Object.keys(frames[2].surfaceIndexDelta!), ['app.A']);
    assert.ok(!application!.surfaceIndex!['app.A'].instance.field0, 'Whole model replacement removes retired fields');
    await publisher.publishDelta({ surfaceIndexDelta: { 'app.B': {} } }, 'ready');
    await publish();
    assert.deepStrictEqual(frames[3].surfaceIndexDelta, {});
    assert.deepStrictEqual(application, snapshot, 'Public source mutations cannot corrupt the private baseline');
    enabled = false;
    await publish();
    assert.equal(frames[4].surfaceTransport, undefined);
    enabled = true;
    await publish();
    assert.equal(frames[5].surfaceTransport?.kind, 'full', 'Re-enabling after a legacy snapshot starts a fresh baseline');
  } finally { publisher.dispose(); }
}

async function recoversLostSnapshotAcknowledgementAndMissingBaseline(): Promise<void> {
  let snapshot = completeSnapshot(0);
  const decoder = new SurfaceSnapshotDecoder();
  const frames: Snapshot[] = [];
  let complete: Snapshot | undefined;
  let failures = 0;
  let loseAcknowledgement = false;
  const publisher = new SurfacePublisher({
    currentScope: () => 'ready', snapshot: () => snapshot, snapshotTransportEnabled: () => true,
    send: async (_, params) => {
      frames.push(params as Snapshot);
      complete = decoder.decode(params as Snapshot);
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new Error('Applied response was lost');
      }
      return { applied: true };
    }, reportFailure: () => { failures++; }, retryDelayMs: 30,
  });
  try {
    publisher.requestFull();
    await until(() => frames.length === 1);
    snapshot = completeSnapshot(1);
    loseAcknowledgement = true;
    publisher.requestFull();
    await until(() => failures === 1);
    snapshot = completeSnapshot(2);
    await until(() => frames.length === 3);
    assert.equal(frames[1].surfaceTransport?.kind, 'delta');
    assert.equal(frames[2].surfaceTransport?.kind, 'full');
    assert.deepStrictEqual(complete, snapshot, 'Recovery publishes current state without another save');
    decoder.reset();
    snapshot = completeSnapshot(3);
    publisher.requestFull();
    await until(() => frames.length === 5);
    assert.equal(failures, 2);
    assert.equal(frames[3].surfaceTransport?.kind, 'delta');
    assert.equal(frames[4].surfaceTransport?.kind, 'full');
    assert.deepStrictEqual(complete, snapshot);
  } finally { publisher.dispose(); }
}

async function discardsSnapshotBaselineAcrossSessionAcknowledgement(): Promise<void> {
  let scope = 'old-session';
  let snapshot = completeSnapshot(0);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const frames: Snapshot[] = [];
  const publisher = new SurfacePublisher({
    currentScope: () => scope, snapshot: () => snapshot, snapshotTransportEnabled: () => true,
    send: async (_, params) => {
      frames.push(params as Snapshot);
      if (frames.length === 1) await gate;
      return { applied: true };
    }, reportFailure: error => { throw error; },
  });
  try {
    publisher.requestFull();
    await until(() => frames.length === 1);
    scope = 'new-session'; snapshot = completeSnapshot(1);
    publisher.requestFull();
    release();
    await until(() => frames.length === 2);
    assert.equal(frames[1].surfaceTransport?.kind, 'full', 'Old session ACK cannot establish the new session baseline');
    snapshot = completeSnapshot(2); publisher.requestFull();
    await until(() => frames.length === 3);
    assert.equal(frames[2].surfaceTransport?.kind, 'delta');
    assert.equal(frames[2].surfaceTransport?.baseSequence, frames[1].surfaceTransport?.sequence);
  } finally { release(); publisher.dispose(); }
}

async function coalescesContextOwnersWithoutKeepingTheirWaiters(): Promise<void> {
  const delivery = new SurfaceCacheContextDelivery(), owner = {};
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [], settled: string[] = [];
  let active = 0, maximum = 0;
  const send = (key: string) => async (): Promise<void> => {
    calls.push(key); maximum = Math.max(maximum, ++active);
    try { if (key === 'old') await gate; }
    finally { active--; }
  };
  const first = delivery.deliver(owner, 'old', send('old'));
  assert.strictEqual(delivery.deliver(owner, 'old', send('duplicate')), first);
  const requests = [first.then(() => { settled.push('old-success'); }, () => { settled.push('old-retired'); })];
  try {
    for (let revision = 1; revision <= 100; revision++) {
      requests.push(delivery.deliver(owner, String(revision), send(String(revision))).then(
        () => { settled.push(String(revision)); }, () => { settled.push(String(revision) + '-retired'); }));
    }
    await until(() => settled.length === 100);
    assert.deepEqual(calls, ['old'], 'Only the active context request may reach transport before its ACK');
    assert.ok(settled.every(label => label.endsWith('-retired')), 'Old public callers must settle while the underlying request remains held');
    release(); await Promise.all(requests);
    assert.deepEqual(calls, ['old', '100'], 'A burst retains only the latest pending context');
    assert.equal(maximum, 1);
    assert.ok(settled.includes('100'));
    await delivery.deliver(owner, '100', send('already-acknowledged'));
    assert.deepEqual(calls, ['old', '100'], 'Acknowledged current contexts remain coalesced');
  } finally { release(); delivery.dispose(); await Promise.allSettled(requests); }
}

async function keepsSameKeyContextOwnersIndependent(): Promise<void> {
  const delivery = new SurfaceCacheContextDelivery(), firstOwner = {}, nextOwner = {};
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const first = delivery.deliver(firstOwner, 'same-root-and-key', async () => { calls.push('old'); await gate; });
  const oldResult = first.then(() => false, () => true);
  const replacement = delivery.deliver(nextOwner, 'same-root-and-key', async () => { calls.push('new'); });
  try {
    assert.equal(await oldResult, true);
    assert.deepEqual(calls, ['old']);
    release(); await replacement;
    assert.deepEqual(calls, ['old', 'new'], 'A late old-owner ACK cannot satisfy an identical-key replacement owner');
  } finally { release(); delivery.dispose(); }
}

async function disposesContextWaitersBeforeIgnoredCancellationSettles(): Promise<void> {
  const delivery = new SurfaceCacheContextDelivery(), owner = {};
  let release!: () => void, signal: AbortSignal | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const old = delivery.deliver(owner, 'old', async token => { signal = token; calls.push('old'); await gate; });
  const next = delivery.deliver(owner, 'new', async () => { calls.push('new'); });
  delivery.dispose();
  const results = await Promise.allSettled([old, next]);
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.ok(signal?.aborted);
  await delay(0);
  const internal = delivery as unknown as { active?: unknown; current?: unknown; pending?: unknown };
  assert.equal(internal.active, undefined);
  assert.equal(internal.current, undefined);
  assert.equal(internal.pending, undefined);
  release(); await delay(0);
  assert.deepEqual(calls, ['old'], 'Late transport work cannot resurrect a disposed queue');
  await assert.rejects(delivery.deliver(owner, 'after-dispose', async () => { calls.push('disposed'); }));
  assert.deepEqual(calls, ['old']);
}

async function retriesFailedContextWithoutCachingTheFailure(): Promise<void> {
  const delivery = new SurfaceCacheContextDelivery(), owner = {};
  let calls = 0;
  try {
    await assert.rejects(delivery.deliver(owner, 'same-key', () => { calls++; throw new Error('synchronous context failure'); }));
    await delivery.deliver(owner, 'same-key', async () => { calls++; });
    assert.equal(calls, 2);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const failed = delivery.deliver(owner, 'held-failure', async () => { await gate; throw new Error('late failure'); });
    const next = delivery.deliver(owner, 'latest', async () => { calls++; });
    release();
    await assert.rejects(failed); await next;
    assert.equal(calls, 3, 'A superseded transport failure cannot remove the latest queued context');
  } finally { delivery.dispose(); }
}

async function skipsFailureBackoffAfterPublicationOwnerChanges(): Promise<void> {
  let scope = 'old';
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sent: unknown[] = [];
  let failures = 0;
  const publisher = new SurfacePublisher({
    currentScope: () => scope, snapshot: () => scope,
    send: async (_, value) => {
      sent.push(value);
      if (sent.length === 1) { await gate; throw new Error('retired context waiter'); }
      return { applied: true };
    },
    reportFailure: () => { failures++; }, retryDelayMs: 2000,
  });
  try {
    publisher.requestFull(); await until(() => sent.length === 1);
    scope = 'new'; publisher.requestFull(); release();
    await until(() => sent.length === 2, 500);
    assert.deepEqual(sent, ['old', 'new']);
    assert.equal(failures, 0, 'Owner retirement is not a transport failure in the new scope');
  } finally { release(); publisher.dispose(); }
}

async function main(): Promise<void> {
  for (const test of [recoversLatestState, rejectsUnappliedDelta, serializesScopeChanges,
    waitsForAvailableScope, coalescesChangesDuringAcknowledgement, backsOffAndDisposes,
    disposesPendingAcknowledgement, serializesConcurrentDeltasAfterAcknowledgement,
    negotiatesCompleteSnapshotTransport, recoversLostSnapshotAcknowledgementAndMissingBaseline,
    discardsSnapshotBaselineAcrossSessionAcknowledgement,
    coalescesContextOwnersWithoutKeepingTheirWaiters, keepsSameKeyContextOwnersIndependent,
    disposesContextWaitersBeforeIgnoredCancellationSettles, retriesFailedContextWithoutCachingTheFailure,
    skipsFailureBackoffAfterPublicationOwnerChanges]) {
    await test();
    console.log(`PASS: ${test.name}`);
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
