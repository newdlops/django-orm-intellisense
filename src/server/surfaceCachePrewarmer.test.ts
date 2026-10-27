import * as assert from 'node:assert/strict';
import { SurfaceCachePrewarmer } from './surfaceCachePrewarmer';
import type { SurfaceCacheContext } from '../client/surfaceSourceProvenance';

async function main(): Promise<void> {
  const first: SurfaceCacheContext = { owner: '1', workspaceRoot: '/root', pythonPath: '/python', settingsModule: null,
    launchEnvironmentFingerprint: 'e'.repeat(64) };
  const loads: Array<{ context: SurfaceCacheContext; resolve(value: string | null): void }> = [];
  const applied: string[] = [];
  let resident = false;
  const cache = new SurfaceCachePrewarmer<string>({
    load: context => new Promise(resolve => { loads.push({ context, resolve }); }),
    hasResident: () => resident,
    apply: value => { applied.push(value); resident = true; },
  });
  const drain = () => new Promise<void>(resolve => setImmediate(resolve));
  cache.update(first);
  assert.equal(loads.length, 1);
  resident = true; cache.invalidate(); // An authoritative frame wins during read.
  loads[0].resolve('old'); await drain();
  assert.deepEqual(applied, []);
  resident = false;
  cache.update({ ...first, owner: '2' });
  cache.invalidate(); // Retirement wins even if the root later repeats.
  loads[1].resolve('retired'); await drain();
  assert.deepEqual(applied, []);
  cache.update({ ...first, owner: '3' });
  cache.update({ ...first, owner: '4', workspaceRoot: '/other' });
  cache.update({ ...first, owner: '5' }); // Same root, a new owner (ABA).
  assert.equal(loads.length, 3, 'one worker remains active during context churn');
  loads[2].resolve('owner3'); await drain();
  assert.equal(loads.length, 4, 'only the latest pending context is read');
  assert.equal(loads[3].context.owner, '5');
  assert.deepEqual(applied, []);
  loads[3].resolve('owner5'); await drain();
  assert.deepEqual(applied, ['owner5']);
  cache.update({ ...first, owner: '6' }); await drain();
  assert.equal(loads.length, 4, 'a resident frame prevents more prewarm work');
  resident = false;
  cache.update({ ...first, owner: '7' });
  cache.update(null);
  loads[4].resolve('disabled'); await drain();
  assert.deepEqual(applied, ['owner5']);
  console.log('native prewarm: authoritative/retirement/null/ABA guards, one active and latest pending, valid reuse passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
