// Measure scope filtering during watcher-root refresh, excluding RPC/debounce.
const assert = require('node:assert/strict');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { retainPendingSourceEvents } = require('../out/client/sourceWatcher');

const workspace = path.resolve('source-queue-benchmark/workspace');
const editable = path.resolve('source-queue-benchmark/editable');
const roots = [editable, workspace];
const ignored = new Set(['.git', '__pycache__']);
const measurements = [];
for (const count of [0, 10, 1000]) {
  const samples = [];
  for (let repeat = 0; repeat < 101; repeat++) {
    const names = Array.from({ length: count }, (_, i) => path.join(workspace, 'app', `model${i}.py`));
    const files = new Set(names);
    const deletedPaths = new Set(names);
    const start = performance.now();
    retainPendingSourceEvents(workspace, workspace, roots, files, deletedPaths, ignored);
    samples.push(performance.now() - start);
    assert.equal(files.size, count);
    assert.equal(deletedPaths.size, count);
  }
  samples.sort((a, b) => a - b);
  measurements.push({ pendingFiles: count, pendingDeletedPaths: count, repeats: 101,
    medianMs: samples[50], p95Ms: samples[95], maxMs: samples[100], retainedAll: true });
}
console.log(JSON.stringify({
  date: new Date().toISOString(), status: 'measured_retention_correctness_not_editor_latency',
  node: process.version, measurements,
  scope: 'Synchronous same-workspace scope filtering only. Sets created outside timing; two roots, canonical paths, no disk scan. Debounce, watcher registration, RPC, startup and heap excluded. Shared-host samples; no causal/global percentage claim.',
}, null, 2));
