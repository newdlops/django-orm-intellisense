// Regression: lookup completion collapsed to `id` / `pk` only.
//
// A surface entry can be registered for a concrete model while its `instance`
// receiver carries no field members (inheritance-only models, or a surface
// slice rebuilt against a static-only graph during runtime warm-up). The
// indexer synthesizes `id` / `pk` for every model, so such an entry used to
// shadow the model's static fallback and the lookup popup showed only the two
// synthetic names.
//
// Invoke: npm run compile && node out/server/workspaceIndexer.test.js

import {
  buildModelLabelByName,
  buildWorkspaceIndex,
  updateWorkspaceIndexIncremental,
  applyStaticFallbackDelta,
  includeStaticFallbackChanges,
  type StaticFallback,
  type SurfaceIndex,
} from './workspaceIndexer';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const FIELDLESS_SURFACE: SurfaceIndex = {
  'blog.Post': {
    model_class: { objects: ['manager', 'blog.Post', 'manager', null] },
    instance: { save: ['scalar', null, 'method', null] },
  },
};

const SYNTHETIC_ONLY_SURFACE: SurfaceIndex = {
  'blog.Post': {
    instance: {
      id: ['scalar', null, 'field', 'BigAutoField'],
      pk: ['scalar', null, 'field', 'BigAutoField'],
    },
  },
};

const POST_FALLBACK: StaticFallback = {
  'blog.Post': {
    fields: ['title', 'id', 'pk'],
    relations: ['author'],
    reverseRelations: ['comments'],
    fieldDetails: {
      title: { fieldKind: 'CharField', isRelation: false },
      author: {
        fieldKind: 'ForeignKey',
        isRelation: true,
        relationDirection: 'forward',
        relatedModelLabel: 'auth.User',
      },
      comments: {
        fieldKind: 'reverse_ForeignKey',
        isRelation: true,
        relationDirection: 'reverse',
        relatedModelLabel: 'blog.Comment',
      },
    },
  },
};

function fieldNames(index: ReturnType<typeof buildWorkspaceIndex>, label: string): string[] {
  const model = index.models.get(label);
  assert(model, `${label} missing from index`);
  return [...model.fields.keys()].sort();
}

function testFieldlessSurfaceEntryUsesStaticFallback(): void {
  const index = buildWorkspaceIndex(FIELDLESS_SURFACE, [], {}, POST_FALLBACK);
  const names = fieldNames(index, 'blog.Post');
  assert(names.includes('title'), `expected fallback field title, got ${names}`);
  assert(names.includes('author'), `expected fallback relation author, got ${names}`);
  assert(names.includes('author_id'), `expected author_id attname, got ${names}`);
  const model = index.models.get('blog.Post')!;
  assert(model.relations.get('author')?.targetModelLabel === 'auth.User', 'forward relation target');
  assert(model.reverseRelations.has('comments'), 'reverse relation from fallback');
}

function testSyntheticOnlySurfaceEntryUsesStaticFallback(): void {
  const index = buildWorkspaceIndex(SYNTHETIC_ONLY_SURFACE, [], {}, POST_FALLBACK);
  const names = fieldNames(index, 'blog.Post');
  assert(names.includes('title'), `expected fallback field title, got ${names}`);
}

function testSurfaceWithRealFieldsStillWins(): void {
  const surface: SurfaceIndex = {
    'blog.Post': {
      instance: {
        headline: ['scalar', null, 'field', 'CharField'],
      },
    },
  };
  const index = buildWorkspaceIndex(surface, [], {}, POST_FALLBACK);
  const names = fieldNames(index, 'blog.Post');
  assert(names.includes('headline'), `surface field missing, got ${names}`);
  assert(!names.includes('title'), `fallback must not override a populated surface, got ${names}`);
}

function testIncrementalFieldlessEntryUsesStaticFallback(): void {
  const surface: SurfaceIndex = {
    'blog.Post': {
      instance: {
        title: ['scalar', null, 'field', 'CharField'],
      },
    },
  };
  const index = buildWorkspaceIndex(surface, [], {}, POST_FALLBACK);
  updateWorkspaceIndexIncremental(
    index,
    FIELDLESS_SURFACE,
    { added: [], changed: ['blog.Post'], removed: [] },
    {},
    {},
    POST_FALLBACK,
  );
  const names = fieldNames(index, 'blog.Post');
  assert(names.includes('title'), `incremental update lost fallback fields, got ${names}`);
  assert(names.includes('author'), `incremental update lost fallback relation, got ${names}`);
}

// Third-party models known only from runtime inspection must be reachable by
// exact label (so `Token.objects.filter(` completes real fields instead of the
// generic `pk` / `id`), but must not own short names: those drive receiver
// inference, and `result.get(...)` must not become an ORM receiver.
const RUNTIME_ONLY_FALLBACK: StaticFallback = {
  'blog.Tag': { fields: ['name'] },
  'taggit.Tag': { fields: ['slug'], runtimeOnly: true },
  'celery.Result': { fields: ['status'], runtimeOnly: true },
};

function testRuntimeOnlyModelsAreIndexedByLabelOnly(): void {
  const index = buildWorkspaceIndex({}, [], {}, RUNTIME_ONLY_FALLBACK);
  const result = index.models.get('celery.Result');
  assert(result, 'runtime-only model must be in the index by label');
  assert(result.fields.has('status'), 'runtime-only model keeps its fields');
  assert(result.runtimeOnly === true, 'runtime-only model is flagged');
  assert(index.models.get('blog.Tag')?.runtimeOnly === false, 'workspace model is not flagged');
  assert(!index.modelLabelByName.has('Result'), 'runtime-only name must not be registered');
  assert(index.modelLabelByName.get('Tag') === 'blog.Tag', 'workspace model owns a shared name');
}

function testWorkspaceModelOwnsNameForBothCollisionModes(): void {
  // Runtime-only entry listed first: iteration order must not decide.
  const fallback: StaticFallback = {
    'aaa.Tag': { fields: ['slug'], runtimeOnly: true },
    'blog.Tag': { fields: ['name'] },
  };
  for (const collision of ['first', 'last'] as const) {
    const byName = buildModelLabelByName([], fallback, collision);
    assert(byName.get('Tag') === 'blog.Tag', `${collision}: workspace model must own Tag`);
  }
}

function testBuiltinRuntimeEntryKeepsItsName(): void {
  // The daemon's runtime entry for auth.User replaces the client's built-in
  // entry under the same key; it must still resolve `User` when the
  // workspace declares no User of its own.
  const builtinOnly: StaticFallback = {
    'auth.User': { fields: ['username'], runtimeOnly: true, builtin: true },
  };
  assert(
    buildModelLabelByName([], builtinOnly, 'first').get('User') === 'auth.User',
    'built-in contrib model keeps its short name',
  );
  const index = buildWorkspaceIndex({}, [], {}, builtinOnly);
  assert(index.models.get('auth.User')?.runtimeOnly === false, 'built-in entry is not runtime-only');

  const withCustomUser: StaticFallback = {
    ...builtinOnly,
    'accounts.User': { fields: ['email'] },
  };
  for (const collision of ['first', 'last'] as const) {
    assert(
      buildModelLabelByName([], withCustomUser, collision).get('User') === 'accounts.User',
      `${collision}: workspace User must win over the built-in`,
    );
    assert(
      buildModelLabelByName(['accounts.User'], builtinOnly, collision).get('User') === 'accounts.User',
      `${collision}: surface User must win over the built-in`,
    );
  }
}

function testFallbackDeltaMatchesFullBuild(): void {
  let surface: SurfaceIndex = {};
  const fallback: StaticFallback = structuredClone(POST_FALLBACK);
  const index = buildWorkspaceIndex(surface, [], {}, fallback);
  const stable = index.models.get('blog.Post');
  const apply = (delta: StaticFallback, removed: string[], nextSurface: SurfaceIndex, surfaceRemoved: string[] = []): void => {
    applyStaticFallbackDelta(fallback, delta, removed);
    surface = nextSurface;
    const diff = includeStaticFallbackChanges(index, surface, fallback,
      { added: Object.keys(nextSurface), changed: [], removed: surfaceRemoved }, delta, removed);
    updateWorkspaceIndexIncremental(index, surface, diff, {}, {}, fallback);
    const full = buildWorkspaceIndex(surface, [], {}, fallback);
    assert(JSON.stringify([...index.models.keys()].sort()) === JSON.stringify([...full.models.keys()].sort()), 'delta model labels match full build');
    for (const [label, expected] of full.models) {
      const actual = index.models.get(label)!;
      assert(JSON.stringify([...actual.fields]) === JSON.stringify([...expected.fields]), `${label}: fields match`);
      assert(JSON.stringify([...actual.relations]) === JSON.stringify([...expected.relations]), `${label}: relations match`);
      assert(JSON.stringify([...actual.reverseRelations]) === JSON.stringify([...expected.reverseRelations]), `${label}: reverse relations match`);
    }
    const names = (value: Map<string, string>): string => JSON.stringify([...value].sort(([a], [b]) => a.localeCompare(b)));
    assert(names(index.modelLabelByName) === names(full.modelLabelByName), 'short names match');
  };
  apply({ 'celery.Result': { fields: ['status'], runtimeOnly: true } }, [], {});
  assert(index.models.get('blog.Post') === stable, 'unrelated fallback is not rebuilt');
  apply({ 'blog.Post': { fields: ['score'], fieldDetails: { score: { fieldKind: 'IntegerField' } } } }, [], {});
  apply({}, ['blog.Post'], { 'blog.Post': { instance: { headline: ['scalar', null, 'field', 'TextField'] } } });
  apply({ 'blog.Post': POST_FALLBACK['blog.Post'] }, [], {}, ['blog.Post']);
  apply({}, ['blog.Post', 'celery.Result'], {});
}

function testSurfaceCoverageUpdatesNameCollisionPriority(): void {
  const fallback: StaticFallback = {
    'aaa.Tag': { fields: ['first'] }, 'blog.Tag': { fields: ['second'] },
  };
  const surface: SurfaceIndex = {};
  const index = buildWorkspaceIndex(surface, [], {}, fallback);
  assert(index.modelLabelByName.get('Tag') === 'blog.Tag', 'initial last-collision priority');
  surface['blog.Tag'] = { instance: { second: ['scalar', null, 'field', 'CharField'] } };
  applyStaticFallbackDelta(fallback, {}, ['blog.Tag']);
  let diff = includeStaticFallbackChanges(index, surface, fallback,
    { added: ['blog.Tag'], changed: [], removed: [] }, {}, ['blog.Tag']);
  updateWorkspaceIndexIncremental(index, surface, diff, {}, {}, fallback);
  assert(index.modelLabelByName.get('Tag') === buildWorkspaceIndex(surface, [], {}, fallback).modelLabelByName.get('Tag'),
    'surface promotion matches full-build collision priority');
  surface['aaa.Tag'] = { instance: { first: ['scalar', null, 'field', 'CharField'] } };
  applyStaticFallbackDelta(fallback, {}, ['aaa.Tag']);
  diff = includeStaticFallbackChanges(index, surface, fallback,
    { added: ['aaa.Tag'], changed: [], removed: [] }, {}, ['aaa.Tag']);
  updateWorkspaceIndexIncremental(index, surface, diff, {}, {}, fallback);
  delete surface['blog.Tag'];
  applyStaticFallbackDelta(fallback, { 'blog.Tag': { fields: ['second'] } });
  diff = includeStaticFallbackChanges(index, surface, fallback,
    { added: [], changed: [], removed: ['blog.Tag'] });
  updateWorkspaceIndexIncremental(index, surface, diff, {}, {}, fallback);
  assert(index.modelLabelByName.get('Tag') === buildWorkspaceIndex(surface, [], {}, fallback).modelLabelByName.get('Tag'),
    'restored fallback matches full-build collision priority');
}

function testIncrementalRelationTargetNormalization(): void {
  const fallback: StaticFallback = { ...structuredClone(POST_FALLBACK), 'auth.User': { fields: ['username'], builtin: true } };
  const index = buildWorkspaceIndex({}, [], {}, fallback);
  const delta: StaticFallback = { 'blog.Post': { ...fallback['blog.Post'],
    fieldDetails: { ...fallback['blog.Post'].fieldDetails,
      author: { fieldKind: 'ForeignKey', isRelation: true, relatedModelLabel: 'User' } } } };
  applyStaticFallbackDelta(fallback, delta);
  const diff = includeStaticFallbackChanges(index, {}, fallback,
    { added: [], changed: [], removed: [] }, delta);
  updateWorkspaceIndexIncremental(index, {}, diff, {}, {}, fallback);
  assert(index.models.get('blog.Post')?.relations.get('author')?.targetModelLabel === 'auth.User',
    'changed fallback relation target is normalized against complete model index');
}

function testPrimaryKeyAuthorityAcrossSurfaceFallbackAndUpdates(): void {
  const label = 'blog.Post';
  const cases = [
    { fields: { title: 'CharField' }, kind: 'BigAutoField', hasId: true },
    { fields: { key: 'UUIDField', pk: 'UUIDField' }, kind: 'UUIDField', hasId: false },
    { fields: { id: 'SlugField' }, kind: 'SlugField', hasId: true },
    { fields: { id: 'UUIDField', pk: 'UUIDField' }, kind: 'UUIDField', hasId: true },
  ];
  for (const mode of ['surface', 'fallback']) {
    let index: ReturnType<typeof buildWorkspaceIndex> | undefined;
    for (const [position, item] of [...cases, cases[1]].entries()) {
      const entries = Object.entries(item.fields);
      const surface: SurfaceIndex = mode === 'surface' ? { [label]: { instance:
        Object.fromEntries(entries.map(([name, kind]) => [name, ['scalar', null, 'field', kind]])) } } : {};
      const fallback: StaticFallback = mode === 'fallback' ? { [label]: { fields: entries.map(([name]) => name),
        fieldDetails: Object.fromEntries(entries.map(([name, fieldKind]) => [name, { fieldKind, isRelation: false }])) } } : {};
      const full = buildWorkspaceIndex(surface, [], {}, fallback);
      if (!index) index = full;
      else updateWorkspaceIndexIncremental(index, surface, { added: [], removed: [], changed: [label] }, {}, {}, fallback);
      for (const [name, current] of [['full', full], ['incremental', index]] as const) {
        const model = current.models.get(label)!;
        assert(model.fields.get('pk')?.fieldKind === item.kind, `${mode}/${position}/${name}: pk keeps declared type`);
        assert(model.fields.has('id') === item.hasId, `${mode}/${position}/${name}: authoritative absence of id`);
        assert(JSON.stringify([...model.fields]) === JSON.stringify([...full.models.get(label)!.fields]),
          `${mode}/${position}/${name}: full and incremental field metadata agree`);
      }
    }
  }
}

function main(): void {
  testFieldlessSurfaceEntryUsesStaticFallback();
  testSyntheticOnlySurfaceEntryUsesStaticFallback();
  testSurfaceWithRealFieldsStillWins();
  testIncrementalFieldlessEntryUsesStaticFallback();
  testRuntimeOnlyModelsAreIndexedByLabelOnly();
  testWorkspaceModelOwnsNameForBothCollisionModes();
  testBuiltinRuntimeEntryKeepsItsName();
  testFallbackDeltaMatchesFullBuild();
  testSurfaceCoverageUpdatesNameCollisionPriority();
  testIncrementalRelationTargetNormalization();
  testPrimaryKeyAuthorityAcrossSurfaceFallbackAndUpdates();
  console.log('workspaceIndexer.test: all passed');
}

main();
