'use strict';

// Benchmark-only diagnostic channel; no production protocol or timing hooks.
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
let peakHeap = 0, peakRss = 0, complete, actualIndex;
let timings = [];
function sample() {
  const usage = process.memoryUsage();
  peakHeap = Math.max(peakHeap, usage.heapUsed);
  peakRss = Math.max(peakRss, usage.rss);
  return usage;
}
function canonical(value) {
  if (value instanceof Map) return ['Map', [...value].sort(([a], [b]) => String(a).localeCompare(String(b)))
    .map(([key, entry]) => [key, canonical(entry)])];
  if (value instanceof Set) return ['Set', [...value].sort().map(canonical)];
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical(value[key])]));
  return value;
}
const digest = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const indexValue = index => Object.fromEntries(['models', 'modelLabelByName', 'lookupTrie',
  'transformTrie', 'lookupTypes', 'lookupCatalog'].map(key => [key, index[key]]));
const catalog = require(path.resolve(__dirname, '../out/server/lookupCatalog.js'));
const applyCatalog = catalog.applyLookupCatalog;
catalog.applyLookupCatalog = function (...args) {
  const started = performance.now(); sample();
  try { return Reflect.apply(applyCatalog, this, args); }
  finally { timings.push({ phase: 'catalog', ms: performance.now() - started }); sample(); }
};
const indexer = require(path.resolve(__dirname, '../out/server/workspaceIndexer.js'));
const freshBuild = indexer.buildWorkspaceIndex;
for (const name of ['buildWorkspaceIndex', 'updateWorkspaceIndexIncremental']) {
  const original = indexer[name];
  indexer[name] = function (...args) {
    const started = performance.now(); sample();
    try {
      const result = Reflect.apply(original, this, args);
      actualIndex = name === 'buildWorkspaceIndex' ? result : args[0];
      return result;
    } finally { timings.push({ phase: name, ms: performance.now() - started }); sample(); }
  };
}
const { SurfaceSnapshotDecoder } = require('../out/client/daemon/surfaceSnapshotTransport.js');
const decode = SurfaceSnapshotDecoder.prototype.decode;
SurfaceSnapshotDecoder.prototype.decode = function (...args) {
  const started = performance.now(); sample();
  try { complete = Reflect.apply(decode, this, args); return complete; }
  finally { timings.push({ phase: 'decode', ms: performance.now() - started }); sample(); }
};
const emit = process.emit;
process.emit = function (event, ...args) {
  if (event === 'message') {
    sample();
    // Also permits checking the archived pre-transport server's full handler.
    if (args[0]?.method === 'django/updateSurfaceIndex' && !args[0]?.params?.surfaceTransport) complete = args[0].params;
  }
  return Reflect.apply(emit, this, [event, ...args]);
};
process.on('message', message => {
  if (message?.method !== 'benchmarkSnapshotCheck' && message?.method !== 'benchmarkSnapshotMemory') return;
  try {
    if (message.method === 'benchmarkSnapshotMemory') {
      const beforeCollection = sample();
      global.gc?.();
      const current = sample();
      process.send({ id: message.id, result: { current, beforeCollection,
        observedHeapPeakBytes: peakHeap, observedRssPeakBytes: peakRss, collected: Boolean(global.gc) } });
      peakHeap = current.heapUsed; peakRss = current.rss;
      timings = [];
      return;
    }
    const measured = timings;
    timings = [];
    // Hashing and the independent oracle run after the acknowledged RT window.
    const payloadSha256 = digest(complete);
    const actualIndexSha256 = digest(indexValue(actualIndex));
    const log = console.log;
    let fresh;
    try {
      console.log = () => {};
      fresh = freshBuild(complete.surfaceIndex, complete.modelNames ?? [], complete.customLookups,
        complete.staticFallback ?? undefined, complete.lookupCatalog);
    } finally { console.log = log; }
    const freshIndexSha256 = digest(indexValue(fresh));
    assert.equal(actualIndexSha256, freshIndexSha256, 'Actual complete LSP index differs from fresh full build');
    let completionChecks;
    if (message.params?.withCompletions && fresh.models.has('blog.Post')) {
      const { parseLookupChain, getCompletionCandidates } = require('../out/server/lookupResolver.js');
      completionChecks = ['title__', 'author__name__'].map(prefix => ({ prefix,
        labels: getCompletionCandidates(parseLookupChain(prefix, 'blog.Post', fresh, 'filter'), '', fresh, 'filter')
          .map(item => item.name).sort() }));
    }
    process.send({ id: message.id, result: { payloadSha256, actualIndexSha256, freshIndexSha256,
      models: actualIndex.models.size, timings: measured, completionChecks } });
    // Oracle-only timing records are deliberately discarded.
    timings = [];
  } catch (error) { process.send({ id: message.id, error: { message: error.stack } }); }
});
