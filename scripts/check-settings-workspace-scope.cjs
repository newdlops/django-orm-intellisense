'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djls-workspace-setting-'));
class Uri { constructor(fsPath) { this.fsPath = fsPath; this.scheme = 'file'; } }
let explicit, inWorkspace = true;
const workspace = {
  workspaceFolders: [{uri: new Uri(root)}],
  getWorkspaceFolder: () => inWorkspace ? {uri: new Uri(root)} : undefined,
  getConfiguration: () => ({get: (key, fallback) => key === 'workspaceRoot' ? explicit : fallback}),
};
const load = Module._load;
Module._load = function(name, ...args) {
  return name === 'vscode' ? {Uri, workspace, window: {}} : Reflect.apply(load, this, [name, ...args]);
};
let getExtensionSettings;
try { ({getExtensionSettings} = require('../out/client/config/settings.js')); }
finally { Module._load = load; }
try {
  const nested = path.join(root, 'services', 'api');
  fs.mkdirSync(nested, {recursive: true});
  fs.writeFileSync(path.join(nested, 'manage.py'), '');
  const uri = new Uri(path.join(nested, 'views.py'));
  assert.equal(getExtensionSettings(uri).workspaceRoot, root, 'Default scope includes sibling projects in the workspace');
  explicit = nested;
  assert.equal(getExtensionSettings(uri).workspaceRoot, nested, 'Explicit containing root retains precedence');
  explicit = undefined;
  inWorkspace = false;
  assert.equal(getExtensionSettings(uri).workspaceRoot, nested, 'Standalone files retain manage.py inference');
  console.log('workspace-scope: containing workspace, explicit root and standalone fallback passed');
} finally { fs.rmSync(root, {recursive: true, force: true}); }
