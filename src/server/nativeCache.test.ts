// Smoke test for the surface-index native cache round-trip.
// Invoke: node out/server/nativeCache.test.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { saveSurfaceCache, saveSurfaceCacheAsync, loadSurfaceCache, type SurfaceCachePayload } from './nativeCache';
import { loadNative } from '../client/native/loader';
import type { SurfaceCacheContext, SurfaceSourceProvenance } from '../client/surfaceSourceProvenance';
import { pathToFileURL } from 'url';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function makeSurfaceIndex(modelCount: number): SurfaceCachePayload['surfaceIndex'] {
  const out: SurfaceCachePayload['surfaceIndex'] = {};
  for (let i = 0; i < modelCount; i++) {
    const label = `app${Math.floor(i / 50)}.Model${i}`;
    const instance: Record<string, [string, string | null]> = {};
    for (let f = 0; f < 20; f++) {
      instance[`field_${f}`] = ['CharField', null];
    }
    instance[`fk_0`] = [`ForeignKey[app${Math.floor(i / 50)}.Model${(i + 1) % modelCount}]`, 'instance'];
    out[label] = { instance };
  }
  return out;
}

async function main(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'django-orm-surface-cache-'));
  try {
    process.env.DJANGO_ORM_INTELLISENSE_CACHE_DIR = tmpDir;
    const workspaceRoot = path.join(fs.realpathSync(tmpDir), 'workspace space 한글');
    fs.mkdirSync(workspaceRoot);
    const source = path.join(workspaceRoot, 'models.py');
    fs.writeFileSync(source, 'old_code = 1\n');
    const n = loadNative();
    const selected = process.execPath;
    const stamp = fs.statSync(selected, { bigint: true });
    const sourceState = await n.fingerprintPythonSourceProofAsync!(workspaceRoot);
    const proof: SurfaceSourceProvenance = {
      version: 2, fingerprintVersion: 2, membershipVersion: 1, root: workspaceRoot, extraRoots: [],
      sourceFingerprint: sourceState.fingerprint, membershipFingerprint: sourceState.membershipFingerprint,
      requestedSettingsModule: 'project.development', interpreter: {
        path: selected, realPath: fs.realpathSync(selected),
        identity: [stamp.size, stamp.mtimeNs, stamp.ctimeNs, stamp.dev, stamp.ino].map(String),
      },
      launchEnvironmentFingerprint: 'e'.repeat(64),
    };
    const context: SurfaceCacheContext = { owner: 'test-session-1', workspaceRoot,
      pythonPath: selected, settingsModule: 'project.development', launchEnvironmentFingerprint: 'e'.repeat(64) };

    // Cold: miss
    assert(await loadSurfaceCache(workspaceRoot, context) === null, 'initially miss');

    // Save payload
    const payload: SurfaceCachePayload = {
      sourceProvenance: proof,
      surfaceIndex: makeSurfaceIndex(1500),
      modelNames: Array.from({ length: 1500 }, (_, i) => `Model${i}`),
      surfaceFingerprints: { 'app0.Model0': 'abc123' },
      customLookups: { 'app.Model0': ['unaccent'] },
      customLookupsFingerprint: 'lookups123',
      lookupCatalog: {
        types: { text: { fieldKind: 'CharField', lookups: ['exact', 'instance_only'], transforms: {} } },
        fields: { 'app0.Model0': { field_0: 'text' } }, kinds: { CharField: 'text' },
        expressionFields: { 'app0.Model0': { fk_0: 'text' } },
        relationPaths: { 'app0.Model0': { entry: { accessorName: 'entries', queryName: 'entry' } } },
      },
      staticFallback: {
        'authtoken.Token': { fields: ['key'], runtimeOnly: true },
      },
      staticFallbackFingerprint: 'fallback123',
    };
    const tSave = performance.now();
    saveSurfaceCache(workspaceRoot, payload);
    const saveMs = performance.now() - tSave;

    // Load: hit
    const tLoad = performance.now();
    const loaded = await loadSurfaceCache(workspaceRoot, context);
    const loadMs = performance.now() - tLoad;
    assert(loaded !== null, 'cached after save');
    assert(Object.keys(loaded!.surfaceIndex).length === 1500, 'surfaceIndex preserved');
    assert(loaded!.modelNames.length === 1500, 'modelNames preserved');
    assert(loaded!.surfaceFingerprints?.['app0.Model0'] === 'abc123', 'surfaceFingerprints preserved');
    assert(loaded!.customLookups?.['app.Model0']?.[0] === 'unaccent', 'customLookups preserved');
    assert(loaded!.customLookupsFingerprint === 'lookups123', 'customLookupsFingerprint preserved');
    assert(JSON.stringify(loaded!.lookupCatalog) === JSON.stringify(payload.lookupCatalog), 'lookup catalog and relation paths preserved');
    assert(loaded!.staticFallbackFingerprint === 'fallback123', 'staticFallbackFingerprint preserved');
    // The LS pre-warms from this snapshot; losing the flag would register
    // third-party short names for receiver inference.
    assert(
      loaded!.staticFallback?.['authtoken.Token']?.runtimeOnly === true,
      'staticFallback runtimeOnly flag preserved',
    );

    // Different workspace → miss
    const otherLoaded = await loadSurfaceCache('/other/workspace', context);
    assert(otherLoaded === null, 'different workspace → miss');

    const firstLabel = Object.keys(payload.surfaceIndex)[0];
    const before = JSON.stringify(payload.surfaceIndex[firstLabel]);
    const pending = saveSurfaceCacheAsync(workspaceRoot, payload);
    payload.surfaceIndex[firstLabel] = { instance: { newer: ['scalar', null, 'field', 'IntegerField'] } };
    await pending;
    assert(JSON.stringify((await loadSurfaceCache(workspaceRoot, context))?.surfaceIndex[firstLabel]) === before,
      'async serialization captures a consistent snapshot before yielding');
    await saveSurfaceCacheAsync(workspaceRoot, payload);
    assert((await loadSurfaceCache(workspaceRoot, context))?.surfaceIndex[firstLabel].instance.newer[3] === 'IntegerField',
      'async cache saves the following revision');

    assert(await loadSurfaceCache(workspaceRoot) === null, 'unresolved selected context cannot prewarm');
    assert(await loadSurfaceCache(workspaceRoot, { ...context, settingsModule: 'project.production' }) === null,
      'settings modules in the same package are distinct');
    assert(await loadSurfaceCache(workspaceRoot, { ...context, pythonPath: selected + '-other' }) === null,
      'a different selected interpreter cannot prewarm');
    assert(await loadSurfaceCache(workspaceRoot, { ...context, launchEnvironmentFingerprint: 'f'.repeat(64) }) === null,
      'changed launch environment cannot prewarm even with identical source/interpreter/settings');
    const legacy = { ...payload, sourceProvenance: { ...proof, version: 1 } } as unknown as SurfaceCachePayload;
    saveSurfaceCache(workspaceRoot, legacy);
    await saveSurfaceCacheAsync(workspaceRoot, legacy);
    assert((await loadSurfaceCache(workspaceRoot, context))?.sourceProvenance?.version === 2,
      'legacy producer proof cannot overwrite the current environment-bound cache');
    await saveSurfaceCacheAsync(workspaceRoot, { ...payload, sourceProvenance: null, modelNames: [] });
    assert((await loadSurfaceCache(workspaceRoot, context))?.modelNames.length === 1500,
      'unproved partial frames cannot overwrite the valid cache');

    const original = fs.statSync(source);
    fs.writeFileSync(source, 'new_code = 1\n');
    fs.utimesSync(source, original.atime, original.mtime);
    // Persist the old payload after editing, exactly the debounce race.
    await saveSurfaceCacheAsync(workspaceRoot, payload);
    assert(await loadSurfaceCache(workspaceRoot, context) === null,
      'save-time filesystem state must never restamp old metadata');

    const external = path.join(tmpDir, 'external'); fs.mkdirSync(external);
    const oldTarget = path.join(external, 'old.py'), newTarget = path.join(external, 'new.py');
    fs.writeFileSync(oldTarget, 'model = 1\n'); fs.linkSync(oldTarget, newTarget);
    fs.unlinkSync(source); fs.symlinkSync(oldTarget, source);
    const oldLink = await n.fingerprintPythonSourceProofAsync!(workspaceRoot);
    const linkPayload = { ...payload, sourceProvenance: { ...proof,
      sourceFingerprint: oldLink.fingerprint, membershipFingerprint: oldLink.membershipFingerprint } };
    await saveSurfaceCacheAsync(workspaceRoot, linkPayload);
    assert(await loadSurfaceCache(workspaceRoot, context), 'unchanged file-link cache remains usable');
    fs.unlinkSync(source); fs.symlinkSync(newTarget, source);
    const newLink = await n.fingerprintPythonSourceProofAsync!(workspaceRoot);
    assert(oldLink.fingerprint === newLink.fingerprint, 'hardlink targets have identical v2 stat identity');
    assert(oldLink.membershipFingerprint !== newLink.membershipFingerprint, 'canonical names differ');
    assert(await loadSurfaceCache(workspaceRoot, context) === null, 'hardlink retarget rejects old metadata');
    fs.unlinkSync(source); fs.symlinkSync(oldTarget, source);
    assert(await loadSurfaceCache(workspaceRoot, context), 'return to the original unchanged canonical owner is valid');

    const missingCapability = n.fingerprintPythonSourceProofAsync;
    n.fingerprintPythonSourceProofAsync = undefined;
    try { assert(await loadSurfaceCache(workspaceRoot, context) === null, 'older addons cannot substitute a legacy hash'); }
    finally { n.fingerprintPythonSourceProofAsync = missingCapability; }
    const file = path.join(n.workspaceCacheDir(tmpDir, workspaceRoot), 'surface-index-v1.bin');
    n.saveCacheBlob(file, Buffer.from(JSON.stringify({ formatVersion: 1, workspaceRoot, savedAt: 1 })),
      Buffer.from(JSON.stringify(linkPayload)));
    assert(await loadSurfaceCache(workspaceRoot, context) === null, 'legacy envelopes are unproved');

    const uri = pathToFileURL(workspaceRoot).href;
    await saveSurfaceCacheAsync(uri, linkPayload);
    assert(await loadSurfaceCache(uri, context), 'encoded file URIs preserve spaces and Unicode');
    const alias = path.join(tmpDir, 'workspace-alias');
    fs.symlinkSync(workspaceRoot, alias, 'dir');
    assert(await loadSurfaceCache(alias, { ...context, workspaceRoot: alias }),
      'unchanged workspace aliases share the producer canonical cache key');
    assert(await loadSurfaceCache(pathToFileURL(alias).href, { ...context, workspaceRoot: alias }),
      'file URI aliases share the same canonical cache key');

    console.log(
      `surface cache napi OK: save=${saveMs.toFixed(1)}ms load=${loadMs.toFixed(1)}ms ` +
        `models=${Object.keys(loaded!.surfaceIndex).length}`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DJANGO_ORM_INTELLISENSE_CACHE_DIR;
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
