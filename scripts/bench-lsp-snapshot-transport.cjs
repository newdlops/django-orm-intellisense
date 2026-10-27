'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const Module = require('node:module');
const { spawn } = require('node:child_process');
const { SurfacePublisher } = require('../out/client/surfacePublisher.js');
const root = path.resolve(__dirname, '..');
function originalPublisher() {
  const filename = path.join(root, 'out/client/surfacePublisher.js');
  const baseline = new Module(filename, module);
  baseline.filename = filename; baseline.paths = Module._nodeModulePaths(path.dirname(filename));
  baseline._compile(zlib.gunzipSync(fs.readFileSync(path.join(root,
    'bench/lsp-snapshot-transport-baseline-surfacePublisher.js.gz'))).toString('utf8'), filename);
  return baseline.exports.SurfacePublisher;
}
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical(value[key])]));
  return value;
}
const inputs = {};
function fixture(pair) {
  const read = (phase, kind = 'payload') => {
    const file = `bench/runtime-transport-paired-${pair}-delta-0-${phase}-${kind}.json.gz`;
    const bytes = fs.readFileSync(path.join(root, file));
    inputs[file] = hash(bytes);
    return JSON.parse(zlib.gunzipSync(bytes));
  };
  return { initial: read('cached'), edits: [read('modified'), read('replaced')],
    pending: [read('modified', 'pendingPayload'), read('replaced', 'pendingPayload')] };
}
async function run(pair, mode, rounds) {
  const data = fixture(pair);
  const server = spawn(process.execPath, ['--expose-gc', '--require',
    path.join(__dirname, 'lsp-snapshot-transport-preload.cjs'),
    mode === 'original' ? path.join(__dirname, 'lsp-snapshot-baseline-server.cjs')
      : path.join(root, 'out/server/server.js'), '--node-ipc'],
    { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], serialization: 'json' });
  let id = 1, stderr = '', snapshot = data.initial;
  const pending = new Map(), samples = [], checkpoints = [];
  server.stdout.resume();
  server.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-20000); });
  function request(method, params, diagnostic = false) {
    const current = id++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(current); reject(Error(`Timeout ${method}: ${stderr}`)); }, 30000);
      pending.set(current, { resolve, reject, timeout });
      server.send({ ...(diagnostic ? {} : { jsonrpc: '2.0' }), id: current, method, params });
    });
  }
  server.on('message', message => {
    if (message.method && message.id !== undefined && message.jsonrpc) {
      server.send({ jsonrpc: '2.0', id: message.id, result: null }); return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id); clearTimeout(waiter.timeout);
    if (message.error) waiter.reject(Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });
  function rejectPending(error) {
    for (const waiter of pending.values()) { clearTimeout(waiter.timeout); waiter.reject(error); }
    pending.clear();
  }
  server.on('error', rejectPending);
  const exited = new Promise(resolve => server.once('exit', (code, signal) => {
    rejectPending(Error(`LSP exited ${code}/${signal}: ${stderr}`)); resolve({ code, signal });
  }));
  let nextPublication, publicationStarted;
  const Publisher = mode === 'original' ? originalPublisher() : SurfacePublisher;
  const publisher = new Publisher({
    currentScope: () => 'benchmark-session', snapshot: () => snapshot,
    snapshotTransportEnabled: () => mode === 'delta',
    reportFailure: error => nextPublication?.reject(error), retryDelayMs: 20,
    send: async (method, params) => {
      const started = performance.now();
      const resultPromise = request(method, params);
      const dispatchMs = performance.now() - started;
      const result = await resultPromise;
      const acknowledgementMs = performance.now() - started;
      if (method === 'django/updateSurfaceIndex') {
        const resultRow = { mode, pair, method, kind: params.surfaceTransport?.kind ?? 'legacy',
          sequence: params.surfaceTransport?.sequence, wireModels: Object.keys(params.surfaceIndex ?? params.surfaceIndexDelta ?? {}).length,
          dispatchMs, acknowledgementMs, publicationMs: performance.now() - publicationStarted,
          prepareAndScheduleMs: started - publicationStarted,
          payloadBytes: Buffer.byteLength(JSON.stringify(params)) };
        // Resolve only after the publisher has received its ACK and committed.
        setImmediate(() => nextPublication.resolve(resultRow));
      }
      return result;
    },
  });
  const publish = async (phase, round) => {
    const row = await new Promise((resolve, reject) => {
      nextPublication = { resolve, reject }; publicationStarted = performance.now(); publisher.requestFull();
    });
    const check = await request('benchmarkSnapshotCheck', {}, true);
    assert.equal(check.payloadSha256, hash(JSON.stringify(canonical(snapshot))), 'Every reconstructed metadata value matches input');
    const memory = await request('benchmarkSnapshotMemory', {}, true);
    samples.push({ ...row, phase, round, check, memory });
  };
  let version = 1;
  const uri = `file:///private/tmp/djls-lsp-snapshot-transport-${pair}-${mode}.py`;
  async function query(text) {
    server.send({ jsonrpc: '2.0', method: 'textDocument/didChange', params: {
      textDocument: { uri, version: ++version }, contentChanges: [{ text }],
    } });
    const result = await request('textDocument/completion', { textDocument: { uri }, position: { line: 0, character: text.length } });
    return (Array.isArray(result) ? result : result.items).map(value => value.label);
  }
  let completionChecks = 0, sourceReplies = 0;
  try {
    const initialized = await request('initialize', { processId: process.pid, rootUri: null, capabilities: {} });
    if (mode !== 'original') assert.equal(initialized.capabilities.experimental.djangoSurfaceSnapshotTransport, 1);
    server.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
    checkpoints.push({ phase: 'initialized', ...await request('benchmarkSnapshotMemory', {}, true) });
    await publish('initial', -1);
    server.send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: {
      textDocument: { uri, languageId: 'python', version, text: '' },
    } });
    for (let round = 0; round < rounds; round++) {
      snapshot = data.initial;
      await publish('reset', round);
      for (let edit = 0; edit < 2; edit++) {
        for (const result of data.pending[edit]) {
          assert.deepEqual(await publisher.publishDelta(result, 'benchmark-session'), true);
          sourceReplies++;
        }
        snapshot = data.edits[edit];
        await publish(edit ? 'replaced' : 'modified', round);
        // Actual completion negative controls avoid permissive validation fallback.
        assert.ok((await query('Model0.objects.filter(field_')).includes('field_14'));
        assert.ok(!(await query('Model0.objects.filter(benchmark_missing_')).includes('benchmark_missing_field'));
        const expected = edit ? 'icontains' : 'year';
        assert.ok((await query(`Model0.objects.filter(field_0__field_size__${edit ? 'i' : 'ye'}`)).includes(expected));
        if (edit) assert.ok(!(await query('Model0.objects.filter(field_0__field_size__ye')).includes('year'));
        assert.ok((await query('Model1.objects.filter(field_0__field_size__i')).includes('icontains'));
        completionChecks += edit ? 5 : 4;
      }
    }
    for (let model = 0; model < 500; model++) {
      assert.ok((await query(`Model${model}.objects.filter(field_`)).includes('field_14'));
      assert.ok((await query(`Model${model}.objects.filter(fk_0__field_0__i`)).includes('icontains'));
      completionChecks += 2;
    }
    const report = await request('django/perfReport');
    assert.equal(report.snapshot.modelCount, 500);
    checkpoints.push({ phase: 'allModelsQueried', ...await request('benchmarkSnapshotMemory', {}, true) });
    snapshot = { surfaceIndex: {}, surfaceFingerprints: {}, modelNames: [], customLookups: {},
      customLookupsFingerprint: 'empty', staticFallback: null, staticFallbackFingerprint: null,
      lookupCatalog: { types: {}, fields: {} } };
    await publish('empty', rounds);
    assert.equal((await request('django/perfReport')).snapshot.modelCount, 0);
    await request('shutdown', null);
    server.send({ jsonrpc: '2.0', method: 'exit' });
    const exit = await exited; assert.equal(exit.code, 0);
    return { pair, mode, samples, checkpoints, sourceReplies, completionChecks, exit };
  } finally {
    publisher.dispose();
    if (server.exitCode === null && server.signalCode === null) { server.kill(); await exited; }
  }
}
async function main() {
  const rounds = Number(process.argv[2] ?? 5);
  assert.ok(Number.isSafeInteger(rounds) && rounds > 0);
  const files = ['src/client/extension.ts', 'src/client/surfacePublisher.ts', 'src/client/surfaceSnapshotEncoder.ts',
    'src/server/server.ts', 'src/server/workspaceIndexer.ts', 'src/server/lookupCatalog.ts',
    'src/client/daemon/surfaceSnapshotTransport.ts', 'src/client/protocol.ts',
    'out/client/surfacePublisher.js', 'out/client/surfaceSnapshotEncoder.js', 'out/server/server.js',
    'out/server/workspaceIndexer.js', 'out/server/lookupCatalog.js', 'out/client/daemon/surfaceSnapshotTransport.js',
    'scripts/bench-lsp-snapshot-transport.cjs', 'scripts/lsp-snapshot-transport-preload.cjs',
    'scripts/lsp-snapshot-baseline-server.cjs', 'bench/lsp-snapshot-transport-baseline-server.js.gz',
    'bench/lsp-snapshot-transport-baseline-surfacePublisher.js.gz'];
  const sourceSha256 = Object.fromEntries(files.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'bench/lsp-snapshot-transport-baseline-hashes.json')));
  for (const file of ['src/server/workspaceIndexer.ts', 'src/server/lookupCatalog.ts', 'src/client/daemon/surfaceSnapshotTransport.ts',
    'out/server/workspaceIndexer.js', 'out/server/lookupCatalog.js', 'out/client/daemon/surfaceSnapshotTransport.js']) {
    assert.equal(sourceSha256[file], baseline[file], `Baseline shared dependency changed: ${file}`);
  }
  assert.equal(hash(zlib.gunzipSync(fs.readFileSync(path.join(root, 'bench/lsp-snapshot-transport-baseline-server.js.gz')))), baseline['out/server/server.js']);
  assert.equal(hash(zlib.gunzipSync(fs.readFileSync(path.join(root, 'bench/lsp-snapshot-transport-baseline-surfacePublisher.js.gz')))), baseline['out/client/surfacePublisher.js']);
  const modes = process.argv.includes('--include-original') ? ['original', 'full', 'delta'] : ['full', 'delta'];
  const runs = [];
  for (let pair = 0; pair < 3; pair++) {
    const order = modes.length === 3 ? [...modes.slice(pair), ...modes.slice(0, pair)]
      : pair % 2 ? [...modes].reverse() : modes;
    for (const mode of order) runs.push(await run(pair, mode, rounds));
  }
  const describe = values => {
    values = [...values].sort((a, b) => a - b);
    const n = values.length;
    return { count: n, median: n % 2 ? values[n >> 1] : (values[n / 2 - 1] + values[n / 2]) / 2,
      p95: values[Math.ceil(n * .95) - 1], max: values.at(-1) };
  };
  const summary = Object.fromEntries(modes.map(mode => {
    const selected = runs.filter(run => run.mode === mode).flatMap(run => run.samples)
      .filter(row => row.phase === 'modified' || row.phase === 'replaced');
    return [mode, Object.fromEntries(['acknowledgementMs', 'dispatchMs', 'publicationMs', 'prepareAndScheduleMs', 'payloadBytes'].map(key => [key,
      describe(selected.map(row => row[key]))]))];
  }));
  for (const file of files) assert.equal(hash(fs.readFileSync(path.join(root, file))), sourceSha256[file], `Measured dependency changed during run: ${file}`);
  console.log(JSON.stringify({ observedUtc: new Date().toISOString(), node: process.version,
    platform: process.platform, arch: process.arch, rounds, inputs, sourceSha256, baseline, summary, runs,
    scope: 'Actual production publisher, Node IPC JSON LSP child, complete archived 500-model/5000-source metadata. Original mode loads the exact archived pre-change publisher and server with asserted unchanged shared index/catalog/decoder dependencies. Full control disables the new negotiated transport on the current server, retaining full metadata adoption fixes. Each measured edit follows two actual archived source reindex replies. ACK windows exclude hash/oracle/diagnostic GC and payload-size calculations; publication windows include encoder preparation and scheduling. Diagnostics can alter subsequent GC. Whole reconstructed metadata hashes and whole derived-index fresh-build oracles run after every publication. Every model has real scalar and relation completions; transform changes and removed-name negative controls run after every edit. Process heap/RSS boundary samples are lower bounds, with retained V8 heap measured after explicit diagnostic GC; no true peak, editor/Python aggregate memory, cold bootstrap, total save-ready, all-RPC SLO or controlled-host causal claim.' }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
