'use strict';

// Component harness: the actual compiled daemon/indexer, without processes,
// native hydration, editor listeners, or LSP transport. Live coverage is separate.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');

class EventEmitter {
  listeners = new Set();
  event = listener => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}

function loadDaemonClass(variant = 'current') {
  const filename = path.join(root, 'out/client/daemon/analysisDaemon.js');
  const load = Module._load;
  Module._load = function (name, ...args) {
    if (name === 'vscode') return { EventEmitter, window: {}, workspace: {} };
    return Reflect.apply(load, this, [name, ...args]);
  };
  try {
    if (variant === 'current' || variant === false) return require(filename).AnalysisDaemon;
    assert.ok(variant === true || variant === 'baseline' || variant === 'candidate');
    const name = variant === 'candidate' ? 'candidate' : 'baseline';
    const source = zlib.gunzipSync(fs.readFileSync(path.join(root, `bench/client-surface-adoption-${name}-analysisDaemon.js.gz`)));
    const compiled = new Module(filename, module);
    compiled.filename = filename;
    compiled.paths = Module._nodeModulePaths(path.dirname(filename));
    compiled._compile(source.toString('utf8'), filename);
    return compiled.exports.AnalysisDaemon;
  } finally { Module._load = load; }
}

function createDaemon(Daemon) {
  return new Daemon({ asAbsolutePath: file => path.join(root, file) }, { appendLine() {}, dispose() {} });
}

function adopt(daemon, params) {
  daemon.handleServerNotification({ event: 'surfaceIndexChanged', params });
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function state(daemon) {
  const index = daemon.localWorkspaceIndexForTesting;
  return {
    surfaceIndex: daemon.surfaceIndex, surfaceFingerprints: daemon.surfaceFingerprints,
    customLookups: daemon.customLookups, lookupCatalog: daemon.lookupCatalog,
    customLookupsFingerprint: daemon.customLookupsFingerprint,
    staticFallback: daemon.staticFallback, staticFallbackFingerprint: daemon.staticFallbackFingerprint,
    modelNames: daemon.modelNames, modelLabelByName: daemon.modelLabelByName,
    models: index.models, indexNames: index.modelLabelByName,
    lookupTrie: index.lookupTrie, transformTrie: index.transformTrie,
    lookupTypes: index.lookupTypes, indexCatalog: index.lookupCatalog,
    health: daemon.getState(),
  };
}

function assertFreshIndex(daemon) {
  const { buildWorkspaceIndex } = require('../out/server/workspaceIndexer.js');
  const fresh = buildWorkspaceIndex(daemon.surfaceIndex, [...daemon.modelNames], daemon.customLookups,
    daemon.effectiveStaticFallback(), daemon.lookupCatalog);
  const actual = daemon.localWorkspaceIndexForTesting;
  for (const key of ['models', 'modelLabelByName', 'lookupTrie', 'transformTrie', 'lookupTypes', 'lookupCatalog']) {
    assert.deepStrictEqual(actual[key], fresh[key], `Complete fresh-index oracle differs: ${key}`);
  }
}

module.exports = { root, loadDaemonClass, createDaemon, adopt, clone, state, assertFreshIndex };
