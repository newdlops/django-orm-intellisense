'use strict';
// Bounded standalone Node client: actual Python stdio protocol, no VS Code claims.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const zlib = require('node:zlib');
const { spawn, execFile } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { promisify } = require('node:util');
const { SurfaceSnapshotDecoder } = require('../out/client/daemon/surfaceSnapshotTransport.js');
const execute = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadlineMs = 120000;
const kinds = ['instance', 'model_class', 'manager', 'queryset', 'related_manager'];

class Client {
  constructor(fixture, outputDir, lifecycle) {
    this.started = performance.now();
    this.pending = new Map();
    this.serial = 0;
    this.notifications = [];
    this.decodes = [];
    this.stderr = '';
    this.decoder = new SurfaceSnapshotDecoder();
    this.logPath = path.join(outputDir, `${lifecycle}-daemon.log`);
    this.child = spawn(fixture.python, ['-m', fixture.workerModule, '--stdio', '--workspace', fixture.root], {
      cwd: fixture.root, env: { ...process.env, PYTHONPATH: fixture.pythonPath,
        DJANGO_ORM_INTELLISENSE_CACHE_DIR: fixture.cache }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', bytes => { this.stderr += bytes.toString(); });
    this.reader = readline.createInterface({ input: this.child.stdout });
    this.reader.on('line', line => {
      try {
        const started = performance.now();
        const startedUnixMs = Date.now();
        let value = JSON.parse(line);
        const envelopeParsed = performance.now();
        const compressed = value._enc === 'gzip+b64';
        let decodePhases;
        if (compressed) {
          const bytes = Buffer.from(value.data, 'base64'), base64Finished = performance.now();
          const inflated = zlib.gunzipSync(bytes), inflateFinished = performance.now();
          const text = inflated.toString('utf8'), utf8Finished = performance.now();
          value = JSON.parse(text);
          decodePhases = { envelopeJsonMs: envelopeParsed - started, base64Ms: base64Finished - envelopeParsed,
            gunzipMs: inflateFinished - base64Finished, utf8Ms: utf8Finished - inflateFinished,
            payloadJsonMs: performance.now() - utf8Finished, inflatedBytes: inflated.length };
        }
        const wireParams = value.params;
        const reconstructStarted = performance.now();
        if (value.event === 'surfaceIndexChanged') value = { ...value, params: this.decoder.decode(value.params) };
        const row = { startedUnixMs, finishedUnixMs: Date.now(), wallMs: performance.now() - started,
          compressed, wireBytes: Buffer.byteLength(line), event: value.event, id: value.id, decodePhases,
          reconstructionMs: performance.now() - reconstructStarted,
          transportKind: wireParams?.surfaceTransport?.kind,
          changedModels: wireParams?.surfaceIndexDelta ? Object.keys(wireParams.surfaceIndexDelta).length : undefined };
        this.decodes.push(row);
        if (value.event) this.notifications.push({ ...value, wireParams, receivedAt: performance.now(), receivedUnixMs: Date.now() });
        else {
          const waiter = this.pending.get(value.id);
          assert.ok(waiter, `Unexpected response ${value.id}`);
          this.pending.delete(value.id);
          clearTimeout(waiter.timer);
          if (value.error) waiter.reject(Error(JSON.stringify(value.error)));
          else waiter.resolve({ result: value.result, id: value.id, startedUnixMs: waiter.startedUnixMs,
            finishedUnixMs: Date.now(), rpcMs: performance.now() - waiter.started });
        }
      } catch (error) { this.fail(error); }
    });
    this.child.once('error', error => this.fail(error));
    this.exited = new Promise(resolve => this.child.once('exit', (code, signal) => {
      this.exit = { code, signal };
      this.fail(Error(`Daemon exited ${code}/${signal}`));
      resolve(this.exit);
    }));
  }
  fail(error) {
    this.failure = error;
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
  }
  request(method, params) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`${method} ${id} deadline`)); }, deadlineMs);
      this.pending.set(id, { resolve, reject, timer, started: performance.now(), startedUnixMs: Date.now() });
      this.child.stdin.write(JSON.stringify({ id, method, params, background: false, source: 'hover' }) + '\n', error => {
        if (error) this.fail(error);
      });
    });
  }
  async until(predicate) {
    const deadline = performance.now() + deadlineMs;
    for (;;) {
      if (this.failure) throw this.failure;
      const value = predicate();
      if (value) return value;
      assert.ok(performance.now() < deadline, 'Notification/registry deadline');
      await sleep(10);
    }
  }
  async close() {
    this.child.stdin.end();
    let timer = setTimeout(() => this.child.kill('SIGTERM'), 3000);
    const exit = await this.exited;
    clearTimeout(timer);
    fs.writeFileSync(this.logPath, this.stderr);
    this.reader.close();
    return exit;
  }
}

function assertSurface(full, fixture, prefix, manager, outputKind) {
  assert.equal(Object.keys(full.surfaceIndex).length, fixture.models);
  for (let number = 0; number < fixture.models; number++) {
    const entry = full.surfaceIndex[`app${Math.floor(number / 50)}.Model${number}`];
    for (let field = 0; field < 15; field++) assert.ok(entry.instance[`field_${field}`]);
    for (let relation = 0; relation < 2; relation++) {
      const target = (number + relation + 1) % fixture.models;
      assert.equal(entry.instance[`fk_${relation}`][1], `app${Math.floor(target / 50)}.Model${target}`);
    }
  }
  const target = full.surfaceIndex['app0.Model0'];
  for (const kind of kinds) {
    const names = ['instance', 'model_class'].includes(kind) ? ['_instance', '_class'] : ['_query'];
    for (const name of names) assert.equal(target[kind][prefix + name][1], 'app0.Model0');
  }
  assert.ok(target.model_class[manager]);
  const catalog = full.lookupCatalog;
  const type = catalog.types[catalog.fields['app0.Model0'].field_0];
  assert.equal(catalog.types[type.transforms.field_size].fieldKind, outputKind);
}

async function assertMembers(client, prefix, manager) {
  for (const kind of kinds) {
    const name = prefix + (['instance', 'model_class'].includes(kind) ? '_instance' : '_query');
    const { result } = await client.request('resolveOrmMember', { modelLabel: 'app0.Model0', receiverKind: kind, name });
    assert.ok(result.resolved);
    assert.equal(result.item.returnModelLabel, 'app0.Model0');
  }
  for (const kind of ['manager', 'queryset', 'related_manager']) {
    const { result } = await client.request('resolveOrmMemberChain', { modelLabel: 'app0.Model0',
      receiverKind: kind, managerName: manager, chain: [prefix + '_query'] });
    assert.ok(result.resolved);
    assert.equal(result.receiverKind, 'queryset');
  }
}

const probes = [
  ['resolveLookupPath', { baseModelLabel: 'app0.Model0', value: 'field_14__exact', method: 'filter' }],
  ['resolveOrmMember', { modelLabel: 'app0.Model0', receiverKind: 'instance', name: 'field_14' }],
  ['resolveModule', { module: 'app0.models' }],
];
const summary = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], maxMs: sorted.at(-1),
    above20Ms: values.filter(value => value >= 20).length, above50Ms: values.filter(value => value >= 50).length };
};

async function measure(client, done, minimumMs = 0) {
  const started = performance.now();
  const decodeOffset = client.decodes.length;
  const rows = [], ticks = [];
  let tick = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    ticks.push({ finishedUnixMs: Date.now(), gapMs: now - tick, excessMs: Math.max(0, now - tick - 10) });
    tick = now;
  }, 10);
  let ready;
  try {
    while (!ready || performance.now() - ready.receivedAt < minimumMs) {
      assert.ok(performance.now() - started < deadlineMs, 'Foreground window deadline');
      const [method, params] = probes[rows.length % probes.length];
      const reply = await client.request(method, params);
      if (method !== 'resolveModule') assert.ok(reply.result.resolved, `${method}: ${JSON.stringify(reply.result)}`);
      else assert.ok(reply.result.filePath, JSON.stringify(reply.result));
      rows.push({ method, ...reply, result: undefined });
      ready = done();
      if (!ready || performance.now() - ready.receivedAt < minimumMs) await sleep(10);
    }
  } finally { clearInterval(timer); }
  return { startedUnixMs: rows[0].startedUnixMs, finishedUnixMs: Date.now(), rows, ticks,
    decodes: client.decodes.slice(decodeOffset), rpcSummary: summary(rows.map(row => row.rpcMs)),
    timerExcessSummary: summary(ticks.map(row => row.excessMs)), ready };
}

function archive(outputDir, name, value) {
  const file = path.join(outputDir, name + '.json.gz');
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(value))));
  return file;
}

async function main() {
  const manifest = path.resolve(process.argv[2]), outputDir = path.resolve(process.argv[3]);
  const fixture = JSON.parse(fs.readFileSync(manifest));
  const rows = [];
  for (const lifecycle of ['cold', 'cached']) {
    const client = new Client(fixture, outputDir, lifecycle);
    const lifecycleRows = [];
    try {
      const initialized = await client.request('initialize', { workspaceRoot: fixture.root,
        settingsModule: 'bench_settings', deferRuntime: false, surfaceSnapshotTransport: fixture.transportVersion });
      assert.equal(initialized.result.health.runtime.bootstrapStatus, 'ready');
      let full = Object.keys(initialized.result.surfaceIndex || {}).length === fixture.models ? initialized.result :
        (await client.until(() => client.notifications.find(note => note.event === 'surfaceIndexChanged' &&
          Object.keys(note.params.surfaceIndex || {}).length === fixture.models))).params;
      const fullReadyMs = performance.now() - client.started;
      assertSurface(full, fixture, 'attached', 'special', 'CharField');
      await client.until(() => client.stderr.includes('runtime_field_registry(background) ready'));
      await assertMembers(client, 'attached', 'special');
      lifecycleRows.push({ phase: lifecycle, initializeRpcMs: initialized.rpcMs, fullSurfaceReadyFromStartMs: fullReadyMs,
        payload: archive(outputDir, lifecycle + '-ready', full) });
      if (lifecycle === 'cached') {
        const idleStarted = performance.now();
        const idle = await measure(client, () => performance.now() - idleStarted >= 600 ? { receivedAt: idleStarted } : null);
        delete idle.ready;
        lifecycleRows.push({ phase: 'idle', ...idle });
        let previous = 'attached', previousManager = 'special', previousLength = '255';
        for (const [prefix, manager, length, outputKind] of [
          ['modified', 'another', '10 ', 'DateField'], ['replaced', 'revised', '255', 'CharField'],
        ]) {
          const edit = await execute(fixture.python, ['-m', 'benchmarks.bench_runtime_refresh_foreground', '--edit-json',
            JSON.stringify({ manifest, previous, previousManager, previousLength, prefix, manager, length })],
          { cwd: fixture.root, env: { ...process.env, PYTHONPATH: fixture.pythonPath } });
          const editChecks = JSON.parse(edit.stdout);
          const offset = client.notifications.length, editStarted = performance.now();
          const replies = [];
          for (const file of [fixture.source, fixture.helper]) {
            const reply = await client.request('reindexFile', { filePath: file });
            assert.equal(reply.result.runtimeMembersPending, true);
            for (const kind of kinds) for (const suffix of ['_instance', '_class', '_query'])
              assert.ok(!reply.result.surfaceIndexDelta['app0.Model0'][kind]?.[previous + suffix]);
            replies.push(reply);
          }
          const window = await measure(client, () => client.notifications.slice(offset).find(note =>
            note.event === 'surfaceIndexChanged' && note.params.runtimeMembersPending === false &&
            note.params.surfaceIndex?.['app0.Model0']?.queryset?.[prefix + '_query']), 300);
          full = window.ready.params;
          const wirePayload = archive(outputDir, prefix + '-wire', window.ready.wireParams);
          const readyFromFirstEditMs = window.ready.receivedAt - editStarted;
          delete window.ready;
          assertSurface(full, fixture, prefix, manager, outputKind);
          assert.ok(!full.surfaceIndex['app0.Model0'].model_class[previousManager]);
          for (const kind of kinds) for (const suffix of ['_instance', '_class', '_query'])
            assert.ok(!full.surfaceIndex['app0.Model0'][kind][previous + suffix]);
          await assertMembers(client, prefix, manager);
          const verified = await execute(fixture.python, ['-m', 'benchmarks.bench_runtime_refresh_foreground',
            '--verify-manifest', manifest], { cwd: fixture.root, env: { ...process.env, PYTHONPATH: fixture.pythonPath } });
          const postRefreshPycCheck = JSON.parse(verified.stdout);
          assert.equal(postRefreshPycCheck.originalPycPreserved, true);
          lifecycleRows.push({ phase: prefix, readyFromFirstEditMs, ...window, editChecks,
            wirePayload,
            postRefreshPycCheck,
            editRequests: replies.map(({ result, ...reply }) => reply),
            pendingPayload: archive(outputDir, prefix + '-pending', replies.map(reply => reply.result)),
            payload: archive(outputDir, prefix + '-ready', full), allMetadataChecksPassed: true });
          previous = prefix; previousManager = manager; previousLength = length;
        }
      }
    } finally {
      const exit = await client.close();
      for (const row of lifecycleRows) Object.assign(row, { daemonExit: exit, daemonLog: client.logPath });
      assert.equal(exit.code, 0);
    }
    rows.push(...lifecycleRows);
  }
  console.log(JSON.stringify({ nodeVersion: process.version, workerModule: fixture.workerModule, rows,
    limitations: 'Standalone Node CLI with synchronous readline/gzip/JSON protocol decoding. No editor/UI/index adoption, '
      + 'stable latency budget, aggregate process memory or broad RPC coverage claim.' }, null, 2));
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
