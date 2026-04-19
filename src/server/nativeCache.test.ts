// Smoke test for the surface-index native cache round-trip.
// Invoke: node out/server/nativeCache.test.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { saveSurfaceCache, loadSurfaceCache, type SurfaceCachePayload } from './nativeCache';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function makeSurfaceIndex(modelCount: number): SurfaceCachePayload['surfaceIndex'] {
  const out: SurfaceCachePayload['surfaceIndex'] = {};
  for (let i = 0; i < modelCount; i++) {
    const label = `app${Math.floor(i / 50)}.Model${i}`;
    const instance: Record<string, [string, string | null]> = {};
    for (let f = 0; f < 20; f++) {
      instance[`field_${f}`] = ['CharField', null];
    }
    instance[`fk_0`] = [`ForeignKey[app${Math.floor(i / 50)}.Model${(i + 1) % modelCount}]`, 'instance'];
    out[label] = { instance };
  }
  return out;
}

function main(): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'django-orm-surface-cache-'));
  try {
    process.env.DJANGO_ORM_INTELLISENSE_CACHE_DIR = tmpDir;
    const workspaceRoot = '/Users/test/fake-workspace';

    // Cold: miss
    assert(loadSurfaceCache(workspaceRoot) === null, 'initially miss');

    // Save payload
    const payload: SurfaceCachePayload = {
      surfaceIndex: makeSurfaceIndex(1500),
      modelNames: Array.from({ length: 1500 }, (_, i) => `Model${i}`),
      surfaceFingerprints: { 'app0.Model0': 'abc123' },
      customLookups: { 'app.Model0': ['unaccent'] },
      customLookupsFingerprint: 'lookups123',
      staticFallbackFingerprint: 'fallback123',
    };
    const tSave = performance.now();
    saveSurfaceCache(workspaceRoot, payload);
    const saveMs = performance.now() - tSave;

    // Load: hit
    const tLoad = performance.now();
    const loaded = loadSurfaceCache(workspaceRoot);
    const loadMs = performance.now() - tLoad;
    assert(loaded !== null, 'cached after save');
    assert(Object.keys(loaded!.surfaceIndex).length === 1500, 'surfaceIndex preserved');
    assert(loaded!.modelNames.length === 1500, 'modelNames preserved');
    assert(loaded!.surfaceFingerprints?.['app0.Model0'] === 'abc123', 'surfaceFingerprints preserved');
    assert(loaded!.customLookups?.['app.Model0']?.[0] === 'unaccent', 'customLookups preserved');
    assert(loaded!.customLookupsFingerprint === 'lookups123', 'customLookupsFingerprint preserved');
    assert(loaded!.staticFallbackFingerprint === 'fallback123', 'staticFallbackFingerprint preserved');

    // Different workspace → miss
    const otherLoaded = loadSurfaceCache('/other/workspace');
    assert(otherLoaded === null, 'different workspace → miss');

    console.log(
      `surface cache napi OK: save=${saveMs.toFixed(1)}ms load=${loadMs.toFixed(1)}ms ` +
        `models=${Object.keys(loaded!.surfaceIndex).length}`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DJANGO_ORM_INTELLISENSE_CACHE_DIR;
  }
}

main();
