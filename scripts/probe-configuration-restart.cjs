// Domain controls for the real compiled restart classifier, including every
// contributed setting and mixed changes. Scoped-only responses force coverage
// of the resource branch; they are injected controls, not a full VS Code model.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const sourcePath = process.argv[2] || 'out/client/config/settings.js';
const before = process.argv[3] === 'before';
const filename = path.resolve('out/client/config/settings.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const active = { toString: () => 'file:///one/query.py' };
const folder = { toString: () => 'file:///two' };
const vscode = { window: { activeTextEditor: { document: { uri: active } } },
  workspace: { workspaceFolders: [{ uri: folder }] } };
const loaded = { exports: {} };
const nodeRequire = createRequire(filename);
const wrapper = vm.runInThisContext(`(function(exports, require, module) {\n${source}\n})`, { filename: sourcePath });
wrapper(loaded.exports, id => id === 'vscode' ? vscode : nodeRequire(id), loaded);
const manifest = JSON.parse(fs.readFileSync('package.json'));
const keys = Object.keys(manifest.contributes.configuration.properties);
const inlay = 'djangoOrmIntellisense.inlayHints.enabled';
const rows = [];
function check(name, changed, expected, scopedOnly = false) {
  const event = { affectsConfiguration: (section, scope) =>
    (!scopedOnly || scope === folder) && changed.some(key => key === section || key.startsWith(section + '.')) };
  const actual = loaded.exports.isRelevantConfigurationChange(event);
  rows.push({ name, changed, scopedOnly, expected, actual, matches: actual === expected });
}
for (const key of keys) {
  check('global:' + key, [key], key !== inlay);
  check('scoped:' + key, [key], key !== inlay, true);
  if (key !== inlay) check('mixed:' + key, [inlay, key], true);
}
for (const key of ['editor.inlayHints.enabled', 'python.defaultInterpreterPath', 'other.djangoOrmIntellisense']) {
  check('unrelated:' + key, [key], false);
}
check('all-settings-reset', keys, true);
check('unknown-extension-key', ['djangoOrmIntellisense.unknown'], true);
vscode.window.activeTextEditor = undefined;
vscode.workspace.workspaceFolders = [];
check('no-scopes:inlay', [inlay], false);
check('no-scopes:interpreter', ['djangoOrmIntellisense.pythonInterpreter'], true);
const failures = rows.filter(row => !row.matches).map(row => row.name);
if (before) assert.deepEqual(failures, ['global:' + inlay, 'scoped:' + inlay, 'no-scopes:inlay']);
else assert.deepEqual(failures, []);
console.log(JSON.stringify({ sourcePath, sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
  expectedBeforeFailure: before, contributedSettings: keys.length, rows }, null, 2));
