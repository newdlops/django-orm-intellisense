'use strict';
const assert = require('node:assert/strict');
const {execFileSync, spawn} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const {createMessageConnection, StreamMessageReader, StreamMessageWriter} = require('vscode-jsonrpc/node');
const {loadDaemonClass, createDaemon, adopt} = require('./client-surface-adoption-harness.cjs');

async function main() {
  const python = process.env.DJLS_MULTI_TEST_PYTHON;
  assert(python, 'Set DJLS_MULTI_TEST_PYTHON to a fresh test environment');
  const payload = JSON.parse(execFileSync(python, ['-B', 'python/tests/project_settings_fixture.py'], {
    env: {...process.env, PYTHONPATH: 'python', PYTHONDONTWRITEBYTECODE: '1'}, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  }));
  assert.equal(payload.health.runtime.readyProjectCount, 2);
  const daemon = createDaemon(loadDaemonClass());
  adopt(daemon, payload);
  for (const name of ['one', 'two']) {
    const context = payload.projectContexts.find(context => context.root.endsWith('/' + name));
    const label = Object.keys(context.models).find(label => label.endsWith('.inventory.Item'));
    daemon.withDocumentContext(context.root + '/views.py', () => {
      assert.equal(daemon.findModelLabelByShortName('Item'), label);
      const result = daemon.listLookupPathCompletionsLocal(label, 'score__', 'filter');
      assert(result?.resolved);
      const names = result.items.map(item => item.name.replace(/^score__/, ''));
      assert.equal(daemon.getLookupIndex().models.get(label).fields.get('score').fieldKind, name === 'one' ? 'CharField' : 'DateField');
      assert(names.includes(name === 'one' ? 'icontains' : 'year'), JSON.stringify(names));
      if (name === 'one') assert(!names.includes('year'), JSON.stringify(names));
    });
  }
  // Exercise the actual resident field store with the qualified wire IDs.
  // No AST/source-location preparation is requested by this check.
  const native = require('../out/client/daemon/nativeFastPath.js');
  try {
    assert(await native.hydrateNativeFastPathFromSurface({workspaceRoot: process.cwd(),
      surfaceIndex: payload.surfaceIndex, workspaceIndex: daemon.localWorkspaceIndexForTesting}));
    for (const context of payload.projectContexts) {
      const name = context.root.endsWith('/one') ? 'one' : 'two';
      const label = Object.keys(context.models).find(label => label.endsWith('.inventory.Item'));
      const member = native.nativeResolveOrmMember(label, 'instance', 'score');
      assert.equal(member?.item?.fieldKind, name === 'one' ? 'CharField' : 'DateField');
      assert(native.nativeResolveOrmMember(label, 'instance', 'only_' + name)?.resolved);
      assert(!native.nativeResolveOrmMember(label, 'instance', 'only_' + (name === 'one' ? 'two' : 'one'))?.resolved);
    }
  } finally { native.dropNativeFastPath(); }
  const server = spawn(process.execPath, ['out/server/server.js', '--stdio']);
  let stderr = '';
  server.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-10000); });
  const connection = createMessageConnection(new StreamMessageReader(server.stdout), new StreamMessageWriter(server.stdin));
  connection.onRequest(() => null);
  connection.listen();
  const exited = new Promise(resolve => server.once('exit', code => resolve(code)));
  const watchdog = setTimeout(() => server.kill(), 20000);
  try {
    await connection.sendRequest('initialize', {processId: process.pid, rootUri: null, capabilities: {}});
    connection.sendNotification('initialized', {});
    assert.deepEqual(await connection.sendRequest('django/updateSurfaceIndex', payload), {applied: true});
    for (const context of payload.projectContexts) {
      const name = context.root.endsWith('/one') ? 'one' : 'two';
      const uri = pathToFileURL(context.root + '/views.py').href;
      let version = 1;
      for (const prefix of ['only_', 'score__']) {
        const text = 'Item.objects.filter(' + prefix;
        if (version === 1) connection.sendNotification('textDocument/didOpen', {textDocument: {uri, languageId: 'python', version, text}});
        else connection.sendNotification('textDocument/didChange', {textDocument: {uri, version}, contentChanges: [{text}]});
        version++;
        const result = await connection.sendRequest('textDocument/completion', {textDocument: {uri}, position: {line: 0, character: text.length}});
        const names = (Array.isArray(result) ? result : result.items).map(item => item.label);
        assert(names.includes(prefix === 'only_' ? 'only_' + name : name === 'one' ? 'icontains' : 'year'), JSON.stringify(names));
        if (prefix === 'only_') assert(!names.includes('only_' + (name === 'one' ? 'two' : 'one')));
        else if (name === 'one') assert(!names.includes('year'));
      }
    }
    await connection.sendRequest('shutdown');
    connection.sendNotification('exit');
    assert.equal(await exited, 0, stderr);
    console.log(`integrated-project-settings: real Django ${payload.health.runtime.djangoVersion} registries → client/native fields → actual LSP completions passed`);
  } finally {
    clearTimeout(watchdog);
    connection.dispose();
    if (server.exitCode === null && server.signalCode === null) { server.kill(); await exited; }
    daemon.retireMetadata();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
