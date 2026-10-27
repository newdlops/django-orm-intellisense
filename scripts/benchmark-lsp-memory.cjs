// Actual LSP process heap, with real daemon metadata and benchmark-only IPC.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { encodeTokenTable } = require('./probe-surface-table-inplace.cjs');
const tableWire = process.env.DJLS_BENCH_SURFACE_TABLE_WIRE === '1';
const ipcSerialization = process.env.DJLS_BENCH_LSP_IPC_SERIALIZATION;

async function measure(payloadPath, files) {
  const encoded = fs.readFileSync(payloadPath);
  const payload = JSON.parse(encoded);
  const models = Object.keys(payload.surfaceIndex).length;
  const saveDeltasPath = process.env.DJLS_BENCH_SAVE_DELTAS;
  const saveDeltasEncoded = saveDeltasPath ? fs.readFileSync(saveDeltasPath) : undefined;
  const saveDeltas = saveDeltasEncoded ? JSON.parse(saveDeltasEncoded) : [];
  const server = spawn(process.execPath, ['--expose-gc', '--require',
    path.join(__dirname, 'lsp-memory-preload.cjs'),
    path.join(__dirname, '../out/server/server.js'), ipcSerialization ? '--node-ipc' : '--stdio'],
    { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], serialization: ipcSerialization ?? 'json' });
  let incoming = Buffer.alloc(0), nextId = 1, stderr = '';
  const pending = new Map(), memoryPending = new Map();
  server.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-20000); });
  const send = message => {
    if (tableWire && message.method?.startsWith('django/updateSurfaceIndex')) {
      const key = message.params.surfaceIndex ? 'surfaceIndex' : 'surfaceIndexDelta';
      message = { ...message, params: { ...message.params,
        [key]: encodeTokenTable(message.params[key]), benchmarkSurfaceTable: true } };
    }
    if (ipcSerialization) {
      server.send({ jsonrpc: '2.0', ...message });
      return;
    }
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
    server.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    server.stdin.write(body);
  };
  const wait = (map, id, method, action) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      map.delete(id); reject(Error(`Timed out: ${method}; ${stderr}`));
    }, 30000);
    map.set(id, { resolve, reject, timeout });
    action();
  });
  const request = (method, params) => {
    const id = nextId++;
    return wait(pending, id, method, () => send({ id, method, params }));
  };
  const memory = phase => {
    const id = nextId++;
    return wait(memoryPending, id, phase, () => server.send({
      id, method: 'benchmarkMemory', phase, collect: true,
    }));
  };
  const complete = (map, message) => {
    const waiter = map.get(message.id);
    if (!waiter) return;
    map.delete(message.id); clearTimeout(waiter.timeout);
    if (message.error) waiter.reject(Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  };
  server.on('message', message => {
    if (message.jsonrpc) {
      if (message.method && message.id !== undefined) send({ id: message.id, result: null });
      if (!message.method) complete(pending, message);
    } else complete(memoryPending, message);
  });
  server.stdout.on('data', chunk => {
    incoming = Buffer.concat([incoming, chunk]);
    for (;;) {
      const end = incoming.indexOf('\r\n\r\n');
      if (end < 0) return;
      const length = Number(/Content-Length: (\d+)/i.exec(incoming.subarray(0, end).toString())?.[1]);
      assert.ok(length > 0, 'Valid LSP frame length');
      if (incoming.length < end + 4 + length) return;
      const message = JSON.parse(incoming.subarray(end + 4, end + 4 + length));
      incoming = incoming.subarray(end + 4 + length);
      if (message.method && message.id !== undefined) send({ id: message.id, result: null });
      if (!message.method) complete(pending, message);
    }
  });
  const rejectPending = error => {
    for (const map of [pending, memoryPending]) {
      for (const waiter of map.values()) {
        clearTimeout(waiter.timeout); waiter.reject(error);
      }
      map.clear();
    }
  };
  server.on('error', rejectPending);
  const exited = new Promise(resolve => server.once('exit', (code, signal) => {
    rejectPending(Error(`Server exited ${code}/${signal}: ${stderr}`));
    resolve({ code, signal });
  }));
  const checkpoints = [];
  const checkpoint = async phase => {
    // Ordered stdio barrier before the independent diagnostic IPC channel.
    const report = await request('django/perfReport');
    const usage = await memory(phase);
    checkpoints.push({ ...usage, snapshot: report.snapshot });
    return report.snapshot;
  };
  try {
    await request('initialize', { processId: process.pid, rootUri: null, capabilities: {} });
    send({ method: 'initialized', params: {} });
    await checkpoint('initialized');
    assert.deepEqual(await request('django/updateSurfaceIndex', payload), { applied: true });
    assert.equal((await checkpoint('completeMetadata')).modelCount, models);
    let validatedPaths = 0;
    const labels = Object.keys(payload.surfaceIndex);
    for (let offset = 0; offset < labels.length; offset += 50) {
      const paths = labels.slice(offset, offset + 50).flatMap(baseModelLabel => [
        ...Array.from({ length: 15 }, (_, field) => ({ baseModelLabel,
          value: `field_${field}__exact`, method: 'filter' })),
        ...Array.from({ length: 2 }, (_, relation) => ({ baseModelLabel,
          value: `fk_${relation}__field_0__icontains`, method: 'filter' })),
        { baseModelLabel, value: 'field_0__field_size__icontains', method: 'filter' },
      ]);
      const validated = await request('django/validateLookupPaths', { paths });
      assert.equal(validated.length, paths.length);
      for (let index = 0; index < paths.length; index++) {
        assert.equal(validated[index].resolved, true, JSON.stringify(paths[index]));
      }
      validatedPaths += paths.length;
    }
    // Negative control makes the real resolver check meaningful.
    assert.equal((await request('django/validateLookupPaths', { paths: [{
      baseModelLabel: labels[0], value: 'benchmark_missing_field__exact', method: 'filter',
    }] }))[0].resolved, false);
    await checkpoint('allScalarRelationAndTransformPathsValidated');

    const documentCount = Math.max(1, Math.round(files / 100));
    const uris = [];
    let documentBytes = 0;
    for (let index = 0; index < documentCount; index++) {
      const uri = `file:///private/tmp/djls-lsp-memory-${files}-${index}.py`;
      const text = Array.from({ length: 200 }, (_, row) =>
        `query_${row} = Model${index % models}.objects.filter(field_${row % 15}__icontains='value_${row}')`).join('\n');
      documentBytes += Buffer.byteLength(text);
      uris.push(uri);
      send({ method: 'textDocument/didOpen', params: {
        textDocument: { uri, languageId: 'python', version: 1, text },
      } });
    }
    await checkpoint('documentsOpen');
    let version = 1;
    const query = async expression => {
      const text = `${expression}`;
      send({ method: 'textDocument/didChange', params: {
        textDocument: { uri: uris[0], version: ++version }, contentChanges: [{ text }],
      } });
      const response = await request('textDocument/completion', {
        textDocument: { uri: uris[0] }, position: { line: 0, character: text.length },
      });
      return (Array.isArray(response) ? response : response.items).map(item => item.label);
    };
    assert.ok((await query('Model0.objects.filter(field_0__field_size__i')).includes('icontains'));
    assert.ok((await query('Model0.objects.filter(fk_0__field_0__i')).includes('icontains'));
    assert.ok((await query('Model0.objects.filter(field_')).includes('field_14'));
    // Exercise every model through the active FSM path, then fill its cache.
    for (let model = 0; model < models; model++) {
      assert.ok((await query(`Model${model}.objects.filter(field_`)).includes('field_14'));
    }
    for (let key = 0; key < 300; key++) {
      const model = key % models, field = Math.floor(key / models) % 15;
      assert.ok((await query(`Model${model}.objects.filter(field_${field}__e`)).includes('exact'));
    }
    const warmed = await checkpoint('allModelsAndCompletionCache');
    assert.equal(warmed.modelCount, models);
    assert.equal(warmed.completionCacheSize, 256);
    for (let revision = 0; revision < saveDeltas.length; revision++) {
      const delta = saveDeltas[revision];
      assert.deepEqual(await request('django/updateSurfaceIndexDelta', delta.params), { applied: true });
      const labels = await query(delta.expectedOutputKind === 'DateField'
        ? 'Model0.objects.filter(field_0__field_size__ye'
        : 'Model0.objects.filter(field_0__field_size__i');
      assert.ok(labels.includes(delta.expectedOutputKind === 'DateField' ? 'year' : 'icontains'));
      const chunk = delta.params.lookupCatalogDelta['app0.Model0'];
      const root = chunk.types[chunk.fields['app0.Model0'].field_0];
      const output = chunk.types[root.transforms.field_size];
      const expectedNames = [...new Set([...output.lookups, ...Object.keys(output.transforms)])].sort();
      const returnedNames = await query('Model0.objects.filter(field_0__field_size__');
      const actualNames = [...new Set(returnedNames)].sort();
      assert.deepEqual(actualNames, expectedNames, `Exact catalogue names after revision${revision + 1}`);
      if (delta.expectedOutputKind === 'CharField') {
        const removedTransformNames = await query('Model0.objects.filter(field_0__field_size__ye');
        assert.ok(!removedTransformNames.includes('year'));
      }
      assert.ok((await query('Model1.objects.filter(field_0__field_size__i')).includes('icontains'));
      assert.equal((await checkpoint(`realSaveDelta${revision + 1}`)).modelCount, models);
    }
    for (const uri of uris) send({ method: 'textDocument/didClose', params: { textDocument: { uri } } });
    await checkpoint('documentsClosed');

    // Same complete data over a fresh transport parse must not retain generations.
    for (let revision = 0; revision < 5; revision++) {
      assert.deepEqual(await request('django/updateSurfaceIndex', payload), { applied: true });
      assert.equal((await checkpoint(`identicalFullSnapshot${revision + 1}`)).modelCount, models);
    }
    assert.deepEqual(await request('django/updateSurfaceIndex', {
      surfaceIndex: {}, surfaceFingerprints: {}, modelNames: [], customLookups: {},
      customLookupsFingerprint: 'benchmark-empty', staticFallback: null,
      staticFallbackFingerprint: null, lookupCatalog: { types: {}, fields: {} },
    }), { applied: true });
    const retired = await checkpoint('metadataRetired');
    assert.equal(retired.modelCount, 0);
    assert.equal(retired.triesBuilt, 0);
    assert.equal(retired.completionCacheSize, 0);
    const baseline = checkpoints[0].current.heapUsed;
    for (const point of checkpoints) point.heapAboveInitializedBytes = point.current.heapUsed - baseline;
    await request('shutdown', null);
    send({ method: 'exit' });
    const exit = await exited;
    assert.equal(exit.code, 0);
    return { pythonFiles: files, models, documentCount, initialDocumentBytes: documentBytes,
      payloadPath, payloadBytes: encoded.length,
      payloadSha256: crypto.createHash('sha256').update(encoded).digest('hex'),
      saveDeltasPath, saveDeltasBytes: saveDeltasEncoded?.length,
      saveDeltasSha256: saveDeltasEncoded && crypto.createHash('sha256').update(saveDeltasEncoded).digest('hex'),
      checkpoints, checks: { completeMetadataApplied: true, everyModelScalarFieldsResolved: true,
        validatedPaths, missingFieldNegativeControl: true,
        foreignKeyTargetLookupResolved: true, instanceSpecificTransformResolved: true,
        everyModelCompletionExercised: true, triesBuiltThroughActivePath: warmed.triesBuilt,
        completionCacheAt256EntryCap: true,
        realSaveDeltasApplied: saveDeltas.length,
        dynamicOutputAndStaleCandidateRetirementCheckedEverySave: saveDeltas.length > 0,
        identicalFullSnapshotsApplied: 5, documentsClosed: true, emptyMetadataRetired: true }, exit };
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill(); await exited;
    }
  }
}

async function main() {
  assert.equal((process.argv.length - 2) % 2, 0, 'Use payload-path file-count pairs');
  assert.ok(process.argv.length > 2);
  const rows = [];
  for (let index = 2; index < process.argv.length; index += 2) {
    const files = Number(process.argv[index + 1]);
    assert.ok(Number.isInteger(files) && files > 0);
    rows.push(await measure(process.argv[index], files));
  }
  console.log(JSON.stringify({ date: '2026-10-09', platform: process.platform,
    arch: process.arch, nodeVersion: process.version,
    experimentalFrozenTupleSharing: process.env.DJLS_BENCH_SHARE_SURFACE_TUPLES === '1', rows,
    experimentalInplaceTableWire: tableWire,
    experimentalInplaceSurfacePool: process.env.DJLS_BENCH_SURFACE_POOL_INPLACE ?? null,
    ipcSerialization: ipcSerialization ?? null,
    scope: `Fresh actual Node LSP process per tier, full configured Django6 surface/catalogue, real ${ipcSerialization ? 'Node IPC (' + ipcSerialization + ')' : 'stdio'} completions and TextDocuments. Diagnostic GC after ordered LSP barriers. Reports total process V8 heap and above-initialized difference, RSS/external/arrayBuffers separately. Observed peak samples JSON parse/IPC receive/index/checkpoint boundaries and is a lower bound, not true peak. Optional experimentalInplaceTableWire and experimentalInplaceSurfacePool transform only benchmark sender/JSON parse preload; production handlers unchanged and sender CPU/heap excluded here. File count labels describe Python source fixture; current LSP perFile index is empty. No extension-host, dependency-index, Python, native-process-tree, persistent cache or aggregate memory coverage. No ordinary latency or global speedup claim.` }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
