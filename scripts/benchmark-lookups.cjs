// Compare the committed baseline and current code using identical, correctly
// typed surface tuples. Run after `npm run compile` with `node --expose-gc`.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const root = path.resolve(__dirname, '..');
const count = Number(process.env.DJLS_BENCHMARK_MODELS || 3000);
const repetitions = 7;
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

if (process.argv[2] === '--worker') {
  const { buildWorkspaceIndex, diffSurfaceIndex, updateWorkspaceIndexIncremental } =
    require(path.join(process.argv[3], 'workspaceIndexer.js'));
  const { parseLookupChain, getCompletionCandidates } = require(path.join(process.argv[3], 'lookupResolver.js'));
  console.log = () => {};
  const surface = {};
  const fingerprints = {};
  for (let i = 0; i < count; i++) {
    const label = `app.Model${i}`;
    const fields = {};
    for (let f = 0; f < 25; f++) fields[`field_${f}`] = ['scalar', null, 'field', f % 2 ? 'IntegerField' : 'CharField'];
    fields.published = ['scalar', null, 'field', 'DateTimeField'];
    fields.owner = ['instance', `app.Model${(i + 1) % count}`, 'relation', 'ForeignKey'];
    surface[label] = { instance: fields };
    fingerprints[label] = `fingerprint_${i}`;
  }
  const samples = { buildMs: [], fingerprintDiffMs: [], jsonDiffMs: [], incrementalMs: [], chainNs: [], completionNs: [] };
  for (let r = 0; r < repetitions + 1; r++) {
    if (global.gc) global.gc();
    const t0 = performance.now();
    const index = buildWorkspaceIndex(surface, [], {});
    const build = performance.now() - t0;
    const cache = new Map(Object.entries(fingerprints));
    let t = performance.now();
    diffSurfaceIndex(surface, surface, cache, fingerprints);
    const fingerprintDiff = performance.now() - t;
    const jsonCache = new Map(Object.entries(surface).map(([label, receivers]) => [label, JSON.stringify(receivers)]));
    t = performance.now();
    diffSurfaceIndex(surface, surface, jsonCache);
    const jsonDiff = performance.now() - t;
    t = performance.now();
    updateWorkspaceIndexIncremental(index, surface, { added: [], removed: [], changed: ['app.Model1'] }, {}, {});
    const incremental = performance.now() - t;
    // Both parsers receive real registry semantics: transforms are separate
    // from terminal lookups. The old static date table mixed the two.
    const field = index.models.get('app.Model0').fields.get('published');
    field.lookups = field.lookups.filter(name => !field.transforms.includes(name));
    for (let i = 0; i < 1000; i++) parseLookupChain('published__year__gte', 'app.Model0', index);
    t = performance.now();
    for (let i = 0; i < 10000; i++) parseLookupChain('published__year__gte', 'app.Model0', index);
    const chain = (performance.now() - t) * 1e6 / 10000;
    const parsed = parseLookupChain('published__year__', 'app.Model0', index);
    t = performance.now();
    for (let i = 0; i < 10000; i++) getCompletionCandidates(parsed, 'g', index);
    const completion = (performance.now() - t) * 1e6 / 10000;
    if (r > 0) {
      for (const [key, value] of Object.entries({ buildMs: build, fingerprintDiffMs: fingerprintDiff,
        jsonDiffMs: jsonDiff, incrementalMs: incremental, chainNs: chain, completionNs: completion })) samples[key].push(value);
    }
  }
  process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, median(values)]))));
} else {
  const baselineRef = execFileSync('git', ['rev-parse', process.argv[2] || 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'djls-lookup-baseline-'));
  try {
    const ts = require('typescript');
    for (const name of ['fieldLookups', 'lookupResolver', 'workspaceIndexer', 'radixTrie', 'perfTracker', 'types']) {
      const source = execFileSync('git', ['show', `${baselineRef}:src/server/${name}.ts`], { cwd: root, encoding: 'utf8' });
      const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
      fs.writeFileSync(path.join(temp, `${name}.js`), output);
    }
    const run = dir => JSON.parse(execFileSync(process.execPath, ['--expose-gc', __filename, '--worker', dir], { cwd: root, encoding: 'utf8' }));
    const baseline = run(temp);
    const current = run(path.join(root, 'out/server'));
    console.log(JSON.stringify({ baselineRef, timestamp: new Date().toISOString(), node: process.version,
      modelCount: count, repetitions, aggregation: 'median', baseline, current,
      speedup: Object.fromEntries(Object.keys(baseline).map(key => [key, baseline[key] / current[key]])),
    }, null, 2));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
