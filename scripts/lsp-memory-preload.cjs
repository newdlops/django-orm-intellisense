// Test-worker-only memory channel; actual server LSP protocol stays on stdio.
const path = require('node:path');
const v8 = require('node:v8');
let observedHeapPeak = 0;
let observedRssPeak = 0;
const sample = () => {
  const usage = process.memoryUsage();
  observedHeapPeak = Math.max(observedHeapPeak, usage.heapUsed);
  observedRssPeak = Math.max(observedRssPeak, usage.rss);
  return usage;
};
const originalParse = JSON.parse;
const shareTuples = process.env.DJLS_BENCH_SHARE_SURFACE_TUPLES === '1';
const tableWire = process.env.DJLS_BENCH_SURFACE_TABLE_WIRE === '1';
const inplacePool = process.env.DJLS_BENCH_SURFACE_POOL_INPLACE;
const { shareSurfaceTuplesInplace } = require('./probe-surface-pool-inplace.cjs');
// Experiment only: a per-model pool dies after one decoded payload. Freeze
// new tuples; never alias mutable incoming arrays or change wire JSON values.
function shareSurfaceTuples(value) {
  const surface = value?.params?.surfaceIndex ?? value?.params?.surfaceIndexDelta;
  if (!surface) return;
  for (const receivers of Object.values(surface)) {
    const pool = new Map();
    for (const members of Object.values(receivers)) {
      for (const [name, tuple] of Object.entries(members)) {
        if (!Array.isArray(tuple) || tuple.length < 2 || tuple.length > 4
          || !tuple.every(item => item === null || typeof item === 'string')) continue;
        const key = originalStringify(tuple);
        let shared = pool.get(key);
        if (!shared) { shared = Object.freeze([...tuple]); pool.set(key, shared); }
        members[name] = shared;
      }
    }
  }
}
const originalStringify = JSON.stringify;
JSON.parse = function (...args) {
  sample();
  const value = originalParse.apply(this, args);
  sample();
  if (tableWire && value?.params?.benchmarkSurfaceTable) {
    // The benchmark sends the candidate table over actual LSP stdio. Restore
    // it before the unchanged production handler; no source fields are lost.
    const surface = value.params.surfaceIndex ?? value.params.surfaceIndexDelta;
    for (const label in surface) {
      if (!Object.hasOwn(surface, label)) continue;
      const { tuples, receivers } = surface[label];
      for (const tuple of tuples) Object.freeze(tuple);
      for (const kind in receivers) {
        if (!Object.hasOwn(receivers, kind)) continue;
        const members = receivers[kind];
        for (const name in members) {
          if (Object.hasOwn(members, name)) members[name] = tuples[members[name]];
        }
      }
      surface[label] = receivers;
    }
    delete value.params.benchmarkSurfaceTable;
    sample();
  }
  if (shareTuples) { shareSurfaceTuples(value); sample(); }
  if (inplacePool) {
    const surface = value?.params?.surfaceIndex ?? value?.params?.surfaceIndexDelta;
    if (surface) { shareSurfaceTuplesInplace(surface, inplacePool); sample(); }
  }
  return value;
};
const indexer = require(path.resolve(__dirname, '../out/server/workspaceIndexer.js'));
for (const name of ['buildWorkspaceIndex', 'updateWorkspaceIndexIncremental']) {
  const original = indexer[name];
  indexer[name] = function (...args) {
    sample();
    try { return original.apply(this, args); }
    finally { sample(); }
  };
}
// Observe actual child IPC JSON/V8 deserialization before production listeners.
const originalEmit = process.emit;
process.emit = function (event, ...args) {
  if (event === 'message') sample();
  return Reflect.apply(originalEmit, this, [event, ...args]);
};
process.on('message', message => {
  if (message?.method !== 'benchmarkMemory') return;
  const beforeCollection = sample();
  if (message.collect) global.gc?.();
  const current = sample();
  process.send?.({ id: message.id, result: { phase: message.phase, current,
    beforeCollection, observedHeapPeakBytes: observedHeapPeak,
    observedRssPeakBytes: observedRssPeak, v8: v8.getHeapStatistics(),
    collected: Boolean(message.collect && global.gc) } });
  observedHeapPeak = current.heapUsed;
  observedRssPeak = current.rss;
});
