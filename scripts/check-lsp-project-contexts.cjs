'use strict';
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {createMessageConnection, StreamMessageReader, StreamMessageWriter} = require('vscode-jsonrpc/node');
const {SurfaceSnapshotEncoder} = require('../out/client/surfaceSnapshotEncoder.js');

async function main() {
  const server = spawn(process.execPath, ['out/server/server.js', '--stdio']);
  let stderr = '';
  server.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
  const connection = createMessageConnection(new StreamMessageReader(server.stdout), new StreamMessageWriter(server.stdin));
  connection.onRequest(() => null);
  connection.listen();
  const exited = new Promise(resolve => server.once('exit', (code, signal) => resolve({code, signal})));
  const watchdog = setTimeout(() => server.kill(), 30000);
  try {
    await connection.sendRequest('initialize', {processId: process.pid, rootUri: null, capabilities: {}});
    connection.sendNotification('initialized', {});
    const contexts = ['one', 'two'].map(name => ({root: '/repo/' + name, importRoot: '/repo/' + name,
      namespace: name, candidates: ['config.settings'], phase: 'ready',
      models: {[name + '.inventory.Item']: {djangoLabel: 'inventory.Item', sourceModule: 'inventory.models', module: name + '.inventory.models'}},
      lookupKinds: {IntegerField: 'one:integer', DateField: 'two:date'}}));
    const packet = {projectContexts: contexts, surfaceIndex: {
      'one.inventory.Item': {instance: {score: ['scalar', null, 'field', 'IntegerField'], only_one: ['scalar', null, 'field', 'CharField']}},
      'two.inventory.Item': {instance: {score: ['scalar', null, 'field', 'DateField'], only_two: ['scalar', null, 'field', 'CharField']}},
    }, lookupCatalog: {types: {
      'one:integer': {fieldKind: 'IntegerField', lookups: ['exact', 'gte'], transforms: {}},
      'two:date': {fieldKind: 'DateField', lookups: ['exact'], transforms: {year: 'one:integer'}},
    }, fields: {'one.inventory.Item': {score: 'one:integer'}, 'two.inventory.Item': {score: 'two:date'}},
      kinds: {}, expressionFields: {}, relationPaths: {}}};
    const versions = new Map();
    async function complete(name, expression) {
      const uri = 'file:///repo/' + name + '/views.py';
      const text = 'Item.objects.filter(' + expression;
      const version = (versions.get(uri) ?? 0) + 1;
      versions.set(uri, version);
      if (version === 1) connection.sendNotification('textDocument/didOpen', {textDocument: {uri, languageId: 'python', version, text}});
      else connection.sendNotification('textDocument/didChange', {textDocument: {uri, version}, contentChanges: [{text}]});
      const result = await connection.sendRequest('textDocument/completion', {textDocument: {uri}, position: {line: 0, character: text.length}});
      return (Array.isArray(result) ? result : result.items).map(item => item.label);
    }
    const encoder = new SurfaceSnapshotEncoder();
    const full = encoder.prepare(packet);
    assert.deepEqual(await connection.sendRequest('django/updateSurfaceIndex', full.payload), {applied: true});
    encoder.commit(full);
    for (let i = 0; i < 2; i++) {
      assert.deepEqual((await complete('one', 'only_')).sort(), ['only_one']);
      assert.deepEqual((await complete('two', 'only_')).sort(), ['only_two']);
      assert((await complete('one', 'score__')).includes('gte'));
      assert(!(await complete('one', 'score__')).includes('year'));
      assert((await complete('two', 'score__')).includes('year'));
    }
    assert.deepEqual(await complete('shared', 'only_'), [], 'A shared file cannot arbitrarily select a colliding model');
    const next = structuredClone(packet);
    next.surfaceIndex['one.inventory.Item'].instance.saved = ['scalar', null, 'field', 'CharField'];
    const delta = encoder.prepare(next);
    assert.deepEqual(await connection.sendRequest('django/updateSurfaceIndex', delta.payload), {applied: true});
    encoder.commit(delta);
    assert((await complete('one', 'sa')).includes('saved'));
    assert(!(await complete('two', 'sa')).includes('saved'));
    await connection.sendRequest('django/clearSurfaceIndex', {});
    assert.deepEqual(await complete('one', 'only_'), []);
    await connection.sendRequest('shutdown');
    connection.sendNotification('exit');
    assert.equal((await exited).code, 0, stderr);
    console.log('lsp-project-contexts: actual full/delta transport, interleaved completions, colliding names, field types and retirement passed');
  } finally {
    clearTimeout(watchdog);
    connection.dispose();
    if (server.exitCode === null && server.signalCode === null) { server.kill(); await exited; }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
