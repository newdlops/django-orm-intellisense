'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { SurfaceSnapshotEncoder } = require('../out/client/surfaceSnapshotEncoder.js');
const clone = value => JSON.parse(JSON.stringify(value));
const fingerprints = surface => Object.fromEntries(Object.entries(surface).map(([label, entry]) => [label, JSON.stringify(entry)]));
function packet() {
  const surfaceIndex = {
    'blog.Post': { instance: { title: ['scalar', null, 'field', 'CharField'], author: ['instance', 'blog.Author', 'relation', 'ForeignKey'] },
      manager: { custom: ['queryset', 'blog.Post', 'method', null] } },
    'blog.Author': { instance: { name: ['scalar', null, 'field', 'CharField'] } },
    'other.Author': { instance: { secondary: ['scalar', null, 'field', 'IntegerField'] } },
  };
  const types = {
    char: { fieldKind: 'CharField', lookups: ['exact', 'icontains'], transforms: {} },
    integer: { fieldKind: 'IntegerField', lookups: ['exact', 'gte'], transforms: {} },
    special: { fieldKind: 'CharField', lookups: ['exact', 'tenant'], transforms: {} },
  };
  return { surfaceIndex, surfaceFingerprints: fingerprints(surfaceIndex), customLookups: {},
    lookupCatalog: { types, fields: { 'blog.Post': { title: 'special' }, 'blog.Author': { name: 'char' } },
      kinds: { CharField: 'char', IntegerField: 'integer' }, expressionFields: { 'blog.Post': { title: 'char' } },
      relationPaths: { 'blog.Post': { author: { accessorName: 'author', queryName: 'writer' } } } },
    customLookupsFingerprint: 'registry-a', staticFallback: null, staticFallbackFingerprint: null,
    future: { preserved: ['complete', 'unknown', 'globals'] } };
}
const cases = [
  ['one model replacement', next => { next.surfaceIndex['blog.Post'].instance.score = ['scalar', null, 'field', 'IntegerField']; next.surfaceFingerprints = fingerprints(next.surfaceIndex); }],
  ['custom lookup registration with unchanged fingerprint', next => { next.customLookups = { CharField: ['new_lookup'] }; }],
  ['catalog-only root descriptor change', next => { next.lookupCatalog.types.special.lookups = ['exact', 'replacement']; }],
  ['retired field expression and relation overlays', next => { next.lookupCatalog.fields['blog.Post'] = {}; delete next.lookupCatalog.expressionFields['blog.Post']; delete next.lookupCatalog.relationPaths['blog.Post']; }],
  ['kind descriptor registry replacement', next => { next.lookupCatalog.types.char.lookups.push('registered'); }],
  ['catalog removal', next => { delete next.lookupCatalog; }],
  ['warming empty catalog', next => { next.lookupCatalog = {}; }],
  ['descriptor ID renumbering', next => {
    const catalog = next.lookupCatalog;
    catalog.types = Object.fromEntries(Object.entries(catalog.types).map(([id, value]) => ['new:' + id, value]));
    for (const table of [catalog.fields, catalog.expressionFields]) {
      for (const [label, fields] of Object.entries(table)) table[label] = Object.fromEntries(Object.entries(fields).map(([name, id]) => [name, 'new:' + id]));
    }
    catalog.kinds = Object.fromEntries(Object.entries(catalog.kinds).map(([kind, id]) => [kind, 'new:' + id]));
  }],
  ['missing full fingerprints', next => { delete next.surfaceFingerprints; next.surfaceIndex['blog.Post'].instance.title[3] = 'IntegerField'; }],
  ['unfingerprinted static fallback addition', next => { next.staticFallback = { 'blog.Fallback': { fields: ['new_field'], fieldDetails: { new_field: { fieldKind: 'IntegerField' } } } }; }],
  ['coverage and name ownership replacement', next => { delete next.surfaceIndex['blog.Author']; next.surfaceIndex['new.Author'] = { instance: { renamed: ['scalar', null, 'field', 'IntegerField'] } }; next.surfaceFingerprints = fingerprints(next.surfaceIndex); }],
  ['empty authoritative surface and catalog', next => { next.surfaceIndex = {}; next.surfaceFingerprints = {}; delete next.lookupCatalog; }],
  ['shared descriptor consumed by another model', next => { next.lookupCatalog.fields['blog.Author'].name = 'special'; next.lookupCatalog.types.special.lookups = ['cross_model']; }],
  ['reordered short-name collision ownership', next => { next.surfaceIndex = Object.fromEntries(Object.entries(next.surfaceIndex).reverse()); }],
  ['missing custom lookup fingerprint', next => { delete next.customLookupsFingerprint; next.customLookups = { CharField: ['unfingerprinted'] }; }],
];
async function run(mode) {
  const child = spawn(process.execPath, ['--expose-gc', '--require', path.join(__dirname, 'lsp-snapshot-transport-preload.cjs'),
    process.env.DJLS_BENCH_PRECHANGE_LSP === '1' ? path.join(__dirname, 'lsp-snapshot-baseline-server.cjs')
      : path.resolve(__dirname, '../out/server/server.js'), '--node-ipc'], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], serialization: 'json' });
  let id = 1, stderr = '';
  const pending = new Map(), results = [];
  child.stdout.resume(); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
  function request(method, params, diagnostic = false) {
    const key = id++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(key); reject(Error(`Timeout ${method}: ${stderr}`)); }, 15000);
      pending.set(key, { resolve, reject, timeout });
      child.send({ ...(diagnostic ? {} : { jsonrpc: '2.0' }), id: key, method, params });
    });
  }
  child.on('message', message => {
    if (message.method && message.id !== undefined && message.jsonrpc) { child.send({ jsonrpc: '2.0', id: message.id, result: null }); return; }
    const waiter = pending.get(message.id); if (!waiter) return;
    pending.delete(message.id); clearTimeout(waiter.timeout);
    if (message.error) waiter.reject(Error(JSON.stringify(message.error))); else waiter.resolve(message.result);
  });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timeout); waiter.reject(Error(`LSP exit ${code}/${signal}: ${stderr}`)); }
    pending.clear(); resolve({ code, signal });
  }));
  const encoder = new SurfaceSnapshotEncoder();
  const uri = `file:///private/tmp/djls-lsp-metadata-contracts-${mode}.py`;
  let version = 1, checkedCompletions = 0;
  async function checkComplete() {
    const check = await request('benchmarkSnapshotCheck', { withCompletions: true }, true);
    for (const expected of check.completionChecks ?? []) {
      const text = `Post.objects.filter(${expected.prefix}`;
      child.send({ jsonrpc: '2.0', method: 'textDocument/didChange', params: {
        textDocument: { uri, version: ++version }, contentChanges: [{ text }],
      } });
      const completion = await request('textDocument/completion', { textDocument: { uri }, position: { line: 0, character: text.length } });
      const labels = (Array.isArray(completion) ? completion : completion.items).map(item => item.label).sort();
      assert.deepEqual(labels, expected.labels, 'Warmed actual completion cache must match fresh complete index');
      checkedCompletions++;
    }
    return check;
  }
  async function publish(value) {
    const prepared = mode === 'delta' ? encoder.prepare(value) : undefined;
    const response = await request('django/updateSurfaceIndex', prepared?.payload ?? value);
    assert.deepEqual(response, { applied: true });
    if (prepared) assert.ok(encoder.commit(prepared));
    return prepared?.payload.surfaceTransport?.kind ?? 'legacy';
  }
  async function reset() {
    encoder.reset();
    await request('django/updateSurfaceIndex', { surfaceIndex: {}, surfaceFingerprints: {},
      customLookups: {}, customLookupsFingerprint: `reset${id}`, staticFallback: null,
      staticFallbackFingerprint: `reset${id}` });
  }
  try {
    await request('initialize', { processId: process.pid, rootUri: null, capabilities: {} });
    child.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
    child.send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: {
      textDocument: { uri, languageId: 'python', version, text: '' },
    } });
    for (const [name, change] of cases) {
      try {
        await reset(); const initial = packet();
        await publish(initial); await checkComplete();
        const next = clone(initial); change(next);
        const kind = await publish(next);
        const check = await checkComplete();
        results.push({ name, kind, passed: true, check });
      } catch (error) { results.push({ name, passed: false, error: String(error) }); }
    }
    try {
      await reset(); const initial = packet(); await publish(initial);
      const pendingModel = clone(initial.surfaceIndex['blog.Post']); pendingModel.instance.title[3] = 'IntegerField';
      await request('django/updateSurfaceIndexDelta', { surfaceIndexDelta: { 'blog.Post': pendingModel },
        surfaceFingerprints: { 'blog.Post': JSON.stringify(pendingModel) }, changedLabels: ['blog.Post'], addedLabels: [], removedLabels: [],
        staticFallbackDelta: { 'blog.Post': { fields: ['title'], fieldDetails: { title: { fieldKind: 'IntegerField' } } } }, staticFallbackFingerprint: 'pending' });
      const kind = await publish(initial);
      const check = await checkComplete();
      results.push({ name: 'empty wire delta restores intervening real source update', kind, passed: true, check });
    } catch (error) { results.push({ name: 'empty wire delta restores intervening real source update', passed: false, error: String(error) }); }
    await request('shutdown', null); child.send({ jsonrpc: '2.0', method: 'exit' });
    const exit = await exited; assert.equal(exit.code, 0);
    return { mode, results, checkedCompletions, exit };
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
  }
}
async function main() {
  const runs = [await run('full')];
  if (process.env.DJLS_BENCH_PRECHANGE_LSP !== '1') runs.push(await run('delta'));
  const failures = runs.flatMap(run => run.results.filter(row => !row.passed).map(row => ({ mode: run.mode, name: row.name, error: row.error })));
  console.log(JSON.stringify({ observedUtc: new Date().toISOString(), archivedPrechangeServer: process.env.DJLS_BENCH_PRECHANGE_LSP === '1',
    runs, failures, passed: runs.reduce((n, run) => n + run.results.filter(row => row.passed).length, 0),
    scope: 'Actual Node IPC LSP request handlers. Complete fresh-index oracle for metadata-only changes, catalog retirement/renumbering, shared types, untrusted or missing global fingerprints, fallback, coverage, short-name collision order, empty snapshots and intervening source replies. Both original full transport and negotiated model delta transport.' }));
  if (failures.length) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
