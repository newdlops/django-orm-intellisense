import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as watcher from './sourceWatcher';

// Before the new event helper exists, exercise the normalizer actually used
// by the old event queue. The assertions and fixture bytes stay identical.
const normalizeEvent: (value: string, roots: readonly string[]) => string = (watcher as unknown as {
  normalizeSourceEventPath?: (value: string, roots: readonly string[]) => string;
}).normalizeSourceEventPath ?? watcher.normalizeSourcePath;
const ignored = new Set(['.git', '__pycache__']);
const posixOnly = { skip: path.sep !== '/' };

async function fixture(check: (workspace: string, target: string, base: string) => void | Promise<void>): Promise<void> {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'djls-watcher-file-links-'));
  const base = fs.realpathSync.native(temporary);
  try {
    const workspace = path.join(base, 'workspace');
    fs.mkdirSync(workspace);
    const target = path.join(base, 'external-model.txt');
    fs.writeFileSync(target, 'value=1\n');
    fs.symlinkSync(target, path.join(workspace, 'models.py'), 'file');
    fs.writeFileSync(path.join(workspace, 'ordinary.py'), 'value=2\n');
    await check(workspace, target, base);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

test('a file event keeps its declared filename when the target is outside its root', posixOnly, async () => {
  await fixture((workspace) => {
    const source = path.join(workspace, 'models.py');
    assert.equal(normalizeEvent(source, [workspace]), source);
    assert.equal(watcher.isWatchedSourcePath([workspace], normalizeEvent(source, [workspace]), ignored), true);
    assert.equal(fs.readFileSync(normalizeEvent(source, [workspace]), 'utf8'), 'value=1\n');
  });
});

test('parent directory aliases canonicalize while a final file link keeps its name', posixOnly, async () => {
  await fixture((workspace, _target, base) => {
    const alias = path.join(base, 'workspace-alias');
    fs.symlinkSync(workspace, alias, 'dir');
    assert.equal(normalizeEvent(path.join(alias, 'models.py'), [workspace]), path.join(workspace, 'models.py'));
    assert.equal(normalizeEvent(path.join(alias, 'ordinary.py'), [workspace]), path.join(workspace, 'ordinary.py'));
  });
});

test('direct external targets and sibling files do not become owned source events', posixOnly, async () => {
  await fixture((workspace, target) => {
    assert.equal(watcher.isWatchedSourcePath([workspace], normalizeEvent(target, [workspace]), ignored), false);
    assert.equal(watcher.isWatchedSourcePath([workspace], normalizeEvent(`${workspace}-sibling/models.py`, [workspace]), ignored), false);
  });
});

test('an external file alias still addresses its owned regular source', posixOnly, async () => {
  await fixture((workspace, _target, base) => {
    const alias = path.join(base, 'outside-alias.py');
    const owned = path.join(workspace, 'ordinary.py');
    fs.symlinkSync(owned, alias, 'file');
    assert.equal(normalizeEvent(alias, [workspace]), owned);
    assert.equal(watcher.isWatchedSourcePath([workspace], normalizeEvent(alias, [workspace]), ignored), true);
  });
});

test('a directory link retains existing canonical root and event behavior', posixOnly, async () => {
  await fixture((workspace, _target, base) => {
    const alias = path.join(base, 'directory-alias');
    fs.symlinkSync(workspace, alias, 'dir');
    assert.equal(normalizeEvent(alias, [workspace]), workspace);
    assert.deepEqual(watcher.sourceWatcherRoots(alias, []), [workspace]);
  });
});

test('retargeting a file link changes its contents without changing its module namespace', posixOnly, async () => {
  await fixture((workspace, _target, base) => {
    const source = path.join(workspace, 'models.py');
    const previous = normalizeEvent(source, [workspace]);
    const replacement = path.join(base, 'replacement.txt');
    fs.writeFileSync(replacement, 'value=3\n');
    fs.unlinkSync(source);
    fs.symlinkSync(replacement, source, 'file');
    assert.equal(normalizeEvent(source, [workspace]), previous);
    assert.equal(normalizeEvent(source, [workspace]), source);
    assert.equal(fs.readFileSync(normalizeEvent(source, [workspace]), 'utf8'), 'value=3\n');
  });
});

test('two source link names remain distinct even when their target is the same file', posixOnly, async () => {
  await fixture((workspace, target) => {
    const other = path.join(workspace, 'other.py');
    fs.symlinkSync(target, other, 'file');
    const pending = new Set([normalizeEvent(path.join(workspace, 'models.py'), [workspace]), normalizeEvent(other, [workspace])]);
    assert.equal(pending.size, 2);
    assert.deepEqual([...pending].sort(), [path.join(workspace, 'models.py'), other].sort());
  });
});

test('directory rescan includes Python file links with non-Python targets and Unicode names', posixOnly, async () => {
  await fixture(async (workspace, target) => {
    const unicode = path.join(workspace, '한글-é.py');
    fs.symlinkSync(target, unicode, 'file');
    const files = await watcher.pythonFilesBelowDirectory(workspace, ignored);
    assert.deepEqual(files.sort(), [path.join(workspace, 'models.py'), path.join(workspace, 'ordinary.py'), unicode].sort());
    assert.equal(files.every(file => watcher.isWatchedSourcePath([workspace], normalizeEvent(file, [workspace]), ignored)), true);
  });
});

test('rescan includes dangling file links for revocation and does not traverse directory links', posixOnly, async () => {
  await fixture(async (workspace, target) => {
    fs.unlinkSync(target);
    fs.symlinkSync(workspace, path.join(workspace, 'loop.py'), 'dir');
    const files = await watcher.pythonFilesBelowDirectory(workspace, ignored);
    assert.deepEqual(files.sort(), [path.join(workspace, 'models.py'), path.join(workspace, 'ordinary.py')].sort());
    assert.equal(normalizeEvent(path.join(workspace, 'models.py'), [workspace]), path.join(workspace, 'models.py'));
  });
});

test('directory rescan follows filesystem link/.. order before collecting children', posixOnly, async () => {
  await fixture(async (workspace, _target, base) => {
    const inner = path.join(workspace, 'inner');
    fs.mkdirSync(inner);
    const outside = path.join(base, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'wrong.py'), 'value=0\n');
    fs.symlinkSync(inner, path.join(outside, 'enter'), 'dir');
    const files = await watcher.pythonFilesBelowDirectory(`${outside}/enter/..`, ignored);
    assert.deepEqual(files.sort(), [path.join(workspace, 'models.py'), path.join(workspace, 'ordinary.py')].sort());
  });
});

test('event normalization keeps the filesystem parent before preserving a linked leaf', posixOnly, async () => {
  await fixture((workspace, _target, base) => {
    fs.mkdirSync(path.join(workspace, 'inner'));
    const enter = path.join(base, 'enter');
    fs.symlinkSync(path.join(workspace, 'inner'), enter, 'dir');
    const candidate = `${path.relative(process.cwd(), base)}/enter/../models.py`;
    assert.equal(normalizeEvent(candidate, [workspace]), path.join(workspace, 'models.py'));
  });
});

test('file-link pending work is retained and then discarded when its root is revoked', posixOnly, async () => {
  await fixture((workspace, _target, base) => {
    const source = normalizeEvent(path.join(workspace, 'models.py'), [workspace]);
    const files = new Set([source]);
    const deleted = new Set([source]);
    watcher.retainPendingSourceEvents(workspace, workspace, [workspace], files, deleted, ignored);
    assert.deepEqual([...files], [path.join(workspace, 'models.py')]);
    assert.deepEqual([...deleted], [...files]);
    watcher.retainPendingSourceEvents(workspace, workspace, [base + '/another-owned-root'], files, deleted, ignored);
    assert.equal(files.size, 0);
    assert.equal(deleted.size, 0);
  });
});

test('removed links, missing targets and leaf loops do not expose an external deletion path', posixOnly, async () => {
  await fixture(async (workspace, target) => {
    const source = path.join(workspace, 'models.py');
    fs.unlinkSync(source);
    assert.equal(normalizeEvent(source, [workspace]), source);
    assert.equal(fs.existsSync(target), true);
    fs.symlinkSync('models.py', source, 'file');
    assert.equal(normalizeEvent(source, [workspace]), source);
    assert.deepEqual((await watcher.pythonFilesBelowDirectory(workspace, ignored)).sort(),
      [source, path.join(workspace, 'ordinary.py')].sort());
  });
});
