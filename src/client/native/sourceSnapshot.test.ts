// Invoke after building the addon: node out/client/native/sourceSnapshot.test.js
import * as assert from 'assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadNative } from './loader';

async function main(): Promise<void> {
  const native = loadNative();
  const snapshot = native.snapshotPythonSourcesV2;
  const fingerprint = native.fingerprintPythonSourcesV2Async;
  const sourceProof = native.fingerprintPythonSourceProofAsync;
  assert.ok(snapshot && fingerprint && sourceProof, 'The built addon must expose versioned source capabilities');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'djls-source-v2-'));
  try {
    if (process.platform === 'win32') {
      assert.throws(() => snapshot(folder), /not supported/);
      await assert.rejects(fingerprint(folder), /not supported/);
      await assert.rejects(sourceProof(folder), /not supported/);
      return;
    }
    const root = path.join(folder, 'root');
    const extra = path.join(folder, 'extra');
    const unused = path.join(folder, 'unused');
    fs.mkdirSync(path.join(root, 'a'), { recursive: true });
    fs.mkdirSync(path.join(root, '.venv'));
    fs.mkdirSync(extra);
    fs.mkdirSync(unused);
    for (const name of ['a/file.py', 'a.py', '.py', '.hidden.py', '.venv/ignored.py']) {
      fs.writeFileSync(path.join(root, name), 'value = 1\n');
    }
    fs.writeFileSync(path.join(extra, 'external.py'), 'external = 1\n');
    fs.writeFileSync(path.join(unused, 'unused.py'), 'unused = 1\n');
    const result = snapshot(root, [extra, root, extra]);
    assert.equal(result.fingerprintVersion, 2);
    assert.equal(result.root, root);
    const local = result.entries.filter(entry => !path.isAbsolute(entry.relativePath));
    assert.deepEqual(local.map(entry => entry.relativePath), ['.hidden.py', '.py', 'a/file.py', 'a.py']);
    assert.equal(result.entries.length, 5);
    const proof = await sourceProof(root, [extra, root, extra]);
    const canonical = crypto.createHash('sha256').update('django-orm-source-membership-v1\0')
      .update(`R\0${fs.realpathSync(root)}\0`);
    for (const entry of [...result.entries].sort((a, b) => Buffer.compare(Buffer.from(a.relativePath), Buffer.from(b.relativePath)))) {
      canonical.update(`F\0${entry.relativePath}\0${fs.realpathSync(path.resolve(root, entry.relativePath))}\0`);
    }
    assert.equal(proof.fingerprint, result.fingerprint);
    assert.equal(proof.membershipFingerprint, canonical.digest('hex'), 'independent canonical oracle includes external and overlapping roots');
    for (const entry of result.entries) {
      const file = path.isAbsolute(entry.relativePath) ? entry.relativePath : path.join(root, entry.relativePath);
      const stat = fs.statSync(file, { bigint: true });
      assert.equal(entry.size, String(stat.size));
      assert.equal(entry.mtimeNs, String(stat.mtimeNs));
      assert.equal(entry.ctimeNs, String(stat.ctimeNs));
      assert.equal(entry.device, String(stat.dev));
      assert.equal(entry.inode, String(stat.ino));
      const encoded = `${entry.relativePath}\0${entry.size}:${entry.mtimeNs}:${entry.ctimeNs}:${entry.device}:${entry.inode}`;
      assert.equal(entry.fingerprint, crypto.createHash('sha256').update(encoded).digest('hex'));
    }
    const roots = [extra];
    const pending = fingerprint(root, roots);
    roots.push(unused);
    const compact = await pending;
    assert.deepEqual(compact, { fingerprintVersion: 2, root, fingerprint: result.fingerprint, fileCount: 5 });
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => fingerprint(root, [extra])));
    concurrent.forEach(item => assert.deepEqual(item, compact));
    assert.throws(() => snapshot(path.join(folder, 'absent')), /Source snapshot v2/);
    await assert.rejects(fingerprint(root, [path.join(folder, 'absent')]), /Source snapshot v2/);
    fs.symlinkSync(path.join(folder, 'missing.py'), path.join(root, 'broken.py'));
    assert.throws(() => snapshot(root), /Source snapshot v2/);
    await assert.rejects(fingerprint(root), /Source snapshot v2/);
    await assert.rejects(sourceProof(root), /Source snapshot v2/);
    assert.equal(native.fileFingerprint('app/models.py', 42, '1234567890'),
      'dda99b28e96922cd85870431f0a0b129e173c47f9bf0ec0733f9aed8f7448137');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
  console.log('source snapshot v2 native capabilities, exact identities, async ownership and errors OK');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
