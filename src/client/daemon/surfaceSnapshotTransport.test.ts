import assert from 'node:assert/strict';
import { SurfaceSnapshotDecoder } from './surfaceSnapshotTransport';
import type { SurfaceIndexChangedNotificationMessage } from '../protocol';

type Payload = NonNullable<SurfaceIndexChangedNotificationMessage['params']>;
const original: Payload = { surfaceIndex: {
  'app.A': { instance: { name: ['scalar', null, 'field', 'CharField'] } },
  'app.B': { queryset: { filter: ['queryset', 'app.B', 'method', null] } },
}, surfaceFingerprints: { 'app.A': 'a1', 'app.B': 'b1' }, modelNames: ['A', 'B'],
  lookupCatalog: { fields: {}, types: {} }, staticFallback: null };
const full = (): Payload => ({ ...original, surfaceTransport: { version: 1, sequence: 1, kind: 'full' } });
const delta = (): Payload => ({ surfaceTransport: { version: 1, sequence: 2, baseSequence: 1, kind: 'delta' },
  surfaceIndexDelta: { 'app.A': { instance: { name: ['scalar', null, 'field', 'TextField'] } } },
  surfaceFingerprints: { 'app.A': 'a2' }, removedSurfaceLabels: [], modelNames: ['A', 'B'],
  lookupCatalog: { fields: {}, types: {} }, staticFallback: null });

const decoder = new SurfaceSnapshotDecoder();
const caller = decoder.decode(full());
delete caller.surfaceIndex!['app.B'];
caller.surfaceFingerprints!['app.B'] = 'caller-only';
const restored = decoder.decode(delta());
assert.deepStrictEqual(restored, { ...original,
  surfaceIndex: { ...original.surfaceIndex, ...delta().surfaceIndexDelta },
  surfaceFingerprints: { ...original.surfaceFingerprints, 'app.A': 'a2' } });
assert.equal(restored.surfaceIndex!['app.B'], original.surfaceIndex!['app.B']);
assert.ok(!('surfaceTransport' in restored) && !('surfaceIndexDelta' in restored));

for (const change of [
  { surfaceTransport: { version: 1, sequence: 3, baseSequence: 0, kind: 'delta' } },
  { surfaceFingerprints: {} }, { removedSurfaceLabels: [2] },
  { surfaceTransport: { version: 2, sequence: 2, kind: 'full' } },
]) {
  const independent = new SurfaceSnapshotDecoder();
  independent.decode(full());
  assert.throws(() => independent.decode({ ...delta(), ...change } as Payload));
}
const missing = new SurfaceSnapshotDecoder();
assert.throws(() => missing.decode(delta()), /baseline/);
missing.decode(full());
missing.reset();
assert.throws(() => missing.decode(delta()), /baseline/);
assert.deepStrictEqual(missing.decode(original), original);
assert.throws(() => missing.decode(delta()), /baseline/);

const removals = new SurfaceSnapshotDecoder();
removals.decode(full());
const removed = removals.decode({ ...delta(), surfaceIndexDelta: { 'app.C': {} },
  surfaceFingerprints: { 'app.C': 'c1' }, removedSurfaceLabels: ['app.A'] });
assert.deepStrictEqual(Object.keys(removed.surfaceIndex!).sort(), ['app.B', 'app.C']);
assert.deepStrictEqual(removed.surfaceFingerprints, { 'app.B': 'b1', 'app.C': 'c1' });
const recovered = removals.decode({ ...original, surfaceTransport: { version: 1, sequence: 9, kind: 'full' } });
assert.deepStrictEqual(recovered, original);
const noFingerprints = { surfaceIndex: original.surfaceIndex, surfaceTransport: { version: 1 as const, sequence: 10, kind: 'full' as const } };
assert.deepStrictEqual(removals.decode(noFingerprints), { surfaceIndex: original.surfaceIndex });
assert.throws(() => removals.decode(delta()), /baseline/);
console.log('surface snapshot transport: full fidelity, root ownership, additions/removals, corruption, missing baseline, legacy/reset and full resync passed');

// A negotiated initialize frame seeds the same independent delta baseline.
(() => {
  const initial = { ...full(), serverName: 'django-orm-intellisense', protocolVersion: '0.1',
    sourceObservationContext: { version: 1, roots: [] },
    futureMetadata: { signature: '(self) -> str', docs: 'all initialize properties survive' } };
  const initialize = new SurfaceSnapshotDecoder();
  const adopted = initialize.decodeInitialize(initial, true);
  assert.equal(initialize.hasBaseline, true);
  assert.equal(adopted.serverName, initial.serverName);
  assert.equal(adopted.sourceObservationContext, initial.sourceObservationContext);
  assert.equal(adopted.futureMetadata, initial.futureMetadata);
  assert.notEqual(adopted.surfaceIndex, initial.surfaceIndex);
  assert.notEqual(adopted.surfaceFingerprints, initial.surfaceFingerprints);
  delete adopted.surfaceIndex!['app.B'];
  adopted.surfaceFingerprints!['app.B'] = 'application-only';
  const next = initialize.decode(delta());
  assert.equal(next.surfaceIndex!['app.B'], original.surfaceIndex!['app.B']);
  assert.equal(next.surfaceFingerprints!['app.B'], 'b1');
  assert.equal(next.surfaceIndex!['app.A'].instance.name[3], 'TextField');

  for (const [frame, ready] of [[initial, false], [original, true],
    [{ ...initial, surfaceFingerprints: {} }, true],
    [{ ...initial, surfaceTransport: { version: 99, sequence: 1, kind: 'full' } }, true],
    [{ ...initial, surfaceTransport: { version: 1, sequence: 0, kind: 'full' } }, true],
    [delta(), true]] as const) {
    const independent = new SurfaceSnapshotDecoder();
    independent.decode(full());
    const result = independent.decodeInitialize(frame as Payload, ready);
    assert.equal(independent.hasBaseline, false);
    assert.deepStrictEqual(result.surfaceIndex, frame.surfaceIndex);
    assert.throws(() => independent.decode(delta()), /baseline/);
  }
  initialize.decodeInitialize(initial, true);
  initialize.reset();
  assert.equal(initialize.hasBaseline, false);
  assert.throws(() => initialize.decode(delta()), /baseline/);
  const empty = { surfaceIndex: {}, surfaceFingerprints: {},
    surfaceTransport: { version: 1 as const, sequence: 5, kind: 'full' as const } };
  initialize.decodeInitialize(empty, true);
  assert.equal(initialize.hasBaseline, true);
})();
console.log('initialize surface baseline: full/legacy/partial/unsupported/unproved/reset/empty and independent future-delta ownership passed');
