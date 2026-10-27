import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { buildWorkspaceIndex } from './workspaceIndexer';
import { parseLookupChain, getCompletionCandidates } from './lookupResolver';

const root = path.resolve(__dirname, '../..');
const python = process.env.DJLS_LOOKUP_TEST_PYTHON ?? path.join(root, '.e2e-django5/bin/python');
const fixture = JSON.parse(execFileSync(python, ['python/tests/relation_lookup_fixture.py'], {
  cwd: root, env: { ...process.env, PYTHONPATH: path.join(root, 'python') }, encoding: 'utf8',
}));
const index = buildWorkspaceIndex(fixture.surfaceIndex, [], {}, undefined, fixture.lookupCatalog);
assert(index.models.get('blog.Post')?.relations.has('tags'), 'Forward M2M must stay forward');
for (const test of fixture.oracleCases) {
  const parsed = parseLookupChain(test.path, test.model, index, test.method);
  assert.equal(parsed.state !== 'error' && parsed.resolvedPath.length === parsed.segments.length,
    test.resolved, `${test.model}.${test.path} in ${test.method}`);
}
function names(model: string, method: string) {
  return getCompletionCandidates(parseLookupChain('', model, index, method), '', index, method).map(item => item.name);
}
assert(names('blog.Post', 'select_related').includes('author'));
assert(!names('blog.Post', 'select_related').includes('tags'));
assert(names('blog.Post', 'prefetch_related').includes('tags'));
assert(!names('blog.Post', 'prefetch_related').includes('title'));
assert(names('blog.QuestionThread', 'select_related').includes('tmeta'));
assert(!names('blog.QuestionThread', 'select_related').includes('_tmeta'));
assert(names('blog.QuestionThread', 'prefetch_related').includes('_tmeta'));
assert(!names('blog.QuestionThread', 'prefetch_related').includes('tmeta'));
console.log(`relationLookup.test: Django ${fixture.djangoVersion}, ${fixture.oracleCases.length} evaluated/compiled relation cases passed`);
