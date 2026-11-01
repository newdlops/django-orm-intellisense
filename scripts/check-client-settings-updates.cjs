'use strict';
const assert = require('node:assert/strict');
const {loadDaemonClass, createDaemon, adopt, state, clone, assertFreshIndex} = require('./client-surface-adoption-harness.cjs');

const daemon = createDaemon(loadDaemonClass());
const payload = {
  surfaceIndex: {'project.common.Shared': {instance: {title: ['scalar', null, 'field', 'CharField']},
    queryset: {only_one: ['queryset', 'project.common.Shared', 'method', null]}}},
  surfaceFingerprints: {'project.common.Shared': 'shared-v1'},
  lookupCatalog: {fields: {}, expressionFields: {}, relationPaths: {}, kinds: {}, types: {}},
  customLookups: {}, customLookupsFingerprint: 'catalog-v1',
  staticFallback: null, staticFallbackFingerprint: undefined,
  projectContexts: [{namespace: 'project', root: '/repo', importRoot: '/repo', candidates: [], phase: 'starting',
    models: {'project.common.Shared': {djangoLabel: 'common.Shared', sourceModule: 'common.models', module: 'common.models'}}}],
  health: {phase: 'starting', capabilities: []},
};
adopt(daemon, clone(payload));
const before = state(daemon);
const oldModel = before.models.get('project.common.Shared');
adopt(daemon, {...clone(payload), projectContexts: [{...clone(payload.projectContexts[0]), phase: 'ready'}],
  health: {phase: 'ready', capabilities: []}});
assert.equal(daemon.getState().phase, 'ready');
assert.equal(daemon.projectContexts[0].phase, 'ready');
assert.ok(state(daemon).models === before.models, 'A settings health update rebuilt the unchanged client model index');
assert.ok(state(daemon).surfaceIndex === before.surfaceIndex, 'An unchanged publication replaced the model table');
const changed = clone(payload);
changed.surfaceIndex['project.common.Shared'].instance.saved = ['scalar', null, 'field', 'BooleanField'];
changed.surfaceFingerprints['project.common.Shared'] = 'shared-v2';
adopt(daemon, changed);
assert(daemon.getLookupIndex().models.get('project.common.Shared').fields.has('saved'));
assertFreshIndex(daemon);
assert(!oldModel.fields.has('saved'), 'Old model record was mutated');
daemon.retireMetadata();
console.log('client-settings-updates: unchanged health preserves indexes; changed fields update with fresh-index parity');
