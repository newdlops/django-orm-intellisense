// Resident-state latency, event-loop responsiveness, export caching and races.
// Run after npm run compile && npm run build:native:dev.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { loadNative } = require('../out/client/native/loader.js');
const fast = require('../out/client/daemon/nativeFastPath.js');
const { buildWorkspaceIndex } = require('../out/server/workspaceIndexer.js');
const n = loadNative();
function quietBuildIndex(...args) {
  const log = console.log;
  console.log = () => {};
  try { return buildWorkspaceIndex(...args); } finally { console.log = log; }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djls-native-performance-'));
process.env.DJANGO_ORM_INTELLISENSE_CACHE_DIR = path.join(root, 'cache');
let report;

function surface(count) {
  const result = {};
  for (let i = 0; i < count; i++) {
    const fields = {};
    for (let j = 0; j < 25; j++) fields[`field_${j}`] = ['scalar', null, 'field', j % 2 ? 'IntegerField' : 'CharField'];
    fields.owner = ['instance', `app.Model${(i + 1) % count}`, 'relation', 'ForeignKey'];
    fields.tags = ['related_manager', `app.Model${(i + 1) % count}`, 'relation', 'ManyToManyField'];
    fields.posts = ['related_manager', `app.Model${(i + 1) % count}`, 'reverse_relation', 'reverse_ForeignKey'];
    const label = `app.Model${i}`;
    const methods = ['filter', 'exclude', 'all', 'annotate', 'order_by', 'values', 'values_list',
      'select_related', 'prefetch_related', 'only', 'defer', 'distinct',
      ...Array.from({ length: 48 }, (_, j) => `custom_method_${j}`)];
    const queryset = Object.fromEntries(methods.map(name => [name, ['queryset', label, 'method', null]]));
    result[label] = { instance: fields, model_class: { objects: ['manager', label, 'manager', null] },
      manager: queryset, queryset };
  }
  return result;
}

async function measure(action, query = false) {
  let last = performance.now();
  let maxGapMs = 0;
  let maxQueryMs = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    const start = performance.now();
    maxGapMs = Math.max(maxGapMs, start - last);
    if (query) fast.nativeResolveLookupPath('app.Model0', 'owner__field_0', 'filter');
    maxQueryMs = Math.max(maxQueryMs, performance.now() - start);
    last = start;
    ticks++;
  }, 1);
  const start = performance.now();
  try {
    const result = await action();
    const elapsedMs = performance.now() - start;
    await sleep(5);
    return { elapsedMs, maxGapMs, maxQueryMs, ticks, result };
  } finally {
    clearInterval(timer);
  }
}

async function main() {
  fs.mkdirSync(path.join(root, 'pkg'));
  fs.writeFileSync(path.join(root, 'pkg/__init__.py'), 'from .large import *\n');
  const symbols = Array.from({ length: 5000 }, (_, i) => `class Value${i}:\n    pass`).join('\n');
  fs.writeFileSync(path.join(root, 'pkg/large.py'), symbols);
  report = { timestamp: new Date().toISOString(), node: process.version, profile: 'dev', hydration: [], correctness: [] };
  const fallback = {
    'app.Pending': { fields: ['score'], relations: ['owner'], fieldDetails: {
      score: { fieldKind: 'IntegerField', isRelation: false },
      owner: { fieldKind: 'ForeignKey', isRelation: true, relatedModelLabel: 'app.Model0', relationDirection: 'forward' },
    } },
  };
  const partial = surface(1);
  assert.equal(await fast.hydrateNativeFastPathFromSurface({ workspaceRoot: root, surfaceIndex: partial,
    workspaceIndex: quietBuildIndex(partial, [], {}, fallback) }), true);
  assert.equal(fast.nativeListRelationTargets('').items.length, 2);
  assert.equal(fast.nativeResolveRelationTarget('app.Pending').resolved, true);
  assert.equal(fast.nativeResolveLookupPath('app.Pending', 'score__gt', 'filter').resolved, true);
  assert.equal(fast.nativeResolveLookupPath('app.Pending', 'owner__field_0', 'filter').resolved, true);
  const fallbackOnly = quietBuildIndex({}, [], {}, fallback);
  assert.equal(await fast.hydrateNativeFastPathFromSurface({ workspaceRoot: root, surfaceIndex: {}, workspaceIndex: fallbackOnly }), true);
  assert.equal(fast.nativeResolveLookupPath('app.Pending', 'score__gt', 'filter').resolved, true);
  report.correctness.push('partial and empty surface keeps complete fallback model coverage');
  const counts = (process.env.DJLS_NATIVE_BENCHMARK_COUNTS || '3000,15000').split(',').map(Number);
  for (const count of counts) {
    const input = surface(count);
    fast.dropNativeFastPath();
    const sync = await measure(() => {
      const bytes = Buffer.from(JSON.stringify(input));
      return n.nativeInitFromSurface(root, bytes).modelCount;
    });
    fast.dropNativeFastPath();
    const nativeLogs = [];
    const async = await measure(() => fast.hydrateNativeFastPathFromSurface({ workspaceRoot: root, surfaceIndex: input,
      log: (_level, message) => nativeLogs.push(message) }), true);
    assert.equal(async.result, true);
    assert.equal(n.nativeStateInfo().modelCount, count);
    const resolved = JSON.parse(n.nativeResolveLookupPath('app.Model0', 'owner__field_0', 'filter'));
    assert.equal(resolved.resolved, true);
    const tags = JSON.parse(n.nativeResolveLookupPath('app.Model0', 'tags__field_0', 'filter'));
    assert.equal(tags.resolved, true);
    assert.equal(JSON.parse(n.nativeResolveOrmMember('app.Model0', 'instance', 'tags', null)).memberKind, 'relation');
    const ast = await measure(() => fast.ensureNativeAstModules(root), true);
    assert.equal(ast.result, true);
    const cachePayload = { surfaceIndex: input, modelNames: Object.keys(input) };
    // This synthetic hydration payload has no Python producer witness. Use a
    // separate raw serialization envelope that production prewarm rejects.
    const cacheFile = path.join(root, 'synthetic-serialization.bin');
    const metadata = Buffer.from(JSON.stringify({ formatVersion: 0, benchmark: 'synthetic-serialization' }));
    const cacheSync = await measure(() => n.saveCacheBlob(cacheFile, metadata, Buffer.from(JSON.stringify(cachePayload))));
    const cacheAsync = await measure(() => n.saveCacheBlobChunksAsync(cacheFile, metadata, [Buffer.from(JSON.stringify(cachePayload))]));
    assert.deepEqual(JSON.parse(n.loadCacheBlob(cacheFile).payload), cachePayload);
    const drop = await measure(() => fast.dropNativeFastPath());
    report.hydration.push({ count, payloadBytes: Buffer.byteLength(JSON.stringify(input)), sync, async, ast,
      drop, cacheSync, cacheAsync, cacheScope: 'Synthetic raw JSON/native serialization; production source validation and chunked TS pipeline are excluded.', nativeLogs,
      rssMB: process.memoryUsage().rss / 1024 / 1024 });
  }

  // Cache hit must not clone a module's complete export table.
  await fast.hydrateNativeFastPathFromSurface({ workspaceRoot: root, surfaceIndex: surface(1) });
  fast.resetNativeAstModulesFlag();
  assert.equal(fast.nativeResolveExportOrigin('pkg', 'Value4999'), undefined);
  assert.equal(await fast.ensureNativeAstModules(root), true);
  let start = performance.now();
  const origin = fast.nativeResolveExportOrigin('pkg', 'Value4999');
  const coldMs = performance.now() - start;
  assert.equal(origin.originModule, 'pkg.large');
  start = performance.now();
  for (let i = 0; i < 1000; i++) assert.equal(fast.nativeResolveExportOrigin('pkg', 'Value4999').resolved, true);
  report.exports = { symbols: 5000, coldMs, cachedMeanUs: (performance.now() - start) * 1000 / 1000 };
  fs.writeFileSync(path.join(root, 'pkg/large.py'), `\n\n${symbols}`);
  fast.resetNativeAstModulesFlag();
  assert.equal(fast.nativeResolveExportOrigin('pkg', 'Value4999'), undefined);
  assert.equal(await fast.ensureNativeAstModules(root), true);
  assert.equal(fast.nativeResolveExportOrigin('pkg', 'Value4999').originLine, 10001);
  report.correctness.push('source-edit export invalidation');

  const largeBytes = Buffer.from(JSON.stringify(surface(3000)));
  const small = surface(1);
  const older = n.nativeInitFromSurfaceAsync(root, largeBytes);
  await sleep(5);
  const newer = n.nativeInitFromSurfaceAsync(root, Buffer.from(JSON.stringify(small)));
  assert.equal((await newer).modelCount, 1);
  assert.equal(await older, null);
  assert.equal(n.nativeStateInfo().modelCount, 1);
  report.correctness.push('newer native hydrate wins');
  const dropped = n.nativeInitFromSurfaceAsync(root, largeBytes);
  await sleep(5);
  n.nativeDrop();
  assert.equal(await dropped, null);
  assert.equal(n.nativeStateInfo().initialized, false);
  report.correctness.push('drop cancels pending native hydrate');
  const oldWrapper = fast.hydrateNativeFastPathFromSurface({ workspaceRoot: root, surfaceIndex: surface(3000) });
  const newWrapper = fast.hydrateNativeFastPathFromSurface({ workspaceRoot: root, surfaceIndex: small });
  assert.equal(await newWrapper, true);
  assert.equal(await oldWrapper, false);
  assert.equal(n.nativeStateInfo().modelCount, 1);
  report.correctness.push('newer wrapper snapshot wins');
  await assert.rejects(n.nativeInitFromSurfaceAsync(root, Buffer.from('{invalid')));
  assert.equal(n.nativeStateInfo().modelCount, 1);
  report.correctness.push('invalid payload preserves installed native state');
  const staleAst = n.nativeEnsureAstModules(root);
  n.nativeInvalidateAstModules();
  assert.equal(await staleAst, false);
  report.correctness.push('source edit cancels stale AST merge');
  report.repeatedHydrateRssMB = [];
  const repeatedSurface = surface(3000);
  report.memoryGcEnabled = typeof global.gc === 'function';
  report.repeatedHydrateLiveStates = [];
  report.repeatedHydrateHeapMB = [];
  for (let i = 0; i < 12; i++) {
    global.gc?.();
    assert.equal(await fast.hydrateNativeFastPathFromSurface({ workspaceRoot: root, surfaceIndex: repeatedSurface }), true);
    await sleep(1);
    global.gc?.();
    report.repeatedHydrateRssMB.push(process.memoryUsage().rss / 1024 / 1024);
    report.repeatedHydrateHeapMB.push(process.memoryUsage().heapUsed / 1024 / 1024);
    report.repeatedHydrateLiveStates.push(n.nativeLiveStateCount());
    assert.equal(n.nativeLiveStateCount(), 1);
  }
  await n.nativeDropAsync();
  assert.equal(n.nativeStateInfo().initialized, false);
  assert.equal(n.nativeLiveStateCount(), 0);
  report.correctness.push('one live native state after each of 12 hydrates; zero after drop');
  report.checks = report.hydration.flatMap(sample => [
    { metric: `hydrate${sample.count}EventLoopGapMs`, actual: sample.async.maxGapMs, budget: 50 },
    { metric: `ast${sample.count}EventLoopGapMs`, actual: sample.ast.maxGapMs, budget: 50 },
    { metric: `ast${sample.count}QueryMs`, actual: sample.ast.maxQueryMs, budget: 50 },
    { metric: `drop${sample.count}EventLoopGapMs`, actual: sample.drop.maxGapMs, budget: 50 },
    { metric: `cache${sample.count}EventLoopGapMs`, actual: sample.cacheAsync.maxGapMs, budget: 50 },
  ]).concat({ metric: 'cachedExportMeanUs', actual: report.exports.cachedMeanUs, budget: 100 })
    .map(check => ({ ...check, pass: check.actual <= check.budget }));
  report.allPassed = report.checks.every(check => check.pass);
  fast.dropNativeFastPath();
  console.log(JSON.stringify(report, null, 2));
  if (!report.allPassed) process.exitCode = 1;
}

main().catch(error => {
  if (report) console.log(JSON.stringify({ ...report, failure: String(error) }, null, 2));
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  fast.dropNativeFastPath();
  fs.rmSync(root, { recursive: true, force: true });
});
