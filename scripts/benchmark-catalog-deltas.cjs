// Measure bounded descriptor replacement after every model has been edited.
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { buildWorkspaceIndex } = require('../out/server/workspaceIndexer');
const { applyLookupCatalogDelta } = require('../out/server/lookupCatalog');

const python = process.env.DJLS_LOOKUP_TEST_PYTHON || path.resolve('.e2e-django5/bin/python');
const fixture = JSON.parse(execFileSync(python, ['python/tests/lookup_catalog_fixture.py'], {
  encoding: 'utf8', env: { ...process.env, PYTHONPATH: path.resolve('python') },
}));
const source = 'lookup_test.Item';
const modelCount = Number(process.argv[2] || 1000);
const surface = {};
const catalog = { ...fixture.lookupCatalog, fields: {}, expressionFields: {}, relationPaths: {} };
const reachable = new Set();
const pending = [...Object.values(fixture.lookupCatalog.fields[source]), ...Object.values(fixture.lookupCatalog.expressionFields?.[source] || {})];
while (pending.length) {
  const id = pending.pop();
  if (id == null || reachable.has(id)) continue;
  reachable.add(id);
  const type = fixture.lookupCatalog.types[id];
  pending.push(...Object.values(type.transforms), type.dynamicTransform?.outputType, type.dynamicTransform?.sliceType);
}
const chunkTypes = Object.fromEntries([...reachable].map(id => [id, fixture.lookupCatalog.types[id]]));
for (let number = 0; number < modelCount; number++) {
  const label = `bench.Item${number}`;
  surface[label] = fixture.surfaceIndex[source];
  catalog.fields[label] = fixture.lookupCatalog.fields[source];
  catalog.expressionFields[label] = fixture.lookupCatalog.expressionFields?.[source] || {};
}
global.gc?.();
const before = process.memoryUsage().heapUsed;
const originalLog = console.log;
console.log = () => {};
const index = buildWorkspaceIndex(surface, [], {}, undefined, catalog);
console.log = originalLog;
global.gc?.();
const initializedHeap = process.memoryUsage().heapUsed;
const samples = [];
for (let number = 0; number < modelCount; number++) {
  const label = `bench.Item${number}`;
  const chunk = { types: chunkTypes, fields: { [label]: fixture.lookupCatalog.fields[source] },
    expressionFields: { [label]: fixture.lookupCatalog.expressionFields?.[source] || {} } };
  const started = performance.now();
  applyLookupCatalogDelta(index, { [label]: chunk });
  samples.push(performance.now() - started);
}
global.gc?.();
const editedHeap = process.memoryUsage().heapUsed;
const typesAfterAllModels = Object.keys(index.lookupCatalog.types).length;
const label = 'bench.Item0';
for (let revision = 0; revision < 100; revision++) applyLookupCatalogDelta(index, {
  [label]: { types: chunkTypes, fields: { [label]: fixture.lookupCatalog.fields[source] },
    expressionFields: { [label]: fixture.lookupCatalog.expressionFields?.[source] || {} } },
});
if (Object.keys(index.lookupCatalog.types).length !== typesAfterAllModels) throw new Error('Descriptor retention grew with edit history');
samples.sort((a, b) => a - b);
console.log(JSON.stringify({ modelCount, fieldsPerModel: Object.keys(fixture.lookupCatalog.fields[source]).length,
  descriptorsPerEditedModel: reachable.size, typesAfterAllModels,
  initializeHeapMB: (initializedHeap - before) / 1024 ** 2,
  allModelsEditedHeapMB: (editedHeap - before) / 1024 ** 2,
  deltaP50Ms: samples[Math.floor(samples.length / 2)], deltaP95Ms: samples[Math.floor(samples.length * .95)],
  historyRetentionStableAfter100MoreEdits: true,
  scope: 'Catalog/lookup metadata only; input fixture has fewer fields than the file-tier performance profile',
}, null, 2));
