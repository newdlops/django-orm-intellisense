import assert from 'node:assert/strict';
import type { DjangoProjectContext } from '../client/protocol';
import { attachProjectModelSources, projectForFile, projectWorkspaceView } from './projectScope';
import { buildWorkspaceIndex } from './workspaceIndexer';

const contexts: DjangoProjectContext[] = ['one', 'two'].map(name => ({
  root: '/repo/' + name, importRoot: '/repo/' + name, namespace: name,
  candidates: ['config.settings'], phase: 'ready',
  lookupKinds: {CharField: name + ':char'},
  models: {[name + '.inventory.Item']: {djangoLabel: 'inventory.Item',
    sourceModule: 'inventory.models', module: name + '.inventory.models', filePath: '/repo/' + name + '/inventory/models.py'}},
}));
const index = buildWorkspaceIndex({
  'one.inventory.Item': {instance: {first: ['scalar', null, 'field', 'CharField']}},
  'two.inventory.Item': {instance: {second: ['scalar', null, 'field', 'CharField']}},
}, [], {}, undefined, {types: {}, fields: {}, kinds: {}, expressionFields: {}, relationPaths: {}});
attachProjectModelSources(index, contexts);
const one = projectWorkspaceView(index, contexts, 'file:///repo/one/views.py');
const two = projectWorkspaceView(index, contexts, '/repo/two/views.py');
assert.equal(one.modelLabelByName.get('Item'), 'one.inventory.Item');
assert.equal(two.modelLabelByName.get('Item'), 'two.inventory.Item');
assert.equal(one.models.get('one.inventory.Item'), index.models.get('one.inventory.Item'), 'Views share field metadata');
assert(!one.models.has('two.inventory.Item'));
assert.equal(one.lookupCatalog?.kinds?.CharField, 'one:char');
assert.equal(two.lookupCatalog?.kinds?.CharField, 'two:char');
assert.equal(index.models.get('two.inventory.Item')?.filePath, '/repo/two/inventory/models.py');
assert(!projectWorkspaceView(index, contexts, '/repo/shared.py').modelLabelByName.has('Item'), 'Ambiguous names are never picked arbitrarily');
assert.equal(projectForFile(contexts, '/repo/one-other/views.py'), undefined, 'Directory boundary is exact');
assert.equal(projectForFile([{...contexts[0], rootAliases: ['/alias/one']}], 'file:///alias/one/views.py')?.namespace, 'one');
assert.equal(projectForFile([...contexts, {...contexts[1], root: '/repo/one/nested'}], '/repo/one/nested/views.py')?.namespace, 'two');
assert.equal(projectForFile([{...contexts[0], root: 'C:\\Repo\\One'}], 'file:///C:/Repo/One/views.py')?.namespace, 'one');
console.log('projectScope.test: independent model names, catalog kinds, source paths, nested roots and ambiguity passed');
