// TS → Rust napi snapshot/fingerprint E2E.
// Invoke: node out/client/native/discovery.test.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadNative } from './loader';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function main(): void {
  const n = loadNative();

  // Rust <-> Python byte-exact fingerprint agreement was verified out-of-band.
  const fp = n.fileFingerprint('app/models.py', 42, '1234567890');
  assert(
    fp === 'dda99b28e96922cd85870431f0a0b129e173c47f9bf0ec0733f9aed8f7448137',
    `unexpected fingerprint: ${fp}`,
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'django-orm-discover-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'app1'));
    fs.mkdirSync(path.join(tmpDir, 'app2'));
    fs.mkdirSync(path.join(tmpDir, '.venv'));
    fs.writeFileSync(path.join(tmpDir, 'app1/models.py'), 'x = 1');
    fs.writeFileSync(path.join(tmpDir, 'app2/models.py'), 'y = 2');
    fs.writeFileSync(path.join(tmpDir, 'manage.py'), '');
    fs.writeFileSync(path.join(tmpDir, '.venv/ignored.py'), 'z = 3');

    const snap = n.snapshotPythonSources(tmpDir);
    assert(snap.entries.length === 3, `expected 3 entries, got ${snap.entries.length}`);
    assert(
      !snap.entries.some((e) => e.relativePath.includes('.venv')),
      'hidden dirs must be skipped',
    );
    const dirs = new Set(snap.directoryFingerprints.map(([k]) => k));
    assert(dirs.has(''), 'root dir entry present');
    assert(dirs.has('app1'), 'app1 dir entry present');

    // Snapshot is stable on unchanged input.
    const snap2 = n.snapshotPythonSources(tmpDir);
    assert(snap.fingerprint === snap2.fingerprint, 'fingerprint stable');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('discovery napi bindings OK');
}

main();
