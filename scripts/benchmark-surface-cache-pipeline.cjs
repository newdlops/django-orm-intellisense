'use strict';
// Complete TS serialization + native worker save. Input is actual daemon data.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

async function worker(addonPath, payloadPath) {
  const addon = require(path.resolve(addonPath));
  const loader = require('../out/client/native/loader.js');
  loader.loadNative = () => addon;
  const { saveSurfaceCacheAsync } = require('../out/server/nativeCache.js');
  const { isSurfaceSourceProvenance } = require('../out/client/surfaceSourceProvenance.js');
  const payload = JSON.parse(fs.readFileSync(payloadPath));
  assert.ok(isSurfaceSourceProvenance(payload.sourceProvenance),
    'Capture a current complete Python packet with sourceProvenance; legacy archived packets cannot be restamped.');
  const workspaceRoot = payload.sourceProvenance.root;
  assert.equal(fs.realpathSync(workspaceRoot), workspaceRoot, 'The producing source root must still exist.');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djls-cache-pipeline-'));
  const previousRoot = process.env.DJANGO_ORM_INTELLISENSE_CACHE_DIR;
  process.env.DJANGO_ORM_INTELLISENSE_CACHE_DIR = root;
  try {
    global.gc();
    const baseline = process.memoryUsage(), cpu = process.cpuUsage(), started = performance.now();
    let last = started, ticks = 0, maxGapMs = 0, maxRss = baseline.rss, maxHeap = baseline.heapUsed;
    const observe = () => {
      const now = performance.now(), memory = process.memoryUsage();
      maxGapMs = Math.max(maxGapMs, now-last); last = now; ticks++;
      maxRss = Math.max(maxRss, memory.rss); maxHeap = Math.max(maxHeap, memory.heapUsed);
    };
    const timer = setInterval(observe, 1);
    try { await saveSurfaceCacheAsync(workspaceRoot, payload); }
    finally { clearInterval(timer); }
    const elapsedMs = performance.now()-started, usage = process.cpuUsage(cpu);
    observe();
    const afterSave = process.memoryUsage();
    // Compare serialization independently of the optional source-reader API
    // on the older addon. No prewarm/source-selection claim is made here.
    const hit = addon.loadCacheBlob(path.join(addon.workspaceCacheDir(root, workspaceRoot), 'surface-index-v1.bin'));
    assert.ok(hit, 'A complete producer-owned packet must be persisted.');
    assert.equal(JSON.parse(hit.metadata).formatVersion, 2);
    const loaded = JSON.parse(hit.payload);
    assert.deepEqual(loaded, payload, 'Every complete surface/catalogue/metadata value survives actual TS pipeline');
    const loadedBytes = Buffer.from(JSON.stringify(loaded));
    return { elapsedMs, cpuMs: (usage.user+usage.system)/1000, ticks, maxGapMs,
      observedRssDeltaBytes: maxRss-baseline.rss, observedHeapDeltaBytes: maxHeap-baseline.heapUsed,
      baseline, afterSave, fullValueEqual: true, modelCount: Object.keys(loaded.surfaceIndex).length,
      decodedSha256: crypto.createHash('sha256').update(loadedBytes).digest('hex') };
  } finally {
    if (previousRoot === undefined) delete process.env.DJANGO_ORM_INTELLISENSE_CACHE_DIR;
    else process.env.DJANGO_ORM_INTELLISENSE_CACHE_DIR = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function run(addon, payload) {
  const child = spawn(process.execPath, ['--expose-gc', __filename, '--worker', addon, payload],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', stderr = '';
  child.stdout.on('data', value => { output += value; });
  child.stderr.on('data', value => { stderr += value; });
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve({ code, signal })
      : reject(Error(`Surface cache worker exited ${code}/${signal}: ${stderr}`)));
  });
  return { ...JSON.parse(output), exit };
}

async function main() {
  if (process.argv[2] === '--worker') {
    console.log(JSON.stringify(await worker(...process.argv.slice(3)))); return;
  }
  const [previous, current, ...payloads] = process.argv.slice(2);
  assert.ok(previous && current && payloads.length);
  const addons = { previous, current }, rows = [];
  for (const payload of payloads) {
    const samples = { previous: [], current: [] };
    for (let round = 0; round < 5; round++) {
      for (const mode of round % 2 ? ['current', 'previous'] : ['previous', 'current']) {
        samples[mode].push(await run(addons[mode], payload));
      }
    }
    assert.equal(new Set(Object.values(samples).flat().map(sample => sample.decodedSha256)).size, 1);
    const keys = ['elapsedMs', 'cpuMs', 'observedRssDeltaBytes', 'observedHeapDeltaBytes', 'maxGapMs'];
    rows.push({ payload, samples, summary: Object.fromEntries(Object.entries(samples).map(([mode, values]) => [mode,
      Object.fromEntries(keys.map(key => {
        const sorted = values.map(value => value[key]).sort((a,b) => a-b);
        return [key, sorted[Math.floor(sorted.length/2)]];
      }))])) });
  }
  console.log(JSON.stringify({ date: '2026-10-09', nodeVersion: process.version,
    addonHashes: Object.fromEntries(Object.entries(addons).map(([mode, addon]) => [mode,
      crypto.createHash('sha256').update(fs.readFileSync(addon)).digest('hex')])),
    profile: 'dev', repetitions: 5, rows,
    scope: 'Five alternating fresh-process previous/current complete actual TS saveSurfaceCacheAsync serialization and native cache saves per current producer-owned configured payload. The source root must still exist; legacy packets without sourceProvenance are rejected. Complete raw native loaded value SHA/equality is checked after the measured window, independently of optional reader capabilities. Node RSS includes native allocations;1ms and end samples are lower-bound peaks, not true maximum. Input parsed before GC/baseline. No source-selection/prewarm, LS cache timer, Python/startup/editor/aggregate-memory or stable whole-budget claim.' }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
