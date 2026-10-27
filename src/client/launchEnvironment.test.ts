import * as assert from 'node:assert/strict';
import { fingerprintLaunchEnvironment } from './launchEnvironment';
import { isSurfaceCacheContext, isSurfaceSourceProvenance } from './surfaceSourceProvenance';

const environment = { TOKEN: 'private\nvalue', 빈값: '', '😀': '한글', '\ue000': '=', absent: undefined };
const fingerprint = fingerprintLaunchEnvironment(environment);
assert.equal(fingerprint, fingerprintLaunchEnvironment(Object.fromEntries(Object.entries(environment).reverse())));
assert.match(fingerprint, /^[a-f0-9]{64}$/);
assert.notEqual(fingerprint, fingerprintLaunchEnvironment({ ...environment, TOKEN: 'other' }));
assert.notEqual(fingerprint, fingerprintLaunchEnvironment({ ...environment, absent: '' }));
assert.notEqual(fingerprintLaunchEnvironment({ AB: 'C' }), fingerprintLaunchEnvironment({ A: 'BC' }));
const context = { owner: '1', workspaceRoot: '/project', pythonPath: '/python', settingsModule: null,
  launchEnvironmentFingerprint: fingerprint };
const proof = { version: 2, fingerprintVersion: 2, membershipVersion: 1, root: '/project', extraRoots: [],
  sourceFingerprint: 'a'.repeat(64), membershipFingerprint: 'b'.repeat(64), requestedSettingsModule: null,
  launchEnvironmentFingerprint: fingerprint, interpreter: { path: '/python', realPath: '/python',
    identity: ['1', '2', '3', '4', '5'] } };
assert.ok(isSurfaceCacheContext(context));
assert.ok(isSurfaceSourceProvenance(proof));
for (const invalid of [undefined, '', 'private', 'A'.repeat(64), 123]) {
  assert.ok(!isSurfaceCacheContext({ ...context, launchEnvironmentFingerprint: invalid }));
  assert.ok(!isSurfaceSourceProvenance({ ...proof, launchEnvironmentFingerprint: invalid }));
}
assert.ok(!isSurfaceSourceProvenance({ ...proof, version: 1 }));
console.log('launch environment: stable complete hashing, undefined/empty distinction and fail-closed ownership passed');
