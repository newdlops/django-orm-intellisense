'use strict';
// Actual NAPI worker cache save, using complete archived daemon payload bytes.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

async function worker(addonPath, payloadPath, mode) {
  const addon = require(path.resolve(addonPath));
  assert.equal(addon.cacheSchemaVersion(), 14);
  const payload = fs.readFileSync(payloadPath);
  const metadata = Buffer.from(JSON.stringify({ workspaceRoot: '/benchmark/full-payload', fingerprint: 'complete' }));
  const chunks = [];
  for (let start = 0; start < payload.length; start += 32768) chunks.push(payload.subarray(start, start + 32768));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djls-cache-chunk-bench-'));
  const target = path.join(root, 'cache.bin');
  try {
    global.gc();
    const baseline = process.memoryUsage(), cpu = process.cpuUsage(), started = performance.now();
    let maxRss = baseline.rss, maxHeap = baseline.heapUsed, ticks = 0, maxGapMs = 0, last = started;
    const observe = () => {
      const now = performance.now(), memory = process.memoryUsage();
      maxGapMs = Math.max(maxGapMs, now-last);
      last = now;
      maxRss = Math.max(maxRss, memory.rss);
      maxHeap = Math.max(maxHeap, memory.heapUsed);
      ticks++;
    };
    const timer = setInterval(observe, 1);
    try {
      if (mode === 'async') await addon.saveCacheBlobChunksAsync(target, metadata, chunks);
      else addon.saveCacheBlob(target, metadata, payload);
    } finally { clearInterval(timer); }
    const elapsedMs = performance.now()-started, usage = process.cpuUsage(cpu);
    observe();
    const afterSave = process.memoryUsage();
    const file = fs.readFileSync(target);
    const hit = addon.loadCacheBlob(target);
    assert.ok(hit);
    assert.deepEqual(hit.metadata, metadata);
    assert.deepEqual(hit.payload, payload);
    const digest = value => crypto.createHash('sha256').update(value).digest('hex');
    return { mode, payloadPath, payloadBytes: payload.length, chunkCount: chunks.length,
      payloadSha256: digest(payload), envelopeSha256: digest(file), envelopeBytes: file.length,
      elapsedMs, cpuMs: (usage.user+usage.system)/1000, ticks, maxGapMs,
      baseline, afterSave, observedRssDeltaBytes: maxRss-baseline.rss,
      observedHeapDeltaBytes: maxHeap-baseline.heapUsed, fullBytesEqual: true,
      scope: 'One fresh actual NAPI cache save; input buffers loaded before baseline. Async1ms RSS/heap boundary samples, synchronous only before/after. Native allocations/process RSS sampled, not true peak or per-allocation attribution. Exact old-format envelope SHA and load bytes checked after measurement; load/GC harness excluded. No ordinary startup/editor/aggregate claim.' };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function runWorker(addon, payload, mode) {
  const child = spawn(process.execPath, ['--expose-gc', __filename, '--worker', addon, payload, mode],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', stderr = '';
  child.stdout.on('data', value => { output += value; });
  child.stderr.on('data', value => { stderr += value; });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve({ code, signal })
      : reject(Error(`Cache worker exited ${code}/${signal}: ${stderr}`)));
  });
  return { ...JSON.parse(output), exit: result };
}

async function main() {
  if (process.argv[2] === '--worker') {
    console.log(JSON.stringify(await worker(...process.argv.slice(3))));
    return;
  }
  const addon = process.argv[2], payloads = process.argv.slice(3);
  assert.ok(addon && payloads.length);
  const rows = [];
  for (const payload of payloads) {
    const samples = [];
    for (let round = 0; round < 5; round++) {
      for (const mode of round % 2 ? ['sync', 'async'] : ['async', 'sync']) {
        samples.push(await runWorker(addon, payload, mode));
      }
    }
    assert.equal(new Set(samples.map(sample => sample.envelopeSha256)).size, 1);
    const keys = ['elapsedMs', 'cpuMs', 'observedRssDeltaBytes', 'observedHeapDeltaBytes', 'maxGapMs'];
    rows.push({ payload, payloadBytes: samples[0].payloadBytes, samples,
      summary: Object.fromEntries(['sync', 'async'].map(mode => [mode, Object.fromEntries(keys.map(key => {
        const sorted = samples.filter(sample => sample.mode === mode).map(sample => sample[key]).sort((a,b) => a-b);
        return [key, sorted[Math.floor(sorted.length/2)]];
      }))])) });
  }
  console.log(JSON.stringify({ date: '2026-10-09', nodeVersion: process.version,
    addonPath: path.resolve(addon), addonSha256: crypto.createHash('sha256').update(fs.readFileSync(addon)).digest('hex'),
    profile: 'dev', repetitions: 5, rows,
    scope: 'Sequential fresh actual Node/NAPI sync and async cache saves per complete archived configured payload. Five samples per mode. Exact payload/envelope bytes and clean worker exits verified. Observed RSS differences include native allocator; async timer sampling lower bound and sync endpoint only. No true native allocator maximum, all-process/editor/stable startup claim.' }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
