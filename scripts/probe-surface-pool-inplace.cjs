'use strict';
// Candidate only: retain the wire shape and share equal primitive tuples only
// inside an exclusively decoded model. No cache spans messages or models.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const terminal = Symbol('tuple');

function primitiveTuple(tuple) {
  if (!Array.isArray(tuple) || tuple.length < 2 || tuple.length > 4) return false;
  for (let index = 0; index < tuple.length; index++) {
    if (tuple[index] !== null && typeof tuple[index] !== 'string') return false;
  }
  return true;
}

function equalTuple(left, right) {
  return primitiveTuple(left) && primitiveTuple(right) && left.length === right.length
    && left[0] === right[0] && left[1] === right[1]
    && (left.length < 3 || left[2] === right[2]) && (left.length < 4 || left[3] === right[3]);
}

function shareMethodReceiverTuples(receivers) {
  const manager = receivers.manager;
  if (!manager) return;
  for (const kind of ['queryset', 'related_manager']) {
    const members = receivers[kind];
    if (!members) continue;
    for (const name in members) {
      if (!Object.hasOwn(members, name) || !Object.hasOwn(manager, name)) continue;
      const tuple = manager[name];
      if (!equalTuple(tuple, members[name])) continue;
      if (!Object.isFrozen(tuple)) Object.freeze(tuple);
      members[name] = tuple;
    }
  }
}

function shareSurfaceTuplesInplace(surface, mode) {
  for (const label in surface) {
    if (!Object.hasOwn(surface, label)) continue;
    const pool = new Map();
    const receivers = surface[label];
    if (mode === 'methods') { shareMethodReceiverTuples(receivers); continue; }
    for (const kind in receivers) {
      if (!Object.hasOwn(receivers, kind)) continue;
      const members = receivers[kind];
      for (const name in members) {
        if (!Object.hasOwn(members, name)) continue;
        const tuple = members[name];
        if (!primitiveTuple(tuple)) continue;
        let shared;
        if (mode === 'nested') {
          let node = pool;
          for (const value of tuple) {
            let child = node.get(value);
            if (!child) { child = new Map(); node.set(value, child); }
            node = child;
          }
          shared = node.get(terminal);
          if (!shared) { shared = Object.freeze(tuple); node.set(terminal, shared); }
        } else if (mode === 'bucket') {
          // The first tuple item is just an exact-value bucket. Compare every
          // item and tuple length before reusing; no concatenation collisions.
          let bucket = pool.get(tuple[0]);
          if (!bucket) { bucket = []; pool.set(tuple[0], bucket); }
          for (const candidate of bucket) {
            if (equalTuple(candidate, tuple)) {
              shared = candidate; break;
            }
          }
          if (!shared) { shared = Object.freeze(tuple); bucket.push(shared); }
        } else if (mode === 'direct') {
          let node = pool.get(tuple[0]);
          if (!node) { node = new Map(); pool.set(tuple[0], node); }
          let second = node.get(tuple[1]);
          if (!second) { second = new Map(); node.set(tuple[1], second); }
          if (tuple.length > 2) {
            let third = second.get(tuple[2]);
            if (!third) { third = new Map(); second.set(tuple[2], third); }
            second = third;
          }
          if (tuple.length > 3) {
            let fourth = second.get(tuple[3]);
            if (!fourth) { fourth = new Map(); second.set(tuple[3], fourth); }
            second = fourth;
          }
          shared = second.get(terminal);
          if (!shared) { shared = Object.freeze(tuple); second.set(terminal, shared); }
        } else {
          const key = JSON.stringify(tuple);
          shared = pool.get(key);
          if (!shared) { shared = Object.freeze(tuple); pool.set(key, shared); }
        }
        members[name] = shared;
      }
    }
  }
  return surface;
}

function median(rows, key) {
  const sorted = rows.map(row => row[key]).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function measure(payloadPath) {
  const bytes = fs.readFileSync(payloadPath);
  const text = bytes.toString();
  const expected = JSON.stringify(JSON.parse(text));
  const modes = ['plain', 'json', 'nested', 'bucket', 'direct', 'methods'];
  const samples = Object.fromEntries(modes.map(mode => [mode, []]));
  for (let round = -1; round < 9; round++) {
    for (let offset = 0; offset < modes.length; offset++) {
      const mode = modes[(round + 1 + offset) % modes.length];
      global.gc();
      const baseline = process.memoryUsage().heapUsed;
      const cpu = process.cpuUsage();
      const start = performance.now();
      let payload = JSON.parse(text);
      const parsedMs = performance.now() - start;
      if (mode !== 'plain') shareSurfaceTuplesInplace(payload.surfaceIndex, mode);
      const wallMs = performance.now() - start;
      const used = process.cpuUsage(cpu);
      const beforeGcBytes = process.memoryUsage().heapUsed - baseline;
      global.gc();
      const retainedBytes = process.memoryUsage().heapUsed - baseline;
      assert.equal(JSON.stringify(payload), expected);
      if (mode !== 'plain') {
        const model = Object.values(payload.surfaceIndex)[0];
        assert.ok(Object.isFrozen(model.manager.aaggregate));
        assert.equal(model.manager.aaggregate, model.queryset.aaggregate);
      }
      if (round >= 0) samples[mode].push({ parsedMs, shareMs: wallMs - parsedMs,
        wallMs, cpuMs: (used.user + used.system) / 1000, beforeGcBytes, retainedBytes,
        completeWireValuesEqual: true });
      payload = null;
    }
  }
  return { payloadPath, payloadBytes: bytes.length,
    payloadSha256: crypto.createHash('sha256').update(bytes).digest('hex'), samples,
    summary: Object.fromEntries(modes.map(mode => [mode, Object.fromEntries(
      ['parsedMs', 'shareMs', 'wallMs', 'cpuMs', 'beforeGcBytes', 'retainedBytes']
        .map(key => [key, median(samples[mode], key)]))])) };
}

module.exports = { shareSurfaceTuplesInplace };
if (require.main === module) {
  assert.ok(global.gc, 'Run with --expose-gc');
  console.log(JSON.stringify({ date: '2026-10-09', nodeVersion: process.version,
    productionApplied: false, rows: process.argv.slice(2).map(measure),
    scope: 'Nine rotating runs per mode/tier after warmup. Complete JSON decode plus in-place per-model frozen primitive tuple sharing; every resulting value equals the complete original payload. Retained and before-GC checkpoints are not true peak. No wire format, sender cost, persistent cache, LSP/editor/extension-host/aggregate memory or stable latency claim.' }, null, 2));
}
