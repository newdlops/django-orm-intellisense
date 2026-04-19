// TS → Rust napi → bincode cache round-trip benchmark. Measures the
// full boundary cost (Buffer marshalling + napi call + Rust work +
// mmap + deserialize). Compares to the synthetic Python JSON baseline.
//
// Invoke: node out/client/native/cache.bench.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadNative } from './loader';

function percentile(sorted: number[], p: number): number {
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx];
}

function makePayload(nModels: number): Buffer {
  const models = [];
  for (let i = 0; i < nModels; i++) {
    const fields = [];
    for (let f = 0; f < 20; f++) {
      fields.push({ name: `field_${f}`, kind: 'CharField', nullable: false });
    }
    models.push({
      appLabel: `app${Math.floor(i / 50)}`,
      objectName: `Model${i}`,
      module: `app${Math.floor(i / 50)}.models`,
      filePath: `/ws/app${Math.floor(i / 50)}/model_${i}.py`,
      fields,
      bases: ['models.Model'],
    });
  }
  return Buffer.from(JSON.stringify({ models }));
}

function makeMeta(): Buffer {
  return Buffer.from(JSON.stringify({ schema: 14, workspaceRoot: '/ws', fingerprint: 'abc' }));
}

function run(scale: number, runs: number): void {
  const n = loadNative();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'django-orm-bench-'));
  const cachePath = path.join(tmpDir, `scale_${scale}.bin`);
  const meta = makeMeta();
  const payload = makePayload(scale);

  // warm-up
  n.saveCacheBlob(cachePath, meta, payload);

  const saveMs: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    n.saveCacheBlob(cachePath, meta, payload);
    saveMs.push(performance.now() - t);
  }

  const loadMs: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    const hit = n.loadCacheBlob(cachePath);
    if (!hit) throw new Error('unexpected miss');
    loadMs.push(performance.now() - t);
  }

  saveMs.sort((a, b) => a - b);
  loadMs.sort((a, b) => a - b);
  const size = fs.statSync(cachePath).size;
  console.log(
    `scale=${String(scale).padStart(5)} size=${String(size).padStart(10)}B  ` +
      `save p50=${percentile(saveMs, 0.5).toFixed(2).padStart(6)}ms ` +
      `p95=${percentile(saveMs, 0.95).toFixed(2).padStart(6)}ms  ` +
      `load p50=${percentile(loadMs, 0.5).toFixed(2).padStart(6)}ms ` +
      `p95=${percentile(loadMs, 0.95).toFixed(2).padStart(6)}ms`,
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function main(): void {
  const runs = 50;
  console.log(`--- TS→napi→bincode cache bench (runs=${runs}) ---`);
  for (const scale of [100, 500, 1500, 5000, 15000]) {
    run(scale, runs);
  }
}

main();
