import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  isWatchedSourcePath, normalizeSourcePath, retainPendingSourceEvents,
  shouldScanSourceDirectory, sourceWatcherRoots,
} from './sourceWatcher';

const ignored = new Set(['.git', '__pycache__']);

function fixture(check: (workspace: string, outside: string) => void): void {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'djls-watcher-parent-'));
  try {
    const workspace = path.join(temporary, 'workspace');
    const outside = path.join(temporary, 'outside');
    for (const directory of [workspace, outside]) {
      fs.mkdirSync(path.join(directory, 'inner'), { recursive: true });
      fs.writeFileSync(path.join(directory, 'models.py'), path.basename(directory));
    }
    fs.symlinkSync(path.join(workspace, 'inner'), path.join(outside, 'enter'), 'dir');
    fs.symlinkSync(path.join(outside, 'inner'), path.join(workspace, 'escape'), 'dir');
    check(workspace, outside);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

const posixOnly = { skip: path.sep !== '/' };

test('an existing source reached through link/.. retains its actual workspace owner', posixOnly, () => {
  fixture((workspace, outside) => {
    const source = `${outside}/enter/../models.py`;
    assert.equal(fs.readFileSync(source, 'utf8'), 'workspace');
    const actual = normalizeSourcePath(source);
    assert.equal(actual, fs.realpathSync.native(source));
    assert.equal(isWatchedSourcePath(sourceWatcherRoots(workspace, []), actual, ignored), true);
  });
});

test('link/.. cannot make an outside source appear owned by the workspace', posixOnly, () => {
  fixture((workspace) => {
    const source = `${workspace}/escape/../models.py`;
    assert.equal(fs.readFileSync(source, 'utf8'), 'outside');
    const actual = normalizeSourcePath(source);
    assert.equal(actual, fs.realpathSync.native(source));
    assert.equal(isWatchedSourcePath(sourceWatcherRoots(workspace, []), actual, ignored), false);
  });
});

test('a declared workspace root follows link/.. before filtering source events', posixOnly, () => {
  fixture((workspace, outside) => {
    const root = `${outside}/enter/..`;
    const roots = sourceWatcherRoots(root, []);
    assert.deepEqual(roots, [fs.realpathSync.native(root)]);
    assert.equal(isWatchedSourcePath(roots, normalizeSourcePath(path.join(workspace, 'models.py')), ignored), true);
    assert.equal(isWatchedSourcePath(roots, normalizeSourcePath(path.join(outside, 'models.py')), ignored), false);
  });
});

test('an editable root reached through link/.. is not collapsed into the workspace', posixOnly, () => {
  fixture((workspace, outside) => {
    const editable = `${workspace}/escape/..`;
    const roots = sourceWatcherRoots(workspace, [editable]);
    assert.deepEqual(roots, [fs.realpathSync.native(workspace), fs.realpathSync.native(outside)].sort());
    assert.equal(isWatchedSourcePath(roots, normalizeSourcePath(path.join(outside, 'models.py')), ignored), true);
  });
});

test('a deleted source through link/.. retains its actual workspace namespace', posixOnly, () => {
  fixture((workspace, outside) => {
    const expected = fs.realpathSync.native(path.join(workspace, 'models.py'));
    fs.unlinkSync(path.join(workspace, 'models.py'));
    const source = `${outside}/enter/../models.py`;
    assert.equal(fs.existsSync(source), false);
    const actual = normalizeSourcePath(source);
    assert.equal(actual, expected);
    assert.equal(isWatchedSourcePath(sourceWatcherRoots(workspace, []), actual, ignored), true);
  });
});

test('a deleted outside source is not queued under a lexical workspace prefix', posixOnly, () => {
  fixture((workspace, outside) => {
    const expected = fs.realpathSync.native(path.join(outside, 'models.py'));
    fs.unlinkSync(path.join(outside, 'models.py'));
    const source = `${workspace}/escape/../models.py`;
    assert.equal(fs.existsSync(source), false);
    const actual = normalizeSourcePath(source);
    assert.equal(actual, expected);
    assert.equal(isWatchedSourcePath(sourceWatcherRoots(workspace, []), actual, ignored), false);
  });
});

test('missing descendant directories resolve against the nearest actual parent', posixOnly, () => {
  fixture((workspace, outside) => {
    const source = `${outside}/enter/../pending/nested/models.py`;
    assert.equal(fs.existsSync(source), false);
    const actual = normalizeSourcePath(source);
    assert.equal(actual, path.join(fs.realpathSync.native(workspace), 'pending/nested/models.py'));
    assert.equal(isWatchedSourcePath(sourceWatcherRoots(workspace, []), actual, ignored), true);
  });
});

test('relative paths preserve the filesystem order of link and parent traversal', posixOnly, () => {
  fixture((workspace, outside) => {
    for (const [base, link, owned] of [[outside, 'enter', true], [workspace, 'escape', false]] as const) {
      const source = `${path.relative(process.cwd(), base)}/${link}/../models.py`;
      assert.equal(path.isAbsolute(source), false);
      const actual = normalizeSourcePath(source);
      assert.equal(actual, fs.realpathSync.native(source));
      assert.equal(isWatchedSourcePath(sourceWatcherRoots(workspace, []), actual, ignored), owned);
    }
  });
});

test('retargeting a link is reflected by the next root and event normalization', posixOnly, () => {
  fixture((workspace, outside) => {
    const source = `${outside}/enter/../models.py`;
    const root = `${outside}/enter/..`;
    assert.equal(normalizeSourcePath(source), fs.realpathSync.native(path.join(workspace, 'models.py')));
    fs.unlinkSync(path.join(outside, 'enter'));
    fs.symlinkSync(path.join(outside, 'inner'), path.join(outside, 'enter'), 'dir');
    assert.equal(normalizeSourcePath(source), fs.realpathSync.native(path.join(outside, 'models.py')));
    assert.deepEqual(sourceWatcherRoots(root, []), [fs.realpathSync.native(outside)]);
    assert.equal(isWatchedSourcePath(sourceWatcherRoots(workspace, []), normalizeSourcePath(source), ignored), false);
  });
});

test('normalized dot paths survive pending work retention and are revoked with their roots', posixOnly, () => {
  fixture((workspace, outside) => {
    const currentRoot = fs.realpathSync.native(workspace);
    const source = normalizeSourcePath(`${outside}/enter/../models.py`);
    const files = new Set([source]);
    const deleted = new Set([source]);
    retainPendingSourceEvents(currentRoot, currentRoot, [currentRoot], files, deleted, ignored);
    assert.deepEqual([...files], [fs.realpathSync.native(path.join(workspace, 'models.py'))]);
    assert.deepEqual([...deleted], [...files]);
    retainPendingSourceEvents(currentRoot, currentRoot, [fs.realpathSync.native(outside)], files, deleted, ignored);
    assert.equal(files.size, 0);
    assert.equal(deleted.size, 0);
  });
});

test('directory scan ownership uses the actual link/.. namespace', posixOnly, () => {
  fixture((workspace, outside) => {
    fs.mkdirSync(path.join(workspace, 'nested'));
    const directory = `${outside}/enter/../nested`;
    const actual = normalizeSourcePath(directory);
    assert.equal(actual, fs.realpathSync.native(directory));
    assert.equal(shouldScanSourceDirectory(sourceWatcherRoots(workspace, []), actual, ignored), true);
  });
});

test('ignored paths are still excluded after resolving a parent through a link', posixOnly, () => {
  fixture((workspace, outside) => {
    fs.mkdirSync(path.join(workspace, '.git'));
    fs.writeFileSync(path.join(workspace, '.git', 'ignored.py'), 'value=1');
    const source = `${outside}/enter/../.git/ignored.py`;
    const actual = normalizeSourcePath(source);
    assert.equal(actual, fs.realpathSync.native(source));
    assert.equal(isWatchedSourcePath(sourceWatcherRoots(workspace, []), actual, ignored), false);
  });
});

test('ordinary parent paths, Unicode names and dot-prefixed words preserve their results', posixOnly, () => {
  fixture((workspace) => {
    fs.mkdirSync(path.join(workspace, '..valid'));
    fs.writeFileSync(path.join(workspace, '..valid', '한글-é.py'), 'value=1');
    for (const source of [`${workspace}/inner/../models.py`, `${workspace}/..valid/한글-é.py`, `${workspace}/./models.py`]) {
      assert.equal(normalizeSourcePath(source), fs.realpathSync.native(source));
      assert.equal(isWatchedSourcePath(sourceWatcherRoots(workspace, []), normalizeSourcePath(source), ignored), true);
    }
  });
});

test('ordinary file links and sibling boundaries retain existing canonical behavior', posixOnly, () => {
  fixture((workspace, outside) => {
    const source = path.join(workspace, 'file-link.py');
    fs.symlinkSync(path.join(outside, 'models.py'), source, 'file');
    assert.equal(normalizeSourcePath(source), fs.realpathSync.native(source));
    assert.equal(isWatchedSourcePath(sourceWatcherRoots(workspace, []), normalizeSourcePath(source), ignored), false);
    assert.equal(isWatchedSourcePath(sourceWatcherRoots(workspace, [outside]), normalizeSourcePath(source), ignored), true);
    assert.equal(isWatchedSourcePath([workspace], `${workspace}-sibling/models.py`, ignored), false);
  });
});
