import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isWatchedSourcePath, normalizeSourcePath, retainPendingSourceEvents, shouldScanSourceDirectory, sourceWatcherRoots } from './sourceWatcher';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'djls-source-watcher-'));
try {
  const workspace = path.join(temporary, 'workspace');
  const external = path.join(temporary, 'editable');
  const nestedEditable = path.join(workspace, '.venv', 'src', 'shared');
  for (const root of [workspace, external, nestedEditable]) fs.mkdirSync(root, { recursive: true });
  const alias = path.join(temporary, 'alias');
  fs.symlinkSync(external, alias, 'dir');
  const roots = sourceWatcherRoots(workspace, [external, alias, external, nestedEditable]);
  assert.equal(roots.length, 3);
  const ignored = new Set(['.venv', '.git', '__pycache__']);
  const file = path.join(external, 'models.py');
  fs.writeFileSync(file, 'value = 1\n');
  const normalized = normalizeSourcePath(path.join(alias, 'models.py'));
  assert.equal(normalized, normalizeSourcePath(file));
  assert.equal(isWatchedSourcePath(roots, normalized, ignored), true);
  fs.unlinkSync(file);
  assert.equal(normalizeSourcePath(path.join(alias, 'models.py')), normalized);
  assert.equal(isWatchedSourcePath(roots, normalizeSourcePath(path.join(nestedEditable, 'models.py')), ignored), true);
  assert.equal(isWatchedSourcePath(roots, normalizeSourcePath(path.join(workspace, '.venv', 'ignored.py')), ignored), false);
  assert.equal(isWatchedSourcePath(roots, normalizeSourcePath(path.join(external, '__pycache__', 'ignored.py')), ignored), false);
  assert.equal(isWatchedSourcePath(roots, path.join(temporary, 'editable-sibling', 'models.py'), ignored), false);
  assert.equal(isWatchedSourcePath(roots, normalizeSourcePath(external), ignored), false);
  assert.equal(isWatchedSourcePath(roots, normalizeSourcePath(path.join(external, '..valid', 'models.py')), ignored), true);
  if (path.sep === '/') {
    const parityCases = [
      [external, path.join(external, 'models.py')],
      [external, path.join(external, '.venv', 'models.py')],
      [external, `${external}-sibling/models.py`],
      [external, path.join(external, '..', 'outside', 'models.py')],
      [external, path.join(external, 'nested', '..', 'models.py')],
    ];
    for (const [root, candidate] of parityCases) {
      const relative = path.relative(root, candidate);
      const expected: boolean = relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative) && !relative.split(path.sep).some(segment => ignored.has(segment));
      assert.equal(isWatchedSourcePath([root], candidate, ignored), expected, `${root} :: ${candidate}`);
    }
  }
  // A cache directory is rejected, but an ignored parent can contain an
  // independently watched editable root that must still be discovered.
  assert.equal(shouldScanSourceDirectory(roots, normalizeSourcePath(external), ignored), true);
  assert.equal(shouldScanSourceDirectory(roots, normalizeSourcePath(alias), ignored), true);
  assert.equal(shouldScanSourceDirectory(roots, normalizeSourcePath(path.join(external, 'nested')), ignored), true);
  assert.equal(shouldScanSourceDirectory(roots, normalizeSourcePath(path.join(external, '__pycache__')), ignored), false);
  assert.equal(shouldScanSourceDirectory(roots, normalizeSourcePath(path.join(workspace, '.venv')), ignored), true);
  assert.equal(shouldScanSourceDirectory(roots, normalizeSourcePath(path.join(workspace, '.venv', 'src')), ignored), true);
  assert.equal(shouldScanSourceDirectory(roots, normalizeSourcePath(nestedEditable), ignored), true);
  assert.equal(shouldScanSourceDirectory(roots, normalizeSourcePath(path.join(nestedEditable, '__pycache__')), ignored), false);
  assert.equal(shouldScanSourceDirectory(roots, normalizeSourcePath(path.join(workspace, '.venv', 'other')), ignored), false);
  assert.equal(shouldScanSourceDirectory(roots, normalizeSourcePath(path.join(temporary, 'editable-sibling')), ignored), false);
  const normalizedWorkspace = normalizeSourcePath(workspace);
  const normalizedExternal = normalizeSourcePath(external);
  const workspaceFile = path.join(normalizedWorkspace, 'models.py');
  const editableFile = path.join(normalizedExternal, 'models.py');
  const ignoredFile = path.join(normalizedWorkspace, '.git', 'ignored.py');
  const pendingFiles = new Set([workspaceFile, editableFile, ignoredFile]);
  const pendingDeletes = new Set([workspaceFile, editableFile, normalizedExternal]);
  retainPendingSourceEvents(normalizedWorkspace, normalizedWorkspace, roots, pendingFiles, pendingDeletes, ignored);
  assert.deepEqual([...pendingFiles], [workspaceFile, editableFile]);
  assert.deepEqual([...pendingDeletes], [workspaceFile, editableFile, normalizedExternal]);
  retainPendingSourceEvents(normalizedWorkspace, normalizedWorkspace, [normalizedWorkspace], pendingFiles, pendingDeletes, ignored);
  assert.deepEqual([...pendingFiles], [workspaceFile]);
  assert.deepEqual([...pendingDeletes], [workspaceFile]);
  // The same root union can belong to a different active workspace.
  retainPendingSourceEvents(normalizedWorkspace, normalizedExternal, roots, pendingFiles, pendingDeletes, ignored);
  assert.equal(pendingFiles.size, 0);
  assert.equal(pendingDeletes.size, 0);
  pendingFiles.add(workspaceFile);
  pendingDeletes.add(normalizedWorkspace);
  retainPendingSourceEvents(normalizedWorkspace, undefined, [], pendingFiles, pendingDeletes, ignored);
  assert.equal(pendingFiles.size, 0);
  assert.equal(pendingDeletes.size, 0);
  console.log('sourceWatcher.test: source roots, aliases, deletions and ignored paths passed');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
