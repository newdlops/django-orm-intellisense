'use strict';
// Actual Node child IPC, candidate transport setting only; complete metadata.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const { performance } = require('node:perf_hooks');

if (process.argv[2] === '--worker') {
  process.on('message', message => {
    if (message.op === 'snapshot') {
      const received = process.memoryUsage();
      const cpu = process.cpuUsage();
      const started = performance.now();
      const text = JSON.stringify(message.payload);
      const hash = crypto.createHash('sha256').update(text).digest('hex');
      const used = process.cpuUsage(cpu);
      const verificationMs = performance.now() - started;
      process.send({ id: message.id, hash, models: Object.keys(message.payload.surfaceIndex).length,
        received, verificationMs, verificationCpuMs: (used.user + used.system) / 1000 });
    } else if (message.op === 'close') {
      process.send({ id: message.id, closed: true }, () => process.disconnect());
    }
  });
} else {
  const median = (rows, key) => [...rows].map(row => row[key]).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
  async function sample(payload, expected, serialization) {
    const child = fork(__filename, ['--worker'], { serialization, execArgv: ['--expose-gc'], silent: true });
    let next = 0;
    const pending = new Map();
    let stderr = '';
    child.stderr.on('data', value => { stderr = (stderr + value).slice(-2000); });
    child.on('message', value => {
      const waiter = pending.get(value.id);
      if (waiter) { pending.delete(value.id); clearTimeout(waiter.timer); waiter.resolve(value); }
    });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => {
      for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(Error(`Child exited ${code}/${signal}: ${stderr}`)); }
      pending.clear(); resolve({ code, signal });
    }));
    const send = (op, value) => new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(Error('IPC deadline')); }, 30000);
      pending.set(id, { resolve, reject, timer });
      child.send({ op, id, payload: value }, error => { if (error) { clearTimeout(timer); pending.delete(id); reject(error); } });
    });
    try {
      // Discard process bootstrap; every later message still includes full metadata.
      let result = await send('snapshot', payload);
      assert.equal(result.hash, expected);
      global.gc();
      const before = process.memoryUsage();
      const cpu = process.cpuUsage();
      const started = performance.now();
      const request = send('snapshot', payload);
      const senderMs = performance.now() - started;
      const senderCpu = process.cpuUsage(cpu);
      const afterSend = process.memoryUsage();
      result = await request;
      const roundTripMs = performance.now() - started;
      const used = process.cpuUsage(cpu);
      assert.equal(result.hash, expected);
      await send('close');
      const exit = await exited;
      assert.equal(exit.code, 0);
      return { senderMs, senderCpuMs: (senderCpu.user + senderCpu.system) / 1000,
        senderAfterSendHeapBytes: afterSend.heapUsed - before.heapUsed,
        senderAfterSendRssBytes: afterSend.rss - before.rss,
        senderAfterSendExternalBytes: afterSend.external - before.external,
        roundTripMs, totalParentCpuMs: (used.user + used.system) / 1000,
        workerReceivedHeapBytes: result.received.heapUsed, workerReceivedRssBytes: result.received.rss,
        verificationMs: result.verificationMs, verificationCpuMs: result.verificationCpuMs,
        fullWireValuesEqual: true, exit };
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
    }
  }
  async function main() {
    assert.ok(global.gc);
    const rows = [];
    for (const payloadPath of process.argv.slice(2)) {
      const bytes = fs.readFileSync(payloadPath);
      const payload = JSON.parse(bytes);
      const expected = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      const samples = { json: [], advanced: [] };
      for (let round = 0; round < 5; round++) {
        for (const mode of round % 2 ? ['advanced', 'json'] : ['json', 'advanced']) {
          samples[mode].push(await sample(payload, expected, mode));
        }
      }
      rows.push({ payloadPath, payloadBytes: bytes.length,
        payloadSha256: crypto.createHash('sha256').update(bytes).digest('hex'), samples,
        summary: Object.fromEntries(Object.entries(samples).map(([mode, values]) => [mode,
          Object.fromEntries(Object.keys(values[0]).filter(key => typeof values[0][key] === 'number').map(key => [key, median(values, key)]))])) });
    }
    console.log(JSON.stringify({ date: '2026-10-09', nodeVersion: process.version, productionApplied: false, rows,
      scope: 'Five alternating full metadata sends per mode/tier, separate child per sample after bootstrap warmup. Node child IPC json versus advanced; every receiver complete serialized value hash equals sender. Sender synchronous callback setup/serialization time and checkpoint memory; roundtrip includes receiver verification JSON/hash, not ordinary LSP or true peak/aggregate memory. Child exit0 required.' }, null, 2));
  }
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
