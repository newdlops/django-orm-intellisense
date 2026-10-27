import * as assert from 'node:assert/strict';
import { SurfaceSnapshotEncoder } from './surfaceSnapshotEncoder';
import { SurfaceSnapshotDecoder } from './daemon/surfaceSnapshotTransport';
import type { SurfaceIndexChangedNotificationMessage } from './protocol';

type Payload = NonNullable<SurfaceIndexChangedNotificationMessage['params']>;
const initial: Payload & { future: unknown } = {
  surfaceIndex: {
    'app.A': { instance: { title: ['scalar', null, 'field', 'CharField'], retired: ['scalar', null, 'field', 'IntegerField'] } },
    'app.B': { instance: { value: ['scalar', null, 'field', 'TextField'] } },
    'app.C': {},
  }, surfaceFingerprints: { 'app.A': 'a', 'app.B': 'b', 'app.C': 'c' },
  customLookups: { CharField: ['tenant'] }, customLookupsFingerprint: 'registry',
  lookupCatalog: { types: {}, fields: {} }, modelNames: ['A', 'B', 'C'],
  staticFallback: null, staticFallbackFingerprint: null,
  sourceProvenance: { version: 2, fingerprintVersion: 2, membershipVersion: 1, root: '/workspace', extraRoots: ['/editable'],
    sourceFingerprint: 'a'.repeat(64), membershipFingerprint: 'b'.repeat(64), requestedSettingsModule: 'settings',
    launchEnvironmentFingerprint: 'e'.repeat(64),
    interpreter: { path: '/venv/bin/python', realPath: '/python', identity: ['1', '2', '3', '4', '5'] } },
  health: { phase: 'ready', detail: 'Ready', capabilities: [] }, future: { complete: ['unknown', 'metadata'] },
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const encoder = new SurfaceSnapshotEncoder();
const decoder = new SurfaceSnapshotDecoder();
const first = encoder.prepare(clone(initial))!;
assert.equal(first.payload.surfaceTransport?.kind, 'full');
assert.deepStrictEqual(decoder.decode(first.payload), initial);
assert.ok(encoder.commit(first));

const next = clone(initial);
next.surfaceIndex!['app.A'] = { instance: { renamed: ['scalar', null, 'field', 'IntegerField'] } };
next.surfaceFingerprints!['app.A'] = 'a2';
next.future = { complete: ['new', 'unknown', 'metadata'] };
next.customLookups = { IntegerField: ['registered'] };
next.sourceProvenance = null;
const edited = encoder.prepare(next)!;
assert.equal(edited.payload.surfaceTransport?.kind, 'delta');
assert.deepStrictEqual(Object.keys(edited.payload.surfaceIndexDelta!), ['app.A']);
assert.deepStrictEqual(decoder.decode(edited.payload), next);
assert.ok(encoder.commit(edited));
assert.ok(!next.surfaceIndex!['app.A'].instance.retired);
const notSent = encoder.prepare(next)!;

const table = clone(next);
delete table.surfaceIndex!['app.B']; delete table.surfaceFingerprints!['app.B'];
table.surfaceIndex!['app.D'] = {}; table.surfaceFingerprints!['app.D'] = 'd';
const coverage = encoder.prepare(table)!;
assert.equal(coverage.payload.surfaceTransport?.kind, 'delta');
// Preparing an unsent proposal must not advance the sender's sequence.
assert.equal(coverage.successor.sequence, notSent.successor.sequence);
assert.deepStrictEqual(decoder.decode(coverage.payload), table);
assert.ok(encoder.commit(coverage));

const caller = decoder.decode({ ...table, surfaceTransport: { version: 1, kind: 'full', sequence: coverage.successor.sequence } });
delete caller.surfaceIndex!['app.C']; caller.surfaceFingerprints!['app.C'] = 'application-only';
const unchanged = encoder.prepare(table)!;
assert.deepStrictEqual(decoder.decode(unchanged.payload), table);
assert.ok(encoder.commit(unchanged));
const owned = encoder.prepare(table)!;
table.surfaceFingerprints!['app.C'] = 'caller-mutated';
assert.equal(owned.successor.fingerprints!['app.C'], 'c');
encoder.reset();
assert.equal(encoder.commit(owned), false);

const empty = encoder.prepare({ ...initial, surfaceIndex: {}, surfaceFingerprints: {} })!;
assert.equal(empty.payload.surfaceTransport?.kind, 'full');
assert.deepStrictEqual(decoder.decode(empty.payload).surfaceIndex, {});
assert.ok(encoder.commit(empty));
const missing = encoder.prepare({ surfaceIndex: { 'app.A': {} } })!;
assert.equal(missing.payload.surfaceTransport?.kind, 'full');
assert.deepStrictEqual(decoder.decode(missing.payload), { surfaceIndex: { 'app.A': {} } });
assert.ok(encoder.commit(missing));
assert.equal(encoder.prepare(initial)!.payload.surfaceTransport?.kind, 'full');
assert.equal(encoder.prepare({ surfaceIndex: [] }), undefined);

const lost = new SurfaceSnapshotEncoder();
const lostDecoder = new SurfaceSnapshotDecoder();
const applied = lost.prepare(initial)!;
lostDecoder.decode(applied.payload); // Applied response/ACK was lost.
lost.reset();
const recovery = lost.prepare(next)!;
assert.equal(recovery.payload.surfaceTransport?.kind, 'full');
assert.deepStrictEqual(lostDecoder.decode(recovery.payload), next);
assert.ok(lost.commit(recovery));
assert.deepStrictEqual(lostDecoder.decode(lost.prepare(initial)!.payload), initial);

const ordered = new SurfaceSnapshotEncoder();
assert.ok(ordered.commit(ordered.prepare(initial)!));
const reordered = { ...initial, surfaceIndex: Object.fromEntries(Object.entries(initial.surfaceIndex!).reverse()) };
assert.equal(ordered.prepare(reordered)!.payload.surfaceTransport?.kind, 'full',
  'Changed table order must retain the full snapshot short-name ownership semantics');
console.log('surface snapshot encoder: complete globals, model replacement, add/remove/empty, private roots/fingerprints, reset ownership, missing fingerprints and lost ACK recovery passed');
