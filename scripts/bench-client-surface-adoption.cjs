'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { root, loadDaemonClass, createDaemon, adopt, clone, state, assertFreshIndex } = require('./client-surface-adoption-harness.cjs');
const Daemon = loadDaemonClass('candidate');
const Baseline = loadDaemonClass(true);
const rounds = Number(process.argv[2] ?? 5);
assert.ok(Number.isSafeInteger(rounds) && rounds > 0);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
const baselineHashes = JSON.parse(fs.readFileSync(path.join(root, 'bench/client-surface-adoption-baseline-hashes.json')));
for (const file of ['src/server/workspaceIndexer.ts', 'out/server/workspaceIndexer.js', 'src/server/lookupCatalog.ts',
  'out/server/lookupCatalog.js', 'src/client/daemon/nativeFastPath.ts', 'out/client/daemon/nativeFastPath.js']) {
  assert.equal(hash(file), baselineHashes[file], `Baseline shared dependency changed: ${file}`);
}
assert.equal(crypto.createHash('sha256').update(zlib.gunzipSync(fs.readFileSync(path.join(root,
  'bench/client-surface-adoption-baseline-analysisDaemon.js.gz')))).digest('hex'), baselineHashes['out/client/daemon/analysisDaemon.js']);

const payloadHashes = {};
const fixtures = Array.from({ length: 3 }, (_, pair) => {
  const read = (phase, kind = 'payload') => {
    const file = `bench/runtime-transport-paired-${pair}-delta-0-${phase}-${kind}.json.gz`;
    payloadHashes[file] = hash(file);
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, file))));
  };
  return { initial: read('cached'), edits: [read('modified'), read('replaced')],
    pending: [read('modified', 'pendingPayload'), read('replaced', 'pendingPayload')] };
});
async function main() {
const samples = [];
let completeComparisons = 0;
let reindexComparisons = 0;
const log = console.log;
console.log = () => {};
try {
  for (let round = 0; round < rounds; round++) {
    for (let pair = 0; pair < fixtures.length; pair++) {
      const fixture = fixtures[pair];
      const daemons = { before: createDaemon(Baseline), after: createDaemon(Daemon) };
      const counts = {};
      for (const [mode, daemon] of Object.entries(daemons)) {
        adopt(daemon, clone(fixture.initial));
        counts[mode] = { fullRebuilds: 0, updateMs: 0 };
        const rebuild = daemon.rebuildLocalWorkspaceIndex;
        daemon.rebuildLocalWorkspaceIndex = function (...args) {
          counts[mode].fullRebuilds++;
          return Reflect.apply(rebuild, this, args);
        };
        const update = daemon.updateLocalWorkspaceIndex;
        daemon.updateLocalWorkspaceIndex = function (...args) {
          const started = performance.now();
          try { return Reflect.apply(update, this, args); }
          finally { counts[mode].updateMs += performance.now() - started; }
        };
      }
      for (let edit = 0; edit < fixture.edits.length; edit++) {
        const order = (round + pair + edit) % 2 ? ['after', 'before'] : ['before', 'after'];
        for (const response of fixture.pending[edit]) {
          for (const mode of order) {
            const daemon = daemons[mode];
            const result = clone(response);
            daemon.request = async () => result;
            await daemon.reindexFile('archived-model-or-helper-source.py');
          }
          assert.deepStrictEqual(state(daemons.after), state(daemons.before));
          reindexComparisons++;
        }
        for (const mode of order) {
          const daemon = daemons[mode];
          const params = clone(fixture.edits[edit]);
          const oldModels = new Map(daemon.localWorkspaceIndexForTesting.models);
          const before = { ...counts[mode] };
          const started = performance.now();
          adopt(daemon, params);
          const wallMs = performance.now() - started;
          const models = daemon.localWorkspaceIndexForTesting.models;
          samples.push({ round, pair, edit, mode, wallMs,
            indexUpdateMs: counts[mode].updateMs - before.updateMs,
            fullRebuilds: counts[mode].fullRebuilds - before.fullRebuilds,
            reusedModels: [...models].filter(([label, model]) => oldModels.get(label) === model).length,
            models: models.size });
        }
        assert.deepStrictEqual(state(daemons.after), state(daemons.before));
        assertFreshIndex(daemons.after);
        completeComparisons++;
      }
    }
  }
} finally { console.log = log; }

function describe(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return { count: values.length, medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], maxMs: sorted.at(-1) };
}
const report = {
  observedUtc: new Date().toISOString(), rounds, implementation: 'archived rejected candidate against archived production baseline',
  candidateArchiveSha256: hash('bench/client-surface-adoption-candidate-analysisDaemon.js.gz'), sourceSha256: {
    'src/client/daemon/analysisDaemon.ts': hash('src/client/daemon/analysisDaemon.ts'),
    'out/client/daemon/analysisDaemon.js': hash('out/client/daemon/analysisDaemon.js'),
    'scripts/bench-client-surface-adoption.cjs': hash('scripts/bench-client-surface-adoption.cjs'),
    'scripts/client-surface-adoption-harness.cjs': hash('scripts/client-surface-adoption-harness.cjs'),
  }, baselineHashes, payloadHashes, completeComparisons, reindexComparisons,
  scope: 'Actual compiled daemon synchronous adoption of complete archived 500-model/5000-file edit snapshots after the actual reindexFile handler consumes archived model/helper RPC results. Private baseline module and current module share asserted unchanged index/catalog/native dependencies. Input decoding, reindex preparation and complete fresh-index/equivalence checks occur outside measured windows. No editor listeners, native hydration, Python process, actual RPC timing, LSP transport, raw parsing, end-to-end or memory claim.',
  summary: Object.fromEntries(['before', 'after'].map(mode => {
    const selected = samples.filter(sample => sample.mode === mode);
    return [mode, { handler: describe(selected.map(sample => sample.wallMs)),
      fullRebuilds: selected.reduce((sum, sample) => sum + sample.fullRebuilds, 0),
      reusedModels: [...new Set(selected.map(sample => sample.reusedModels))] }];
  })), samples,
};
console.log(JSON.stringify(report));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
