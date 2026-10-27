'use strict';

const assert = require('node:assert/strict');
const { loadDaemonClass, createDaemon, adopt, clone, state, assertFreshIndex } = require('./client-surface-adoption-harness.cjs');
const Daemon = loadDaemonClass('candidate');
const Baseline = loadDaemonClass(true);
const { getOrBuildFieldTrie } = require('../out/server/workspaceIndexer.js');
let groups = 0;

function packet() {
  const surfaceIndex = {
    'blog.Post': { instance: { title: ['scalar', null, 'field', 'CharField'], author: ['instance', 'blog.Author', 'relation', 'ForeignKey'] },
      manager: { custom: ['queryset', 'blog.Post', 'method', null] } },
    'blog.Author': { instance: { name: ['scalar', null, 'field', 'CharField'] } },
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
    health: { phase: 'ready', capabilities: [] } };
}

function fingerprints(surface) {
  return Object.fromEntries(Object.entries(surface).map(([label, entry]) => [label, JSON.stringify(entry)]));
}

function verify(name, makeNext, extra) {
  const current = createDaemon(Daemon);
  const control = createDaemon(Baseline);
  const initial = packet();
  adopt(current, clone(initial)); adopt(control, clone(initial));
  const unchanged = current.localWorkspaceIndexForTesting.models.get('blog.Author');
  getOrBuildFieldTrie(current.localWorkspaceIndexForTesting, 'blog.Post');
  const next = makeNext(clone(initial));
  adopt(current, clone(next)); adopt(control, clone(next));
  assert.deepStrictEqual(state(current), state(control), `${name}: complete old/new adoption differs`);
  assertFreshIndex(current);
  extra?.(current, unchanged);
  groups++;
}

async function main() {
  const log = console.log;
  console.log = () => {};
  try {
    verify('one model, stable registry', next => {
      next.surfaceIndex['blog.Post'].instance.score = ['scalar', null, 'field', 'IntegerField'];
      next.surfaceFingerprints = fingerprints(next.surfaceIndex);
      return next;
    }, (current, unchanged) => {
      assert.strictEqual(current.localWorkspaceIndexForTesting.models.get('blog.Author'), unchanged,
        'Unchanged application models must be reused');
      assert.ok(!current.localWorkspaceIndexForTesting.fieldTrieByModel.has('blog.Post'));
    });
    verify('custom lookup registration without surface changes', next => {
      next.customLookups = { CharField: ['new_lookup'] }; return next;
    });
    verify('catalog-only root descriptor change', next => {
      next.lookupCatalog.types.special.lookups = ['exact', 'replacement']; return next;
    }, current => assert.ok(current.localWorkspaceIndexForTesting.models.get('blog.Post').fields.get('title').lookups.includes('replacement')));
    verify('retired field, expression and relation overlays', next => {
      next.lookupCatalog.fields['blog.Post'] = {};
      delete next.lookupCatalog.expressionFields['blog.Post'];
      delete next.lookupCatalog.relationPaths['blog.Post'];
      return next;
    });
    verify('kind descriptor registry replacement', next => {
      next.lookupCatalog.types.char.lookups.push('registered'); return next;
    });
    verify('catalog removal', next => { delete next.lookupCatalog; return next; });
    verify('warming empty catalog', next => { next.lookupCatalog = {}; return next; });
    verify('descriptor ID renumbering', next => {
      const catalog = next.lookupCatalog;
      catalog.types = Object.fromEntries(Object.entries(catalog.types).map(([id, value]) => ['new:' + id, value]));
      for (const table of [catalog.fields, catalog.expressionFields]) {
        for (const [label, fields] of Object.entries(table)) {
          table[label] = Object.fromEntries(Object.entries(fields).map(([name, id]) => [name, 'new:' + id]));
        }
      }
      catalog.kinds = Object.fromEntries(Object.entries(catalog.kinds).map(([kind, id]) => [kind, 'new:' + id]));
      return next;
    }, (current, unchanged) => assert.strictEqual(current.localWorkspaceIndexForTesting.models.get('blog.Author'), unchanged));
    verify('missing full fingerprints', next => {
      delete next.surfaceFingerprints;
      next.surfaceIndex['blog.Post'].instance.title[3] = 'IntegerField'; return next;
    }, current => assert.deepStrictEqual(current.surfaceFingerprints, {}));
    verify('unfingerprinted static fallback replacement', next => {
      next.staticFallback = { 'blog.Fallback': { fields: ['new_field'], fieldDetails: { new_field: { fieldKind: 'IntegerField' } } } };
      return next;
    });
    verify('coverage/name ownership replacement', next => {
      delete next.surfaceIndex['blog.Author'];
      next.surfaceIndex['other.Author'] = { instance: { renamed: ['scalar', null, 'field', 'IntegerField'] } };
      next.surfaceFingerprints = fingerprints(next.surfaceIndex); return next;
    });
    verify('empty authoritative surface and catalog', next => {
      next.surfaceIndex = {}; next.surfaceFingerprints = {}; delete next.lookupCatalog; return next;
    });
    verify('shared descriptor consumed by another model', next => {
      next.lookupCatalog.fields['blog.Author'].name = 'special';
      next.lookupCatalog.types.special.lookups = ['cross_model']; return next;
    });

    const reordered = createDaemon(Daemon);
    const collision = packet();
    collision.surfaceIndex['other.Author'] = { instance: { name: ['scalar', null, 'field', 'CharField'] } };
    collision.surfaceFingerprints = fingerprints(collision.surfaceIndex);
    adopt(reordered, clone(collision));
    collision.surfaceIndex = Object.fromEntries(Object.entries(collision.surfaceIndex).reverse());
    adopt(reordered, clone(collision));
    assertFreshIndex(reordered);
    assert.equal(reordered.localWorkspaceIndexForTesting.modelLabelByName.get('Author'), 'blog.Author');
    groups++;

    const fallbackDaemon = createDaemon(Daemon);
    const fallbackControl = createDaemon(Baseline);
    const fieldless = packet();
    fieldless.surfaceIndex['blog.Post'].instance = {};
    fieldless.surfaceFingerprints = fingerprints(fieldless.surfaceIndex);
    fieldless.staticFallback = { 'blog.Post': { fields: ['fallback_old'],
      fieldDetails: { fallback_old: { fieldKind: 'CharField' } } } };
    adopt(fallbackDaemon, clone(fieldless)); adopt(fallbackControl, clone(fieldless));
    const fallbackUnchanged = fallbackDaemon.localWorkspaceIndexForTesting.models.get('blog.Author');
    fieldless.staticFallback['blog.Post'] = { fields: ['fallback_new'],
      fieldDetails: { fallback_new: { fieldKind: 'IntegerField' } } };
    adopt(fallbackDaemon, clone(fieldless)); adopt(fallbackControl, clone(fieldless));
    assert.deepStrictEqual(state(fallbackDaemon), state(fallbackControl));
    assertFreshIndex(fallbackDaemon);
    assert.equal(fallbackDaemon.localWorkspaceIndexForTesting.models.get('blog.Post').fields.get('fallback_new').fieldKind, 'IntegerField');
    assert.ok(!fallbackDaemon.localWorkspaceIndexForTesting.models.get('blog.Post').fields.has('fallback_old'));
    assert.strictEqual(fallbackDaemon.localWorkspaceIndexForTesting.models.get('blog.Author'), fallbackUnchanged);
    fieldless.staticFallback = null;
    adopt(fallbackDaemon, clone(fieldless)); adopt(fallbackControl, clone(fieldless));
    assert.deepStrictEqual(state(fallbackDaemon), state(fallbackControl));
    assertFreshIndex(fallbackDaemon);
    groups++;

    const current = createDaemon(Daemon);
    const initial = packet();
    adopt(current, { ...clone(initial), surfaceTransport: { version: 1, kind: 'full', sequence: 1 } });
    const pending = clone(initial.surfaceIndex['blog.Post']);
    pending.instance.title[3] = 'IntegerField';
    current.request = async () => ({ surfaceIndexDelta: { 'blog.Post': pending }, changedLabels: ['blog.Post'],
      addedLabels: [], removedLabels: [], surfaceFingerprints: { 'blog.Post': JSON.stringify(pending) },
      staticFallbackDelta: { 'blog.Post': { fields: ['title'], fieldDetails: { title: { fieldKind: 'IntegerField' } } } },
      staticFallbackFingerprint: 'pending-fallback' });
    await current.reindexFile('controlled-source.py');
    assert.equal(current.localWorkspaceIndexForTesting.models.get('blog.Post').fields.get('title').fieldKind, 'IntegerField');
    const pendingModel = current.localWorkspaceIndexForTesting.models.get('blog.Post');
    const unchangedModel = current.localWorkspaceIndexForTesting.models.get('blog.Author');
    const globals = clone(initial);
    delete globals.surfaceIndex; globals.surfaceFingerprints = {};
    adopt(current, { ...globals, surfaceTransport: { version: 1, kind: 'delta', sequence: 2, baseSequence: 1 },
      surfaceIndexDelta: {}, removedSurfaceLabels: [] });
    assert.equal(current.localWorkspaceIndexForTesting.models.get('blog.Post').fields.get('title').fieldKind, 'CharField');
    assert.notStrictEqual(current.localWorkspaceIndexForTesting.models.get('blog.Post'), pendingModel,
      'An empty wire delta must still restore a model changed by an intervening real reindex handler');
    assert.strictEqual(current.localWorkspaceIndexForTesting.models.get('blog.Author'), unchangedModel,
      'Retiring a pending fallback must retain unrelated application models');
    assertFreshIndex(current);
    groups++;
  } finally { console.log = log; }
  console.log(JSON.stringify({ passed: groups, implementation: 'archived rejected candidate', oracle: 'actual compiled full-adoption baseline and complete freshly built model/name/lookup/catalog indexes',
    scope: 'component only; no native/editor/LSP/process timing' }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
