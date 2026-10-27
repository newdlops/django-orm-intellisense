// Exercise the real compiled daemon resolver and inlay formatter together.
// Django's fixture supplies the catalog and independent relation validation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const { fixture } = require('../out/client/providers/providerRequestLifecycle.test.js');
const root = path.resolve(__dirname, '..');
const sourcePath = process.argv[2] || 'out/client/daemon/analysisDaemon.js';
const before = process.argv[3] === 'before';
const source = fs.readFileSync(sourcePath, 'utf8');
const filename = path.join(root, 'out/client/daemon/analysisDaemon.js');
const nodeRequire = Module.createRequire(filename);
const originalLoad = Module._load;
const loaded = { exports: {} };
try {
  Module._load = function (id, parent, isMain) {
    if (id === 'vscode') return {};
    return originalLoad.call(this, id, parent, isMain);
  };
  const wrapper = vm.runInThisContext(`(function(exports, require, module, __filename, __dirname) {\n${source}\n})`, { filename: sourcePath });
  wrapper(loaded.exports, nodeRequire, loaded, filename, path.dirname(filename));
} finally { Module._load = originalLoad; }
const python = process.env.DJLS_LOOKUP_TEST_PYTHON || path.join(root, '.e2e-django5/bin/python');
const catalog = JSON.parse(execFileSync(python, ['python/tests/relation_lookup_fixture.py'], {
  cwd: root, env: { ...process.env, PYTHONPATH: path.join(root, 'python') }, encoding: 'utf8',
}));
const { buildWorkspaceIndex } = require('../out/server/workspaceIndexer.js');
const daemon = Object.create(loaded.exports.AnalysisDaemon.prototype);
const indexLog = [];
const originalLog = console.log;
try {
  console.log = (...values) => indexLog.push(values.join(' '));
  daemon.localWorkspaceIndex = buildWorkspaceIndex(catalog.surfaceIndex, [], {}, undefined, catalog.lookupCatalog);
} finally { console.log = originalLog; }
daemon.lookupCatalog = catalog.lookupCatalog;
daemon.currentState = { phase: 'ready', runtime: { bootstrapStatus: 'ready' } };
daemon.currentRequestSource = () => 'diagnostic';
let rpcCalls = 0;
daemon.request = async () => { rpcCalls++; throw Error('Catalog lookups must not call the daemon'); };
const provider = fixture(fs.readFileSync('out/client/providers/pythonProviders.js', 'utf8')
  + '\nmodule.exports.inlayLabelProbe = inlayTypeLabelForResolution;');
const cases = [
  ['forward-relation', 'blog.Post', 'author', 'Author'],
  ['trailing-relation', 'blog.Post', 'author__', 'Author'],
  ['nested-relation', 'blog.Post', 'author__profile', 'Profile'],
  ['nested-trailing-relation', 'blog.Post', 'author__profile__', 'Profile'],
  ['reverse-relation', 'blog.Author', 'posts', 'Post'],
  ['many-to-many', 'blog.Post', 'tags', 'Tag'],
  ['relation-lookup', 'blog.Post', 'author__in', 'Author'],
  ['scalar', 'blog.Post', 'author__profile__timezone', 'str'],
  ['id-operand', 'blog.Post', 'author_id__in', 'list[int]'],
  ['invalid-relation-path', 'blog.Post', 'author__not_a_field', undefined],
];
async function main() {
  try {
    const rows = [];
    for (const [name, model, value, expected] of cases) {
      const resolution = await daemon.resolveLookupPath(model, value, 'filter', true);
      const [batch] = await daemon.resolveLookupPathBatch([{ baseModelLabel: model, value, method: 'filter' }]);
      assert.deepEqual(batch, resolution, `${name}: single and batch metadata must agree`);
      const actual = provider.providers.inlayLabelProbe(resolution);
      rows.push({ name, model, value, expected: expected ?? null, actual: actual ?? null,
        matches: actual === expected, resolution });
    }
    if (before) assert.deepEqual(rows.filter(row => !row.matches).map(row => row.name),
      cases.slice(0, 7).map(([name]) => name));
    else assert.ok(rows.every(row => row.matches), JSON.stringify(rows));
    for (const control of catalog.oracleCases) {
      const resolution = await daemon.resolveLookupPath(control.model, control.path, control.method, true);
      assert.equal(resolution.resolved, control.resolved, JSON.stringify(control));
    }
    assert.equal(rpcCalls, 0);
    assert.equal(provider.sourceCalls, 0);
    console.log(JSON.stringify({ sourcePath, sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
      expectedBeforeFailure: before, djangoVersion: catalog.djangoVersion, indexLog, rows,
      djangoRelationValidationControls: catalog.oracleCases.length, rpcCalls,
      providerSourceCalls: provider.sourceCalls }, null, 2));
  } finally {
    provider.dispose();
    assert.equal(provider.adapterCount, 0);
    assert.equal(provider.emitterCount, 0);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
