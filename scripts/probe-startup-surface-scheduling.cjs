'use strict';
// Real stdio protocol with the extension's compact-snapshot decoder. No editor claims.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { SurfaceSnapshotDecoder } = require('../out/client/daemon/surfaceSnapshotTransport.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadlineMs = 120000;
const kinds = ['instance', 'model_class', 'manager', 'queryset', 'related_manager'];
const fieldKinds = ['CharField', 'IntegerField', 'BooleanField', 'DateTimeField',
  'FloatField', 'DecimalField', 'UUIDField', 'DateField'];

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
        DJANGO_ORM_INTELLISENSE_CACHE_DIR: fixture.cache, DJLS_SURFACE_CACHE_LOAD_MODE: 'idle',
        DJLS_SURFACE_CACHE_IDLE_MS: String(fixture.idleMs), DJLS_SURFACE_PREBUILD_ON_MISS: '1',
        DJLS_RUNTIME_REGISTRY_MODE: 'full' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', bytes => {
      this.stderr += bytes.toString();
      if (this.registryReadyMs === undefined && this.stderr.includes('runtime_field_registry(background) ready'))
        this.registryReadyMs = performance.now() - this.started;
    });
    this.reader = readline.createInterface({ input: this.child.stdout });
    this.reader.on('line', line => {
      const receivedMs = performance.now() - this.started;
      try {
        let value = JSON.parse(line);
        const compressed = value._enc === 'gzip+b64';
        if (compressed) value = JSON.parse(zlib.gunzipSync(Buffer.from(value.data, 'base64')).toString('utf8'));
        const wireParams = value.params;
        if (value.event === 'surfaceIndexChanged') value.params = this.decoder.decode(value.params);
        const decodedMs = performance.now() - this.started;
        this.decodes.push({ receivedMs, decodedMs, wallMs: decodedMs - receivedMs, compressed,
          wireBytes: Buffer.byteLength(line), id: value.id, event: value.event,
          transportKind: wireParams?.surfaceTransport?.kind });
        if (value.event) this.notifications.push({ ...value, wireParams, receivedMs, decodedMs });
        else {
          const waiter = this.pending.get(value.id);
          assert.ok(waiter, `Unexpected response ${value.id}`);
          this.pending.delete(value.id);
          clearTimeout(waiter.timer);
          if (value.error) waiter.reject(Error(JSON.stringify(value.error)));
          else waiter.resolve({ result: value.result, id: value.id, startedMs: waiter.startedMs,
            receivedMs, decodedMs, rpcMs: decodedMs - waiter.startedMs });
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
      this.pending.set(id, { resolve, reject, timer, startedMs: performance.now() - this.started });
      this.child.stdin.write(JSON.stringify({ id, method, params, background: false, source: 'hover' }) + '\n',
        error => { if (error) this.fail(error); });
    });
  }
  full(models) {
    return this.notifications.find(note => note.event === 'surfaceIndexChanged' &&
      Object.keys(note.params.surfaceIndex || {}).length === models);
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
    if (!this.exit) this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGTERM'), 3000);
    const exit = await this.exited;
    clearTimeout(timer);
    fs.writeFileSync(this.logPath, this.stderr);
    this.reader.close();
    return exit;
  }
}

function assertSurface(full, fixture) {
  assert.equal(Object.keys(full.surfaceIndex).length, fixture.models);
  assert.equal(full.health.runtime.bootstrapStatus, 'ready');
  assert.equal(full.health.runtime.modelCount, fixture.models);
  assert.equal(full.health.staticIndex.pythonFileCount, fixture.pythonFiles);
  const catalog = full.lookupCatalog;
  for (let number = 0; number < fixture.models; number++) {
    const label = `app${Math.floor(number / 50)}.Model${number}`, entry = full.surfaceIndex[label];
    for (let field = 0; field < 15; field++) {
      const name = `field_${field}`, expected = fieldKinds[field % fieldKinds.length];
      assert.equal(entry.instance[name][3], expected);
      assert.equal(catalog.types[catalog.fields[label][name]].fieldKind, expected);
    }
    for (let relation = 0; relation < 2; relation++) {
      const target = (number + relation + 1) % fixture.models;
      assert.equal(entry.instance[`fk_${relation}`][1], `app${Math.floor(target / 50)}.Model${target}`);
      assert.equal(entry.instance[`fk_${relation}_id`][3], target === 1 ? 'UUIDField' : 'BigAutoField');
    }
  }
  const target = full.surfaceIndex['app0.Model0'];
  for (const kind of kinds) {
    const names = ['instance', 'model_class'].includes(kind) ? ['attached_instance', 'attached_class'] : ['attached_query'];
    for (const name of names) assert.equal(target[kind][name][1], 'app0.Model0');
  }
  assert.ok(target.model_class.special);
  const field = catalog.types[catalog.fields['app0.Model0'].field_0];
  assert.equal(catalog.types[field.transforms.field_size].fieldKind, 'CharField');
  const uuid = full.surfaceIndex['app0.Model1'];
  assert.equal(uuid.instance.key[3], 'UUIDField');
  assert.equal(uuid.instance.pk[3], 'UUIDField');
  for (const kind of ['instance', 'model_class']) assert.ok(!Object.hasOwn(uuid[kind], 'id'));
  assert.equal(catalog.types[catalog.fields['app0.Model1'].pk].fieldKind, 'UUIDField');
  assert.ok(!Object.hasOwn(catalog.fields['app0.Model1'], 'id'));
}

function assertInitial(initial, fixture) {
  const fallback = initial.staticFallback;
  assert.equal(Object.keys(fallback).length, fixture.models);
  for (let number = 0; number < fixture.models; number++) {
    const label = `app${Math.floor(number / 50)}.Model${number}`, entry = fallback[label];
    for (let field = 0; field < 15; field++)
      assert.equal(entry.fieldDetails[`field_${field}`].fieldKind, fieldKinds[field % fieldKinds.length]);
    for (let relation = 0; relation < 2; relation++) {
      const target = (number + relation + 1) % fixture.models;
      assert.equal(entry.fieldDetails[`fk_${relation}`].relatedModelLabel,
        `app${Math.floor(target / 50)}.Model${target}`);
    }
  }
  const uuid = fallback['app0.Model1'];
  assert.equal(uuid.fieldDetails.key.fieldKind, 'UUIDField');
  assert.equal(uuid.fieldDetails.pk.fieldKind, 'UUIDField');
  assert.ok(!uuid.fields.includes('id'));
  assert.ok(!Object.hasOwn(uuid.fieldDetails, 'id'));
}

const probes = [
  ['resolveLookupPath', { baseModelLabel: 'app0.Model0', value: 'field_14__exact', method: 'filter' }],
  ['resolveOrmMember', { modelLabel: 'app0.Model0', receiverKind: 'instance', name: 'field_14' }],
  ['resolveModule', { module: 'app0.models' }],
];
function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return { count: 0 };
  return { count: sorted.length, medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], maxMs: sorted.at(-1),
    above20Ms: sorted.filter(value => value >= 20).length, above50Ms: sorted.filter(value => value >= 50).length };
}
function archive(folder, name, value) {
  const file = path.join(folder, name + '.json.gz');
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(value))));
  return file;
}

async function main() {
  const fixture = JSON.parse(fs.readFileSync(process.argv[2])), folder = path.resolve(process.argv[3]);
  const rows = [];
  for (const lifecycle of ['cold', 'cached']) {
    const client = new Client(fixture, folder, lifecycle);
    let row;
    try {
      const initialized = await client.request('initialize', { workspaceRoot: fixture.root,
        settingsModule: 'bench_settings', deferRuntime: true, surfaceSnapshotTransport: fixture.transportVersion });
      assert.equal(initialized.result.modelNames.length, fixture.models);
      const requests = [], ticks = [];
      let lastTick = performance.now(), timer;
      if (fixture.workload === 'interactive') {
        timer = setInterval(() => {
          const now = performance.now();
          ticks.push({ finishedMs: now - client.started, gapMs: now - lastTick,
            excessMs: Math.max(0, now - lastTick - 10) });
          lastTick = now;
        }, 10);
      }
      let full;
      try {
        const deadline = performance.now() + deadlineMs;
        while (!(full = client.full(fixture.models))) {
          assert.ok(performance.now() < deadline, 'Full surface deadline');
          if (client.failure) throw client.failure;
          if (fixture.workload === 'interactive') {
            const [method, params] = probes[requests.length % probes.length];
            const reply = await client.request(method, params);
            if (method === 'resolveModule') assert.ok(reply.result.filePath, JSON.stringify(reply.result));
            else assert.ok(reply.result.resolved, JSON.stringify(reply.result));
            requests.push({ method, ...reply, result: undefined });
          }
          if (!client.full(fixture.models)) await sleep(10);
        }
      } finally { if (timer) clearInterval(timer); }
      const firstCustom = await client.request('resolveLookupPath', { baseModelLabel: 'app0.Model0',
        value: 'field_0__field_size__exact', method: 'filter' });
      assert.ok(firstCustom.result.resolved, JSON.stringify(firstCustom.result));
      assertSurface(full.params, fixture);
      assertInitial(initialized.result, fixture);
      const negativeId = await client.request('resolveOrmMember',
        { modelLabel: 'app0.Model1', receiverKind: 'instance', name: 'id' });
      assert.equal(negativeId.result.resolved, false);
      row = { lifecycle, idleMs: fixture.idleMs, workload: fixture.workload,
        initialize: { ...initialized, result: undefined },
        initialPayload: archive(folder, lifecycle + '-initial', initialized.result),
        initialRuntimeStatus: initialized.result.health.runtime.bootstrapStatus,
        fullWireReceivedMs: full.receivedMs, fullDecodedMs: full.decodedMs,
        parentRegistryBackgroundMarkerMs: client.registryReadyMs ?? null,
        firstPostSurfaceCustomLookup: firstCustom,
        startupRequests: requests, rpcSummary: summary(requests.map(request => request.rpcMs)),
        ticks, timerExcessSummary: summary(ticks.map(tick => tick.excessMs)),
        payload: archive(folder, lifecycle + '-full', full.params),
        wirePayload: archive(folder, lifecycle + '-wire', full.wireParams),
        allModelScalarFkCatalogCustomAndNegativeIdChecks: true, negativeId: negativeId.result,
        initialModelScalarFkAndUuidNegativeIdChecks: true,
        runtimeReadyNotifications: client.notifications.filter(note => note.params?.health?.runtime?.bootstrapStatus === 'ready')
          .map(note => ({ event: note.event, receivedMs: note.receivedMs, decodedMs: note.decodedMs,
            models: Object.keys(note.params.surfaceIndex || {}).length })),
        surfaceLoadLog: client.stderr.split('\n').filter(line =>
          /defer_surface_index_load|load_cached_surface_index\(background\)|prebuild_surface_index\(background\)/.test(line)),
        decodes: client.decodes,
      };
    } finally {
      const exit = await client.close();
      if (row) Object.assign(row, { daemonExit: exit, daemonLog: client.logPath });
      assert.equal(exit.code, 0, JSON.stringify(exit));
    }
    rows.push(row);
    console.error(`[startup-scheduling] ${lifecycle} ready=${row.fullDecodedMs.toFixed(1)}ms `
      + `rpcMax=${row.rpcSummary.maxMs?.toFixed(1)}ms requests=${row.rpcSummary.count}`);
  }
  console.log(JSON.stringify({ nodeVersion: process.version, fixture, rows }, null, 2));
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
