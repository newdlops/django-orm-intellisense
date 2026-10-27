'use strict';
// Candidate only. Reduce repeated tuple JSON before transport, then reuse the
// decoded receiver maps. Never mutate the sender's live surface containers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { encodeTable, decodeTable } = require('./probe-surface-tuple-cost.cjs');

function setOwn(object, key, value) {
  Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
}

function encodeInplaceTable(surface) {
  const output = {};
  for (const label in surface) {
    if (!Object.hasOwn(surface, label)) continue;
    const tuples = [], receivers = {}, pool = new Map();
    const source = surface[label];
    for (const kind in source) {
      if (!Object.hasOwn(source, kind)) continue;
      const members = {}, sourceMembers = source[kind];
      for (const name in sourceMembers) {
        if (!Object.hasOwn(sourceMembers, name)) continue;
        const tuple = sourceMembers[name];
        const key = JSON.stringify(tuple);
        let index = pool.get(key);
        if (index === undefined) {
          index = tuples.length;
          tuples.push(tuple);
          pool.set(key, index);
        }
        setOwn(members, name, index);
      }
      setOwn(receivers, kind, members);
    }
    setOwn(output, label, { tuples, receivers });
  }
  return output;
}

function encodeTokenTable(surface) {
  const output = {};
  for (const label in surface) {
    if (!Object.hasOwn(surface, label)) continue;
    const tuples = [], receivers = {}, pool = new Map(), tokens = new Map([[null, 0]]);
    let tokenCounter = 1;
    const source = surface[label];
    for (const kind in source) {
      if (!Object.hasOwn(source, kind)) continue;
      const members = {}, sourceMembers = source[kind];
      for (const name in sourceMembers) {
        if (!Object.hasOwn(sourceMembers, name)) continue;
        const tuple = sourceMembers[name];
        let key = '';
        for (const item of tuple) {
          let token = tokens.get(item);
          if (token === undefined) { token = tokenCounter++; tokens.set(item, token); }
          key += `${token},`;
        }
        let index = pool.get(key);
        if (index === undefined) {
          index = tuples.length;
          tuples.push(tuple);
          pool.set(key, index);
        }
        setOwn(members, name, index);
      }
      setOwn(receivers, kind, members);
    }
    setOwn(output, label, { tuples, receivers });
  }
  return output;
}

function decodeInplaceTable(text) {
  const payload = JSON.parse(text), surface = payload.surfaceIndex;
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
  return payload;
}

function median(rows, key) {
  const sorted = rows.map(row => row[key]).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function run(payloadPath) {
  const text = fs.readFileSync(payloadPath, 'utf8');
  const payload = JSON.parse(text), expected = JSON.stringify(payload);
  const modes = ['plain', 'old-table', 'inplace-table', 'nested-inplace-table', 'token-inplace-table'];
  const samples = Object.fromEntries(modes.map(mode => [mode, []]));
  for (let round = -1; round < 9; round++) {
    for (let offset = 0; offset < modes.length; offset++) {
      const mode = modes[(round + 1 + offset) % modes.length];
      global.gc();
      const baseline = process.memoryUsage().heapUsed;
      const cpu = process.cpuUsage(), started = performance.now();
      let wire = JSON.stringify(mode === 'plain' ? payload : { ...payload,
        surfaceIndex: (mode === 'inplace-table' ? encodeInplaceTable
          : mode === 'token-inplace-table' ? encodeTokenTable : encodeTable)(payload.surfaceIndex) });
      const encodeWallMs = performance.now() - started;
      const encodeUsage = process.cpuUsage(cpu), decodeStarted = performance.now();
      let result = mode === 'plain' ? JSON.parse(wire)
        : (mode === 'old-table' ? decodeTable : decodeInplaceTable)(wire);
      const decodeWallMs = performance.now() - decodeStarted;
      const totalUsage = process.cpuUsage(cpu), totalWallMs = performance.now() - started;
      const beforeGcBytes = process.memoryUsage().heapUsed - baseline;
      const wireBytes = Buffer.byteLength(wire);
      wire = null;
      global.gc();
      const retainedBytes = process.memoryUsage().heapUsed - baseline;
      assert.equal(JSON.stringify(result), expected);
      assert.equal(JSON.stringify(payload), expected, 'Sender values remain complete');
      if (mode !== 'plain') {
        const model = Object.values(result.surfaceIndex)[0];
        assert.ok(Object.isFrozen(model.manager.aaggregate));
        assert.equal(model.manager.aaggregate, model.queryset.aaggregate);
      }
      if (round >= 0) samples[mode].push({ encodeWallMs, decodeWallMs, totalWallMs,
        encodeCpuMs: (encodeUsage.user + encodeUsage.system) / 1000,
        totalCpuMs: (totalUsage.user + totalUsage.system) / 1000,
        wireBytes, beforeGcBytes, retainedBytes, fullWireValueEqual: true });
      result = null;
    }
  }
  return { payloadPath, models: Object.keys(payload.surfaceIndex).length, samples,
    summary: Object.fromEntries(modes.map(mode => [mode, Object.fromEntries(
      ['encodeWallMs', 'decodeWallMs', 'totalWallMs', 'encodeCpuMs', 'totalCpuMs',
        'wireBytes', 'beforeGcBytes', 'retainedBytes'].map(key => [key, median(samples[mode], key)]))])) };
}

module.exports = { encodeInplaceTable, encodeTokenTable, decodeInplaceTable };
if (require.main === module) {
  assert.ok(global.gc, 'Run with --expose-gc');
  console.log(JSON.stringify({ date: '2026-10-09', nodeVersion: process.version,
    productionApplied: false, rows: process.argv.slice(2).map(run),
    scope: 'Nine rotating complete-payload encode/JSON decode pairs per mode after warmup. Candidates use per-model JSON-key, nested-map or token-key tuple tables and reuse exclusively parsed receiver maps; shared parsed tuples frozen. Every sender/result value checked. Includes encoding work and isolated before-GC/retained checkpoints. Not true peak, real LSP, persistent cache, extension-host, ordinary latency or whole-process proof.' }, null, 2));
}
