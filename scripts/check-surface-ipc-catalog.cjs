'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const { buildWorkspaceIndex } = require('../out/server/workspaceIndexer.js');
const { applyLookupCatalogDelta } = require('../out/server/lookupCatalog.js');

async function check(serialization, payload) {
  const child = fork(require.resolve('./probe-surface-ipc-serialization.cjs'), ['--worker'], { serialization, silent: true });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  let error;
  let result;
  try {
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Metadata IPC timed out')), 10000);
      child.once('message', value => { clearTimeout(timer); resolve(value); });
      try {
        child.send({ op: 'snapshot', id: 1, payload }, err => {
          if (err) { clearTimeout(timer); reject(err); }
        });
      } catch (err) { clearTimeout(timer); reject(err); }
    });
    try { result = await response; } catch (err) { error = err; }
    if (serialization === 'json') {
      assert.ifError(error);
      assert.equal(result.hash, crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'));
    } else {
      assert.ok(error);
      assert.match(error.message, /could not be cloned/);
    }
    child.send({ op: 'close', id: 2 });
    const exit = await exited;
    assert.equal(exit.code, 0);
    console.log(JSON.stringify({ serialization, payloadAccepted: !error,
      completeValuesEqual: serialization === 'json', error: error?.message, exit }));
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
  }
}

async function main() {
  const payload = JSON.parse(fs.readFileSync('/private/tmp/djls-current446-lsp-5000.json'));
  const deltas = JSON.parse(zlib.gunzipSync(fs.readFileSync('bench/lsp-save-memory-5000-deltas.json.gz')));
  const index = buildWorkspaceIndex(payload.surfaceIndex, payload.modelNames,
    payload.customLookups, payload.staticFallback, payload.lookupCatalog);
  applyLookupCatalogDelta(index, deltas[0].params.lookupCatalogDelta);
  const updated = { ...payload, lookupCatalog: index.lookupCatalog };
  await check('json', updated);
  await check('advanced', updated);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
