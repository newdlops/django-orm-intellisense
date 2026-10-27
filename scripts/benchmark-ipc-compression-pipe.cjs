'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { decompressIpcEnvelope } = require('../out/client/daemon/ipcCompression.js');
const lineWriteExperiment = process.env.DJLS_BENCH_IPC_LINE_WRITE === '1';

async function measure(payloadPath) {
  const bytes = fs.readFileSync(payloadPath);
  const expected = JSON.parse(bytes);
  const child = spawn(path.resolve('.e2e-django6/bin/python'), ['-m', lineWriteExperiment
    ? 'benchmarks.ipc_line_write_pipe_worker' : 'benchmarks.ipc_compression_pipe_worker', '--payload', payloadPath],
    { env: { ...process.env, PYTHONPATH: path.resolve('python') }, stdio: ['pipe', 'pipe', 'pipe'] });
  let errorText = '';
  child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-4000); });
  const lines = readline.createInterface({ input: child.stdout });
  let nextId = 0, readyResolve, productionLevel, productionWriteMode;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const pending = new Map();
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(Error(`Child exited${code}/${signal}:${errorText}`)); }
    pending.clear(); resolve({ code, signal });
  }));
  lines.on('line', line => {
    const parseStarted = performance.now();
    let message = JSON.parse(line);
    if (message.ready) { productionLevel = message.productionLevel; productionWriteMode = message.productionWriteMode; readyResolve(); return; }
    if (message.profile) {
      const waiter = pending.get(message.profile.id);
      if (!waiter) return;
      assert.ok(waiter.decoded);
      pending.delete(message.profile.id);
      clearTimeout(waiter.timer);
      waiter.resolve({ ...waiter.decoded, ...message.profile });
      return;
    }
    const before = process.memoryUsage();
    const cpu = process.cpuUsage();
    if (message._enc === 'gzip+b64') message = decompressIpcEnvelope(message.data);
    const decodedAt = performance.now(), used = process.cpuUsage(cpu);
    const after = process.memoryUsage();
    const waiter = pending.get(message.id);
    assert.ok(waiter);
    waiter.decoded = { decodeMs: decodedAt-parseStarted, decodeCpuMs: (used.user+used.system)/1000,
      roundTripMs: decodedAt-waiter.started,
      decodeCheckpointHeapBytes: after.heapUsed-before.heapUsed,
      decodeCheckpointExternalBytes: after.external-before.external, completeValuesEqual: true };
    assert.deepStrictEqual(message.result, expected);
  });
  const request = (level, trace = false) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`Timeout level${level}:${errorText}`)); }, 30000);
    pending.set(id, { resolve, reject, timer, started: performance.now() });
    child.stdin.write(JSON.stringify({ id, level, trace })+'\n');
  });
  try {
    await ready;
    const levels = lineWriteExperiment ? ['joined', 'split'] : [6, 3, 1];
    const samples = Object.fromEntries(levels.map(level => [level, []]));
    for (let round = -1; round < 9; round++) {
      for (let offset = 0; offset < levels.length; offset++) {
        const level = levels[(round+1+offset)%levels.length];
        global.gc();
        const row = await request(level);
        if (round >= 0) samples[level].push(row);
      }
    }
    const outputAllocations = {};
    if (lineWriteExperiment) {
      for (const mode of levels) {
        global.gc();
        outputAllocations[mode] = await request(mode, true);
      }
    }
    child.stdin.end();
    const exit = await exited;
    assert.equal(exit.code, 0);
    const median = (values, key) => [...values].map(value => value[key]).sort((a,b)=>a-b)[Math.floor(values.length/2)];
    return { payloadPath, payloadSha256: crypto.createHash('sha256').update(bytes).digest('hex'), productionLevel, productionWriteMode, outputAllocations,
      models: Object.keys(expected.surfaceIndex).length, samples,
      summary: Object.fromEntries(levels.map(level => [level, Object.fromEntries(
        ['encodeMs','writeMs','workerTotalMs','workerCpuMs','decodeMs','decodeCpuMs','roundTripMs','wireBytes','decodeCheckpointHeapBytes','decodeCheckpointExternalBytes']
          .map(key=>[key,median(samples[level],key)]))])), exit };
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
  }
}
async function main() {
  assert.ok(global.gc);
  const rows = [];
  for (const payloadPath of process.argv.slice(2)) rows.push(await measure(payloadPath));
  console.log(JSON.stringify({ date: '2026-10-10', productionApplied: rows.every(row => lineWriteExperiment
    ? row.productionWriteMode === 'split' : row.productionLevel === 1), lineWriteExperiment, rows,
    scope: lineWriteExperiment
      ? 'Nine alternating complete actual daemon writer calls/joined-or-split/tier afterwarmup overOSstdoutpipe andcompiledNodecodec. Candidate sourced only by exactonewriterstatement replacement; productionfunctionotherwisekept. Everyresponse completeJSONequal, childexit0required. Separatetracedoutput-onlycalls above preparedline. DiagnosticNodeGCoutside timedrequests; no wholeprocess/truepeak/ordinaryeditor/stablelatency proof.'
      : 'Nine rotating complete metadata responses/level/tier afterwarmup, actual Pythonstdout pipe and compiledNodecodec. CompleteJSONdeep-equality everyresponse; exactgzipenvelope/protocol unchanged, childexit0required. DiagnosticNodeGCbeforeeachrequest excludesforcedGCfromlatency; readerparse/workerprofile and codec checkpoint memory, not realLSP/editor/ordinarystartup/truepeak/aggregate or stablepercentile proof.' }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode=1; });
