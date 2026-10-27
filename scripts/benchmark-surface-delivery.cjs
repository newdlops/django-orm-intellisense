// Actual LSP transport/application timings. Excludes Python, files and editor debounce.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const server = spawn(process.execPath, ['out/server/server.js', '--stdio']);
let incoming = Buffer.alloc(0);
let nextId = 1;
let stderr = '';
let fullRebuildsFromDelta = 0;
const pending = new Map();
server.stderr.on('data', chunk => { stderr += chunk; });
function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
  server.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  server.stdin.write(body);
}
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(Error(`Timed out: ${method} ${stderr}`)); }, 10000);
    pending.set(id, { resolve, reject, timeout });
    send({ id, method, params });
  });
}
server.stdout.on('data', chunk => {
  incoming = Buffer.concat([incoming, chunk]);
  for (;;) {
    const headerEnd = incoming.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(incoming.subarray(0, headerEnd).toString())?.[1]);
    if (!length || incoming.length < headerEnd + 4 + length) return;
    const message = JSON.parse(incoming.subarray(headerEnd + 4, headerEnd + 4 + length));
    incoming = incoming.subarray(headerEnd + 4 + length);
    if (message.method === 'window/logMessage' && message.params?.message?.includes('full rebuild from delta (staticFallback changed)')) fullRebuildsFromDelta++;
    if (message.id !== undefined && message.method) send({ id: message.id, result: null });
    const waiter = pending.get(message.id);
    if (!waiter || message.method) continue;
    pending.delete(message.id);
    clearTimeout(waiter.timeout);
    if (message.error) waiter.reject(Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  }
});
server.on('exit', code => {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timeout);
    waiter.reject(Error(`Server exited ${code}: ${stderr}`));
  }
  pending.clear();
});
function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { samplesMs: samples, medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], maxMs: sorted.at(-1),
    atLeast20Ms: sorted.filter(value => value >= 20).length };
}
async function main() {
  await request('initialize', { processId: process.pid, rootUri: null, capabilities: {} });
  send({ method: 'initialized', params: {} });
  const uri = 'file:///private/tmp/djls-surface-delivery-benchmark.py';
  const text = 'Model0.objects.filter(value_';
  send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'python', version: 1, text } } });
  const rows = [];
  for (const models of [1000, 5000, 10000]) {
    const surfaceIndex = {};
    const surfaceFingerprints = {};
    for (let index = 0; index < models; index++) {
      surfaceIndex[`bench.Model${index}`] = { instance: {
        id: ['scalar', null, 'field', 'AutoField'],
        value_untouched: ['scalar', null, 'field', 'CharField'],
        created: ['scalar', null, 'field', 'DateField'],
      } };
      surfaceFingerprints[`bench.Model${index}`] = 'initial';
    }
    const started = performance.now();
    assert.deepEqual(await request('django/updateSurfaceIndex', { surfaceIndex, surfaceFingerprints }), { applied: true });
    const fullSnapshotMs = performance.now() - started;
    const rebuildsBefore = fullRebuildsFromDelta;
    const samples = [];
    for (let revision = 0; revision < 30; revision++) {
      const delta = { instance: { [`value_${revision}`]: ['scalar', null, 'field', 'DateField'] } };
      const sentAt = performance.now();
      assert.deepEqual(await request('django/updateSurfaceIndexDelta', {
        surfaceIndexDelta: { 'bench.Model0': delta }, changedLabels: ['bench.Model0'],
        surfaceFingerprints: { 'bench.Model0': String(revision) },
      }), { applied: true });
      samples.push(performance.now() - sentAt);
    }
    const labels = (await request('textDocument/completion', { textDocument: { uri }, position: { line: 0, character: text.length } })).map(item => item.label);
    assert.deepEqual(labels, ['value_29']);
    const report = await request('django/perfReport');
    assert.equal(report.snapshot.modelCount, models);
    rows.push({ models, repetitions: samples.length, fullSnapshotMs, acknowledgedDelta: stats(samples),
      latestFieldResolved: true, removedFieldsRetired: true, modelCountPreserved: true,
      fullRebuildsFromDelta: fullRebuildsFromDelta - rebuildsBefore });
    await delay(20);
  }
  console.log(JSON.stringify({ date: '2026-10-09', platform: process.platform, arch: process.arch,
    nodeVersion: process.version, cacheSchemaVersion: 34, rows,
    allDeltaSamplesBelow20Ms: rows.every(row => row.acknowledgedDelta.atLeast20Ms === 0),
    scope: '30 acknowledged single-model metadata deltas at each of 1000/5000/10000 synthetic models, actual Node language server over stdio. Includes client serialization, transport, server application and response. Full snapshots are one sample per tier. Excludes Python discovery/runtime/reindex, real source files, save debounce, GUI, whole/peak heap and SQL. No previous-unacknowledged latency or global speedup claim.' }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.kill());
