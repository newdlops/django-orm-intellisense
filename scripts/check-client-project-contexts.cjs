'use strict';
const assert = require('node:assert/strict');
const {loadDaemonClass, createDaemon, adopt} = require('./client-surface-adoption-harness.cjs');

async function main() {
  const daemon = createDaemon(loadDaemonClass());
  const contexts = ['one', 'two'].map(name => ({root: '/repo/' + name, importRoot: '/repo/' + name,
    namespace: name, candidates: ['config.settings'], phase: 'ready',
    models: {[name + '.inventory.Item']: {djangoLabel: 'inventory.Item', sourceModule: 'inventory.models',
      module: name + '.inventory.models', filePath: '/repo/' + name + '/inventory/models.py'}},
    lookupKinds: {CharField: name + ':char'}}));
  adopt(daemon, {projectContexts: contexts, surfaceIndex: {
    'one.inventory.Item': {instance: {first: ['scalar', null, 'field', 'CharField']}},
    'two.inventory.Item': {instance: {second: ['scalar', null, 'field', 'CharField']}},
  }, health: {phase: 'ready', capabilities: []}});
  const calls = [];
  daemon.requestRaw = async (method, params) => {
    calls.push({method, params});
    await new Promise(resolve => setImmediate(resolve));
    return {resolved: true, originModule: params._sourceFile.includes('/one/') ? 'one.inventory.models' : 'two.inventory.models'};
  };
  await Promise.all(['one', 'two'].map(name => daemon.withDocumentContext('/repo/' + name + '/views.py', async () => {
    assert.equal(daemon.findModelLabelByShortName('Item'), name + '.inventory.Item');
    assert.equal(daemon.getLookupIndex().lookupCatalog?.kinds.CharField, undefined);
    const first = await daemon.resolveExportOrigin('inventory.models', 'Item');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(daemon.modelLabelByName.get('Item'), name + '.inventory.Item');
    const second = await daemon.resolveExportOrigin('inventory.models', 'Item');
    assert.equal(first, second, 'A context reuses only its own cached request');
    assert.equal(second.originModule, name + '.inventory.models');
  })));
  assert.equal(calls.length, 2, 'The same local module/symbol gets one request for each project');
  assert.deepEqual(calls.map(call => call.params._sourceFile).sort(), ['/repo/one/views.py', '/repo/two/views.py']);
  assert.equal(daemon.findModelLabelByShortName('Item'), undefined, 'No caller context leaves the collision unresolved');
  assert.equal(Object.keys(daemon.surfaceIndex).length, 2, 'The published repository snapshot retains both projects');
  assert(daemon.getAllModelNames().includes('Item'));
  assert(daemon.getAllModelNames().every(name => !name.includes('.')), 'Published model names remain source class names');
  daemon.retireMetadata();
  assert.equal(daemon.projectContexts.length, 0);
  const combined = createDaemon(loadDaemonClass());
  adopt(combined, {projectContexts: [{root: '/repo', importRoot: '/repo', namespace: 'project',
    candidates: ['config.one', 'config.two'], settingsModules: ['config.one', 'config.two'], phase: 'ready',
    models: {
      'project.common.Shared': {djangoLabel: 'common.Shared', sourceModule: 'common.models', module: 'common.models'},
      'project.one.OnlyOne': {djangoLabel: 'one.OnlyOne', sourceModule: 'one.models', module: 'one.models'},
      'project.two.OnlyTwo': {djangoLabel: 'two.OnlyTwo', sourceModule: 'two.models', module: 'two.models'},
    }}], surfaceIndex: {
      'project.common.Shared': {instance: {title: ['scalar', null, 'field', 'CharField']}},
      'project.one.OnlyOne': {instance: {first: ['scalar', null, 'field', 'IntegerField']}},
      'project.two.OnlyTwo': {instance: {second: ['scalar', null, 'field', 'IntegerField']}},
    }, health: {phase: 'ready', capabilities: []}});
  combined.withDocumentContext('/repo/views.py', () => {
    assert.equal(combined.findModelLabelByShortName('Shared'), 'project.common.Shared');
    assert.equal(combined.findModelLabelByShortName('OnlyOne'), 'project.one.OnlyOne');
    assert.equal(combined.findModelLabelByShortName('OnlyTwo'), 'project.two.OnlyTwo');
    assert.equal(combined.getLookupIndex().models.size, 3, 'One project view retains every settings registry');
  });
  combined.retireMetadata();
  console.log('client-project-contexts: interleaved requests, scoped cache, name maps, publication and retirement passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
