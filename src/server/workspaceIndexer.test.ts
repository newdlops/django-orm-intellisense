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

function main(): void {
  testFieldlessSurfaceEntryUsesStaticFallback();
  testSyntheticOnlySurfaceEntryUsesStaticFallback();
  testSurfaceWithRealFieldsStillWins();
  testIncrementalFieldlessEntryUsesStaticFallback();
  testRuntimeOnlyModelsAreIndexedByLabelOnly();
  testWorkspaceModelOwnsNameForBothCollisionModes();
  testBuiltinRuntimeEntryKeepsItsName();
  console.log('workspaceIndexer.test: all passed');
}

main();
