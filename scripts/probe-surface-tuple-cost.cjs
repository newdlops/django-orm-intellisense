// Isolated candidate costs, using complete archived actual daemon payloads.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { performance } = require('node:perf_hooks');
const terminal = Symbol('tuple');
function compact(surface, mode) {
  const output = {};
  for (const [label, receivers] of Object.entries(surface)) {
    const model = {}, pool = new Map();
    for (const [kind, members] of Object.entries(receivers)) {
      const next = {};
      for (const name in members) {
        if (!Object.hasOwn(members, name)) continue;
        const tuple = members[name];
        if (!Array.isArray(tuple) || tuple.length < 2 || tuple.length > 4
          || !tuple.every(item => item === null || typeof item === 'string')) {
          next[name] = tuple; continue;
        }
        let shared;
        if (mode === 'json-key') {
          const key = JSON.stringify(tuple);
          shared = pool.get(key);
          if (!shared) { shared = Object.freeze([...tuple]); pool.set(key, shared); }
        } else {
          let node = pool;
          for (const item of tuple) {
            let child = node.get(item);
            if (!child) { child = new Map(); node.set(item, child); }
            node = child;
          }
          shared = node.get(terminal);
          if (!shared) { shared = Object.freeze([...tuple]); node.set(terminal, shared); }
        }
        Object.defineProperty(next, name, { value: shared, enumerable: true, configurable: true, writable: true });
      }
      Object.defineProperty(model, kind, { value: next, enumerable: true, configurable: true, writable: true });
    }
    Object.defineProperty(output, label, { value: model, enumerable: true, configurable: true, writable: true });
  }
  return output;
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
function decode(text, mode) {
  const payload = JSON.parse(text);
  if (mode !== 'plain') payload.surfaceIndex = compact(payload.surfaceIndex, mode);
  return payload;
}
function run(archive, repetitions) {
  const text = zlib.gunzipSync(fs.readFileSync(archive)).toString();
  const expected = JSON.stringify(JSON.parse(text));
  const modes = ['plain', 'json-key', 'nested-map'];
  const measurements = Object.fromEntries(modes.map(mode => [mode, []]));
  // Warm each implementation separately; all timed runs include JSON decode.
  for (const mode of modes) {
    let p = decode(text, mode);
    assert.equal(JSON.stringify(p), expected);
    p = null;
  }
  for (let round = 0; round < repetitions; round++) {
    for (let offset = 0; offset < modes.length; offset++) {
      const mode = modes[(round + offset) % modes.length];
      global.gc();
      const baseline = process.memoryUsage().heapUsed;
      const cpu = process.cpuUsage(), started = performance.now();
      let payload = decode(text, mode);
      const wallMs = performance.now() - started;
      const used = process.cpuUsage(cpu);
      const beforeGcBytes = process.memoryUsage().heapUsed - baseline;
      global.gc();
      const retainedBytes = process.memoryUsage().heapUsed - baseline;
      assert.equal(JSON.stringify(payload), expected);
      if (mode !== 'plain') {
        const model = Object.values(payload.surfaceIndex)[0];
        assert.ok(Object.isFrozen(Object.values(model.instance)[0]));
        assert.equal(model.manager.aaggregate, model.queryset.aaggregate);
      }
      measurements[mode].push({ wallMs, cpuMs: (used.user + used.system) / 1000,
        retainedBytes, beforeGcBytes, fullWireValueEqual: true });
      payload = null;
    }
  }
  const summary = Object.fromEntries(modes.map(mode => [mode, {
    wallMedianMs: median(measurements[mode].map(row => row.wallMs)),
    cpuMedianMs: median(measurements[mode].map(row => row.cpuMs)),
    retainedMedianBytes: median(measurements[mode].map(row => row.retainedBytes)),
    beforeGcMedianBytes: median(measurements[mode].map(row => row.beforeGcBytes)),
  }]));
  return { archive, payloadBytes: Buffer.byteLength(text), repetitions, measurements, summary };
}
function encodeTable(surface) {
  const output = {};
  for (const [label, receivers] of Object.entries(surface)) {
    const pool = new Map(), tuples = [], model = { tuples, receivers: {} };
    for (const [kind, members] of Object.entries(receivers)) {
      const next = {};
      for (const name in members) {
        if (!Object.hasOwn(members, name)) continue;
        const tuple = members[name];
        let node = pool;
        for (const item of tuple) {
          let child = node.get(item);
          if (!child) { child = new Map(); node.set(item, child); }
          node = child;
        }
        let index = node.get(terminal);
        if (index === undefined) { index = tuples.length; tuples.push(tuple); node.set(terminal, index); }
        Object.defineProperty(next, name, { value: index, enumerable: true, configurable: true, writable: true });
      }
      Object.defineProperty(model.receivers, kind, { value: next, enumerable: true, configurable: true, writable: true });
    }
    Object.defineProperty(output, label, { value: model, enumerable: true, configurable: true, writable: true });
  }
  return output;
}
function decodeTable(text) {
  const payload = JSON.parse(text), output = {};
  for (const [label, model] of Object.entries(payload.surfaceIndex)) {
    const next = {};
    const tuples = model.tuples.map(tuple => Object.freeze(tuple));
    for (const [kind, members] of Object.entries(model.receivers)) {
      const receiver = {};
      for (const name in members) {
        if (Object.hasOwn(members, name)) Object.defineProperty(receiver, name, {
          value: tuples[members[name]], enumerable: true, configurable: true, writable: true });
      }
      Object.defineProperty(next, kind, { value: receiver, enumerable: true, configurable: true, writable: true });
    }
    Object.defineProperty(output, label, { value: next, enumerable: true, configurable: true, writable: true });
  }
  payload.surfaceIndex = output;
  return payload;
}
function tableRun(archive, repetitions) {
  const text = zlib.gunzipSync(fs.readFileSync(archive)).toString();
  const payload = JSON.parse(text), expected = JSON.stringify(payload);
  const samples = { plain: [], table: [] };
  for (let round = 0; round < repetitions; round++) {
    for (const mode of round % 2 ? ['table', 'plain'] : ['plain', 'table']) {
      global.gc();
      const baseline = process.memoryUsage().heapUsed;
      const cpu = process.cpuUsage(), started = performance.now();
      let wire = JSON.stringify(mode === 'plain' ? payload
        : { ...payload, surfaceIndex: encodeTable(payload.surfaceIndex) });
      const encodeWallMs = performance.now() - started;
      const encodeUsage = process.cpuUsage(cpu), decodeStarted = performance.now();
      let result = mode === 'plain' ? JSON.parse(wire) : decodeTable(wire);
      const decodeWallMs = performance.now() - decodeStarted;
      const totalUsage = process.cpuUsage(cpu), totalWallMs = performance.now() - started;
      const beforeGcBytes = process.memoryUsage().heapUsed - baseline;
      const wireBytes = Buffer.byteLength(wire);
      wire = null;
      global.gc();
      const retainedBytes = process.memoryUsage().heapUsed - baseline;
      assert.equal(JSON.stringify(result), expected);
      samples[mode].push({ encodeWallMs, decodeWallMs, totalWallMs,
        encodeCpuMs: (encodeUsage.user + encodeUsage.system) / 1000,
        totalCpuMs: (totalUsage.user + totalUsage.system) / 1000,
        wireBytes, beforeGcBytes, retainedBytes, fullWireValueEqual: true });
      result = null;
    }
  }
  return { archive, repetitions, samples,
    summary: Object.fromEntries(Object.entries(samples).map(([mode, rows]) => [mode,
      Object.fromEntries(['encodeWallMs', 'decodeWallMs', 'totalWallMs', 'encodeCpuMs',
        'totalCpuMs', 'wireBytes', 'beforeGcBytes', 'retainedBytes']
        .map(key => [key, median(rows.map(row => row[key]))]))])) };
}
module.exports = { compact, encodeTable, decodeTable };
if (require.main === module) {
  assert.ok(global.gc, 'Run with --expose-gc');
  const table = process.env.DJLS_BENCH_TUPLE_TABLE === '1';
  const rows = process.argv.slice(2).map(archive => table ? tableRun(archive, 9) : run(archive, 9));
  console.log(JSON.stringify({ date: '2026-10-09', nodeVersion: process.version,
    productionApplied: false, tableWireExperiment: table, rows,
    scope: table
      ? 'Alternating9 runs encode plus JSON decode of complete archived actual payload. Table candidate preserves every member via per-model tuple table and refs, frozen decoded tuples. Reports encode/decode/total cost including sender work, full wire value equality, isolated GC-retained payload allocations and before-GC checkpoint. Not true peak/LSP/extension/native/ordinary latency; production not applied.'
      : 'Rotating9 runs per complete archived payload and mode, JSON decode plus copy-owned receiver containers and frozen equal tuple pool per model. Complete wire value equality and shared frozen tuple assertions on each run. GC-retained isolated payload allocation and before-GC checkpoint, not true peak/LSP/extension/native/ordinary startup. Includes clone/freeze cost; no global latency claim.' }, null, 2));
}
