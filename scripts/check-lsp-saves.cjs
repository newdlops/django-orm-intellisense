// Verify the actual language-server transport, not only tracker helpers.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { setTimeout: sleep } = require('node:timers/promises');
const server = spawn(process.execPath, ['out/server/server.js', '--stdio']);
let input = Buffer.alloc(0);
const responses = new Map();
const saved = new Set();
let stderr = '';
server.stderr.on('data', chunk => { stderr += chunk; });
function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
  server.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  server.stdin.write(body);
}
server.stdout.on('data', chunk => {
  input = Buffer.concat([input, chunk]);
  while (true) {
    const headerEnd = input.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = input.subarray(0, headerEnd).toString();
    const length = Number(/Content-Length: (\d+)/i.exec(header)?.[1]);
    if (!length || input.length < headerEnd + 4 + length) return;
    const message = JSON.parse(input.subarray(headerEnd + 4, headerEnd + 4 + length));
    input = input.subarray(headerEnd + 4 + length);
    if (message.method === 'django/fileNeedsReindex') saved.add(message.params.uri);
    if (message.id !== undefined && !message.method) responses.set(message.id, message);
    if (message.id !== undefined && message.method) send({ id: message.id, result: [] });
  }
});
async function wait(predicate) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (server.exitCode !== null) throw Error(`LSP exited: ${stderr}`);
    if (Date.now() > deadline) throw Error(`LSP timed out: ${stderr}`);
    await sleep(10);
  }
}
async function main() {
  send({ id: 1, method: 'initialize', params: { processId: process.pid, rootUri: null, capabilities: {} } });
  await wait(() => responses.has(1));
  assert.ok(!responses.get(1).error);
  send({ method: 'initialized', params: {} });
  send({ id: 3, method: 'django/updateSurfaceIndexDelta', params: { surfaceIndexDelta: {} } });
  await wait(() => responses.has(3));
  assert.deepEqual(responses.get(3).result, { applied: false }, 'A delta without an initial snapshot must request full recovery');
  const uris = Array.from({ length: 100 }, (_, i) => pathToFileURL(`/private/tmp/djls-save-${i}.py`).href);
  for (const uri of uris) {
    send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'python', version: 1, text: 'value = 0\n' } } });
    send({ method: 'textDocument/didSave', params: { textDocument: { uri } } });
  }
  send({ id: 2, method: 'textDocument/completion', params: { textDocument: { uri: uris[0] }, position: { line: 0, character: 0 } } });
  // Responses are a transport barrier: all preceding notifications were read.
  await wait(() => responses.has(2));
  assert.equal(saved.size, 0, 'opening unchanged documents must not reindex');
  for (const uri of uris) {
    send({ method: 'textDocument/didChange', params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'value = 1\n' }] } });
    send({ method: 'textDocument/didSave', params: { textDocument: { uri } } });
  }
  await wait(() => saved.size === uris.length);
  for (const uri of uris) assert.ok(saved.has(uri));

  // During runtime warm-up the initial snapshot can contain only fallback
  // fields. Verify actual transport updates, completion caches and field kinds.
  const modelUri = pathToFileURL('/private/tmp/djls-fallback-delta.py').href;
  const fallback = {
    'blog.Post': { fields: ['score'], fieldDetails: { score: { fieldKind: 'IntegerField', isRelation: false } } },
    'blog.Other': { fields: ['name'] },
  };
  send({ method: 'django/updateSurfaceIndex', params: { surfaceIndex: {}, staticFallback: fallback, staticFallbackFingerprint: 'initial' } });
  let documentVersion = 1;
  let requestId = 10;
  async function complete(text, open = false) {
    if (open) send({ method: 'textDocument/didOpen', params: { textDocument: { uri: modelUri, languageId: 'python', version: documentVersion, text } } });
    else send({ method: 'textDocument/didChange', params: { textDocument: { uri: modelUri, version: ++documentVersion }, contentChanges: [{ text }] } });
    const id = requestId++;
    send({ id, method: 'textDocument/completion', params: { textDocument: { uri: modelUri }, position: { line: 0, character: text.length } } });
    await wait(() => responses.has(id));
    assert.ok(!responses.get(id).error);
    return responses.get(id).result.map(item => item.label);
  }
  assert.ok((await complete('Post.objects.filter(score__', true)).includes('gt'));
  send({ method: 'django/updateSurfaceIndexDelta', params: {
    surfaceIndexDelta: {}, addedLabels: [], changedLabels: [], removedLabels: [],
    staticFallbackDelta: { 'blog.Post': { fields: ['score'], fieldDetails: { score: { fieldKind: 'DateField', isRelation: false } } } },
    removedStaticFallbackLabels: [], staticFallbackFingerprint: 'updated',
  } });
  assert.ok((await complete('Post.objects.filter(score__')).includes('year'), 'fallback delta must invalidate cached field type');
  assert.ok((await complete('Other.objects.filter(na')).includes('name'), 'unrelated fallback remains available');
  send({ method: 'django/updateSurfaceIndexDelta', params: {
    surfaceIndexDelta: { 'blog.Post': { instance: { body: ['scalar', null, 'field', 'TextField'] } } },
    addedLabels: ['blog.Post'], changedLabels: [], removedLabels: [],
    staticFallbackDelta: {}, removedStaticFallbackLabels: ['blog.Post'], staticFallbackFingerprint: 'promoted',
  } });
  assert.ok((await complete('Post.objects.filter(bo')).includes('body'), 'surface replaces fallback');
  assert.ok(!(await complete('Post.objects.filter(sc')).includes('score'), 'retired fallback fields do not survive');
  let acknowledgementId = 1000;
  async function update(method, params) {
    const id = acknowledgementId++;
    send({ id, method, params });
    await wait(() => responses.has(id));
    return responses.get(id);
  }
  const snapshot = {
    surfaceIndex: { 'blog.Post': { instance: { body: ['scalar', null, 'field', 'CharField'] } } },
    surfaceFingerprints: { 'blog.Post': 'before' },
    staticFallback: {}, staticFallbackFingerprint: 'none',
  };
  assert.deepEqual((await update('django/updateSurfaceIndex', snapshot)).result, { applied: true });
  const malformed = await update('django/updateSurfaceIndexDelta', {
    surfaceIndexDelta: { 'blog.Post': { instance: { body: null } } },
    changedLabels: ['blog.Post'], surfaceFingerprints: { 'blog.Post': 'after' },
  });
  assert.ok(malformed.error, 'An update that failed to build must not be acknowledged as applied');
  const restored = { ...snapshot,
    surfaceIndex: { 'blog.Post': { instance: { body: ['scalar', null, 'field', 'DateField'] } } },
    surfaceFingerprints: { 'blog.Post': 'after' },
  };
  assert.deepEqual((await update('django/updateSurfaceIndex', restored)).result, { applied: true });
  assert.ok((await complete('Post.objects.filter(body__')).includes('year'), 'Full recovery must rebuild after a partially applied delta even when its fingerprint already matches');
  assert.deepEqual((await update('django/updateSurfaceIndex', { surfaceIndex: {}, staticFallback: {} })).result, { applied: true });
  assert.deepEqual(await complete('Post.objects.filter(bo'), [], 'An empty snapshot must remove the last indexed model');
  assert.deepEqual((await update('django/updateSurfaceIndexDelta', {
    surfaceIndexDelta: {}, staticFallback: {
      'blog.Post': { fields: ['fresh'], fieldDetails: { fresh: { fieldKind: 'IntegerField', isRelation: false } } },
    }, staticFallbackFingerprint: 'only-fallback',
  })).result, { applied: true });
  assert.ok((await complete('Post.objects.filter(fr')).includes('fresh'), 'A full fallback-only delta must not be dismissed as a no-op');
  assert.deepEqual((await update('django/updateSurfaceIndexDelta', {
    surfaceIndexDelta: {}, staticFallback: {
      'blog.Post': { fields: ['newer'], fieldDetails: { newer: { fieldKind: 'DateField', isRelation: false } } },
    },
  })).result, { applied: true });
  assert.ok((await complete('Post.objects.filter(ne')).includes('newer'), 'A full fallback without a fingerprint must be applied');
  assert.ok(!(await complete('Post.objects.filter(fr')).includes('fresh'), 'An unfingerprinted replacement must retire old fallback fields');
  assert.deepEqual((await update('django/updateSurfaceIndexDelta', {
    surfaceIndexDelta: {}, staticFallback: null, staticFallbackFingerprint: null,
  })).result, { applied: true });
  assert.deepEqual(await complete('Post.objects.filter(ne'), [], 'Explicit null must clear fallback state');
  assert.deepEqual((await update('django/updateSurfaceIndexDelta', {
    surfaceIndexDelta: {}, staticFallback: {
      'blog.Post': { fields: ['base'], fieldDetails: { base: { fieldKind: 'IntegerField', isRelation: false } } },
      'blog.Other': { fields: ['retained'] },
    }, staticFallbackDelta: { 'blog.Post': { fields: ['overlaid'] } },
    staticFallbackFingerprint: 'full-with-overlay',
  })).result, { applied: true });
  assert.ok((await complete('Post.objects.filter(ov')).includes('overlaid'), 'Full fallback replacements must include subsequent batch deltas');
  assert.ok(!(await complete('Post.objects.filter(ba')).includes('base'), 'Overlay must replace the earlier full record');
  assert.ok((await complete('Other.objects.filter(re')).includes('retained'), 'Unrelated full fallback models must survive overlay');
  assert.deepEqual((await update('django/updateSurfaceIndexDelta', {
    surfaceIndexDelta: {}, staticFallback: null, staticFallbackDelta: {}, staticFallbackFingerprint: null,
  })).result, { applied: true });
  assert.deepEqual(await complete('Post.objects.filter(ov'), [], 'Null full fallback must clear models even when an empty delta accompanies it');
  console.log(JSON.stringify({ initialSyncReindexes: 0, editedSavedFiles: saved.size, expected: uris.length,
    fallbackDeltaCompletionChecks: 5, acknowledgedUpdates: 8, rejectedMalformedDelta: 1,
    partialFailureRecoveryAndEmptySnapshotChecks: 2, rejectedDeltaBeforeSnapshot: 1,
    fullFallbackOnlyAndNullChecks: 4, fullFallbackOverlayAndEmptyDeltaChecks: 4 }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.kill());
