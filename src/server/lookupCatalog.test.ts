import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { buildWorkspaceIndex, updateWorkspaceIndexIncremental, type SurfaceIndex } from './workspaceIndexer';
import { getCompletionCandidates, parseLookupChain } from './lookupResolver';
import { applyLookupCatalogDelta, type LookupCatalogPayload } from './lookupCatalog';
import { virtualLookupIndex } from './virtualLookup';

const root = path.resolve(__dirname, '../..');
const python = process.env.DJLS_LOOKUP_TEST_PYTHON ?? path.join(root, '.e2e-django5/bin/python');
const fixture = JSON.parse(process.env.DJLS_LOOKUP_TEST_FIXTURE_JSON ?? execFileSync(python, ['python/tests/lookup_catalog_fixture.py'], {
  cwd: root, env: { ...process.env, PYTHONPATH: path.join(root, 'python') }, encoding: 'utf8',
})) as {
  surfaceIndex: SurfaceIndex;
  lookupCatalog: LookupCatalogPayload;
  djangoVersion: string;
  oracleCases: Array<{ model: string; path: string; method: string; resolved: boolean }>;
};
const index = buildWorkspaceIndex(fixture.surfaceIndex, [], {}, undefined, fixture.lookupCatalog);

for (const test of fixture.oracleCases) {
  const parsed = parseLookupChain(test.path, test.model, index, test.method);
  const resolved = parsed.state !== 'error' && parsed.resolvedPath.length === parsed.segments.length;
  assert.equal(resolved, test.resolved, `${test.model}.${test.path} in ${test.method}: ${JSON.stringify(parsed)}`);
}

function candidates(prefix: string, model = 'lookup_test.Item', method = 'filter'): string[] {
  return getCompletionCandidates(parseLookupChain(prefix, model, index, method), '', index, method)
    .map((item) => item.name);
}
assert(candidates('title__').includes('only_here'));
assert(!candidates('other__').includes('only_here'));
assert(candidates('title__length__').includes('gte'));
assert(!candidates('title__length__').includes('year'));
assert(candidates('published__date__').includes('iso_year'));
assert(candidates('payload__nested__-1__').includes('icontains'));
assert(candidates('generated__date__').includes('iso_year'));
assert(!candidates('published__', 'lookup_test.Item', 'values').includes('gte'));
assert.equal(index.models.get('lookup_test.Item')?.fields.get('title')?.fieldKind, 'CharField');
assert.equal(parseLookupChain('title__length', 'lookup_test.Item', index).finalField?.fieldKind, 'IntegerField');
assert.equal(parseLookupChain('short__size_aware', 'lookup_test.Item', index).finalField?.fieldKind, 'IntegerField');
assert.equal(parseLookupChain('title__size_aware', 'lookup_test.Item', index).finalField?.fieldKind, 'CharField');

const unchangedOwner = index.models.get('lookup_test.Owner');
const originalCatalog = index.lookupCatalog!;
const titleId = originalCatalog.fields['lookup_test.Item'].title;
const originalTransformId = originalCatalog.types[titleId].transforms.size_aware;
const integerId = originalCatalog.kinds!.IntegerField;
const chunk: LookupCatalogPayload = {
  ...originalCatalog,
  fields: { 'lookup_test.Item': { ...originalCatalog.fields['lookup_test.Item'] } },
  types: { ...originalCatalog.types,
    [titleId]: { ...originalCatalog.types[titleId], transforms: {
      ...originalCatalog.types[titleId].transforms, size_aware: integerId,
    } },
  },
};
applyLookupCatalogDelta(index, { 'lookup_test.Item': chunk });
assert.equal(parseLookupChain('title__size_aware__gte', 'lookup_test.Item', index).finalField?.fieldKind, 'IntegerField');
assert(candidates('title__').includes('only_here'));
assert(!candidates('other__').includes('only_here'));
assert.strictEqual(index.models.get('lookup_test.Owner'), unchangedOwner);
assert.strictEqual(originalCatalog.types[titleId].transforms.size_aware, originalTransformId);
const boundedTypeCount = Object.keys(index.lookupCatalog!.types).length;
const editedSnapshot = index.lookupCatalog!;
const editedTitleId = editedSnapshot.fields['lookup_test.Item'].title;
const editedOutputId = editedSnapshot.types[editedTitleId].transforms.size_aware!;
for (let revision = 0; revision < 100; revision++) applyLookupCatalogDelta(index, { 'lookup_test.Item': chunk });
assert.equal(Object.keys(index.lookupCatalog!.types).length, boundedTypeCount);
applyLookupCatalogDelta(index, { 'lookup_test.Item': {
  ...fixture.lookupCatalog, fields: { 'lookup_test.Item': fixture.lookupCatalog.fields['lookup_test.Item'] },
} });
assert.equal(editedSnapshot.types[editedOutputId].fieldKind, 'IntegerField');
const serializedSnapshot = JSON.parse(JSON.stringify(editedSnapshot)) as LookupCatalogPayload;
assert.equal(serializedSnapshot.types[editedOutputId].fieldKind, 'IntegerField');
assert.equal(Object.keys(serializedSnapshot.types).length, boundedTypeCount);
assert.equal(index.models.get('lookup_test.Owner')?.fields.get('pk')?.fieldKind, 'CharField');
assert(!index.models.get('lookup_test.Owner')?.fields.has('id'));

const virtual = virtualLookupIndex(index, 'lookup_test.Item', 'day', 'DateTimeField');
assert.equal(parseLookupChain('day__year__gte', 'lookup_test.Item', virtual).finalField?.fieldKind, 'IntegerField');
assert.equal(parseLookupChain('day__date__year', 'lookup_test.Item', virtual, 'values').finalField?.fieldKind, 'IntegerField');
const virtualText = virtualLookupIndex(index, 'lookup_test.Item', 'label', 'CharField');
assert(!parseLookupChain('label__', 'lookup_test.Item', virtualText).finalField?.lookups.includes('only_here'));
assert(!parseLookupChain('label__', 'lookup_test.Item', virtualText).finalField?.transforms.includes('length'));
const virtualSum = virtualLookupIndex(index, 'lookup_test.Item', 'total', 'annotation',
  { fieldKind: 'annotation', sourcePath: 'count' });
assert.equal(parseLookupChain('total__gte', 'lookup_test.Item', virtualSum).finalField?.fieldKind, 'IntegerField');
const virtualAvg = virtualLookupIndex(index, 'lookup_test.Item', 'average', 'annotation',
  { fieldKind: 'annotation', sourcePath: 'count', average: true });
assert.equal(parseLookupChain('average__gte', 'lookup_test.Item', virtualAvg).finalField?.fieldKind, 'FloatField');
const virtualTextAvg = virtualLookupIndex(index, 'lookup_test.Item', 'average', 'annotation',
  { fieldKind: 'annotation', sourcePath: 'title', average: true });
assert.equal(parseLookupChain('average__icontains', 'lookup_test.Item', virtualTextAvg).finalField?.fieldKind, 'CharField');
assert(parseLookupChain('average__only_here', 'lookup_test.Item', virtualTextAvg).finalLookup === 'only_here');
for (const sourcePath of ['owner', 'owner_id']) {
  const virtualFk = virtualLookupIndex(index, 'lookup_test.Item', 'owner_copy', 'annotation', { fieldKind: 'annotation', sourcePath });
  assert.equal(parseLookupChain('owner_copy__icontains', 'lookup_test.Item', virtualFk).finalLookup, 'icontains');
  assert.equal(parseLookupChain('owner_copy__icontains', 'lookup_test.Item', virtualFk).finalField?.fieldKind, 'CharField');
}
const unknownOutput = virtualLookupIndex(index, 'lookup_test.Item', 'custom', 'ProjectField', { fieldKind: 'ProjectField' });
assert(parseLookupChain('custom__project_transform', 'lookup_test.Item', unknownOutput).runtimeRequired);
if (fixture.lookupCatalog.kinds?.ArrayField) {
  const virtualArray = virtualLookupIndex(index, 'lookup_test.Item', 'dates', 'ArrayField',
    { fieldKind: 'ArrayField', baseField: { fieldKind: 'DateTimeField' } });
  for (const fieldPath of ['dates__0__year__gte', 'dates__0_2__0__date__year__gte']) {
    assert.equal(parseLookupChain(fieldPath, 'lookup_test.Item', virtualArray).finalField?.fieldKind, 'IntegerField');
  }
  assert.equal(parseLookupChain('dates__len__gte', 'lookup_test.Item', virtualArray).finalField?.fieldKind, 'IntegerField');
  const aggregatedArray = virtualLookupIndex(index, 'lookup_test.Item', 'titles', 'ArrayField',
    { fieldKind: 'ArrayField', baseField: { fieldKind: 'annotation', sourcePath: 'title' } });
  assert(parseLookupChain('titles__0__only_here', 'lookup_test.Item', aggregatedArray).finalLookup === 'only_here');
}
const fallbackArray = virtualLookupIndex({ ...index, lookupCatalog: undefined, lookupTypes: undefined },
  'lookup_test.Item', 'dates', 'ArrayField', { fieldKind: 'ArrayField', baseField: { fieldKind: 'DateTimeField' } });
assert.equal(parseLookupChain('dates__len__gte', 'lookup_test.Item', fallbackArray).finalField?.fieldKind, 'IntegerField');
assert.equal(parseLookupChain('dates__0__year__gte', 'lookup_test.Item', fallbackArray).finalField?.fieldKind, 'IntegerField');
const invalidArray = parseLookupChain('dates__unknown', 'lookup_test.Item', fallbackArray);
assert.equal(invalidArray.runtimeRequired, undefined);
assert(invalidArray.resolvedPath.length < invalidArray.segments.length);

// A name can be registered on multiple output field kinds; do not keep only
// the first trie payload, truncate at 200 names, or retain old registrations.
const manyNames = Array.from({ length: 260 }, (_, i) => `custom_${i}`);
const shared = { CharField: manyNames, IntegerField: manyNames };
const staticIndex = buildWorkspaceIndex(fixture.surfaceIndex, [], shared);
assert(candidates('published__year__').includes('gte'));
const parsed = parseLookupChain('published__year__', 'lookup_test.Item', staticIndex);
assert(parsed.finalField?.lookups.includes('custom_259'));
assert.equal(new Set(parsed.finalField?.lookups).size, parsed.finalField?.lookups.length);
updateWorkspaceIndexIncremental(staticIndex, fixture.surfaceIndex,
  { added: [], changed: [], removed: [] }, {}, shared);
assert(!parseLookupChain('published__year__', 'lookup_test.Item', staticIndex).finalField?.lookups.includes('custom_259'));

const nextCatalog = structuredClone(fixture.lookupCatalog);
const titleType = nextCatalog.fields['lookup_test.Item'].title;
nextCatalog.types[titleType].lookups = nextCatalog.types[titleType].lookups.filter((name) => name !== 'only_here');
updateWorkspaceIndexIncremental(index, fixture.surfaceIndex,
  { added: [], changed: [], removed: [] }, {}, {}, undefined, nextCatalog);
assert(!candidates('title__').includes('only_here'));

const typedSurface = structuredClone(fixture.surfaceIndex);
typedSurface['lookup_test.Item'].instance.title = ['scalar', 'lookup_test.Item', 'field', 'DateField'];
updateWorkspaceIndexIncremental(index, typedSurface,
  { added: [], changed: ['lookup_test.Item'], removed: [] }, {}, {}, undefined, nextCatalog);
assert.equal(index.models.get('lookup_test.Item')?.fields.get('title')?.fieldKind, 'DateField',
  'old runtime metadata must not undo a saved field type');
assert(candidates('title__').includes('year'));
assert(!candidates('title__').includes('length'));

console.log(`lookupCatalog.test: Django ${fixture.djangoVersion}, ${fixture.oracleCases.length} query cases and completion/invalidation checks passed`);
