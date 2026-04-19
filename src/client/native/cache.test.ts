// E2E smoke test: TS calls Rust cache save/load via napi.
// Invoke: node out/client/native/cache.test.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadNative } from './loader';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function main(): void {
  const n = loadNative();
  assert(n.cacheSchemaVersion() === 14, 'expected schema v14');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'django-orm-cache-'));
  const cachePath = path.join(tmpDir, 'cache.bin');

  const meta = Buffer.from(JSON.stringify({ workspaceRoot: '/ws', fp: 'abc123' }));
  const payload = Buffer.from(JSON.stringify({ models: ['app.Model1', 'app.Model2'] }));

  n.saveCacheBlob(cachePath, meta, payload);
  assert(fs.existsSync(cachePath), 'cache file created');

  const hit = n.loadCacheBlob(cachePath);
  assert(hit !== null, 'expected cache hit');
  assert(hit.metadata.equals(meta), 'metadata round-trips');
  assert(hit.payload.equals(payload), 'payload round-trips');

  const missPath = path.join(tmpDir, 'absent.bin');
  const miss = n.loadCacheBlob(missPath);
  assert(miss === null, 'missing file returns null');

  // Workspace cache dir is stable across calls.
  const root = '/tmp/cache';
  const ws = '/Users/alice/project-django';
  const d1 = n.workspaceCacheDir(root, ws);
  const d2 = n.workspaceCacheDir(root, ws);
  assert(d1 === d2, 'workspace cache dir deterministic');
  assert(d1.startsWith(root), 'rooted under cache_root');

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`cache napi bindings OK (schema=v${n.cacheSchemaVersion()})`);
}

main();
