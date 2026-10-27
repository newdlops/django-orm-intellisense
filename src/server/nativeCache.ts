// ============================================================================
// Native (Rust) cache layer for the TS language server.
// ============================================================================
//
// Persists the last-received surfaceIndex (and accompanying modelNames,
// customLookups) to a bincode envelope via napi. On LSP startup the cache
// is restored after source validation while the Python daemon boots.
//
// The cache is treated as a pre-warm hint only. Authoritative data still
// arrives via django/updateSurfaceIndex once the Python daemon is ready.
// Producer source, interpreter/settings and launch environment must match.
// ============================================================================

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { loadNative } from '../client/native/loader';
import type { StaticFallback, SurfaceIndex } from './workspaceIndexer';
import { isSurfaceSourceProvenance, type SurfaceSourceProvenance, type SurfaceCacheContext } from '../client/surfaceSourceProvenance';

const CACHE_FILENAME = 'surface-index-v1.bin';

export interface SurfaceCachePayload {
  sourceProvenance?: SurfaceSourceProvenance | null;
  lookupCatalog?: import('./lookupCatalog').LookupCatalogPayload;
  surfaceIndex: SurfaceIndex;
  modelNames: string[];
  surfaceFingerprints?: Record<string, string>;
  customLookups?: Record<string, string[]>;
  customLookupsFingerprint?: string;
  staticFallback?: StaticFallback;
  staticFallbackFingerprint?: string | null;
}

export interface SurfaceCacheMetadata {
  /** Bumped whenever SurfaceCachePayload shape changes. */
  formatVersion: 3;
  /** Workspace root used as the cache key on disk. */
  workspaceRoot: string;
  /** Epoch ms of when the cache was written. */
  savedAt: number;
}

function normalizeWorkspaceRoot(workspaceRoot: string): string {
  let r = workspaceRoot;
  if (r.startsWith('file:')) r = fileURLToPath(r);
  return fs.realpathSync(r);
}

function belongsToWorkspace(workspaceRoot: string, proof: SurfaceSourceProvenance): boolean {
  return normalizeWorkspaceRoot(workspaceRoot) === proof.root;
}

async function matchesContext(proof: SurfaceSourceProvenance, context: SurfaceCacheContext): Promise<boolean> {
  if (!belongsToWorkspace(context.workspaceRoot, proof)
    || path.resolve(context.pythonPath) !== proof.interpreter.path
    || context.settingsModule !== proof.requestedSettingsModule
    || context.launchEnvironmentFingerprint !== proof.launchEnvironmentFingerprint) return false;
  const [realPath, stat] = await Promise.all([
    fs.promises.realpath(context.pythonPath), fs.promises.stat(context.pythonPath, { bigint: true }),
  ]);
  return stat.isFile() && realPath === proof.interpreter.realPath
    && [stat.size, stat.mtimeNs, stat.ctimeNs, stat.dev, stat.ino].map(String)
      .every((value, index) => value === proof.interpreter.identity[index]);
}

function cacheRoot(): string {
  const override = process.env.DJANGO_ORM_INTELLISENSE_CACHE_DIR;
  if (override) return override;
  return path.join(os.tmpdir(), 'django-orm-intellisense');
}

function surfaceCachePath(workspaceRoot: string): string | null {
  try {
    const normalized = normalizeWorkspaceRoot(workspaceRoot);
    const n = loadNative();
    const dir = n.workspaceCacheDir(cacheRoot(), normalized);
    return path.join(dir, CACHE_FILENAME);
  } catch {
    return null;
  }
}

/**
 * Save the TS-side surfaceIndex to a bincode cache. Non-blocking from
 * the caller's perspective — errors are swallowed (cache is a hint).
 */
export function saveSurfaceCache(
  workspaceRoot: string,
  payload: SurfaceCachePayload,
): void {
  if (!isSurfaceSourceProvenance(payload.sourceProvenance)) return;
  const p = surfaceCachePath(workspaceRoot);
  if (!p) return;
  try {
    const n = loadNative();
    if (!belongsToWorkspace(workspaceRoot, payload.sourceProvenance)) return;
    const meta: SurfaceCacheMetadata = {
      formatVersion: 3,
      workspaceRoot: normalizeWorkspaceRoot(workspaceRoot),
      savedAt: Date.now(),
    };
    const metaBytes = Buffer.from(JSON.stringify(meta), 'utf-8');
    const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf-8');
    n.saveCacheBlob(p, metaBytes, payloadBytes);
  } catch {
    // non-critical — the Python daemon produces authoritative data anyway
  }
}

/** Yield between model entries; disk serialization/writes run on a worker. */
export async function saveSurfaceCacheAsync(
  workspaceRoot: string,
  payload: SurfaceCachePayload,
): Promise<void> {
  if (!isSurfaceSourceProvenance(payload.sourceProvenance)) return;
  const p = surfaceCachePath(workspaceRoot);
  if (!p) return;
  try {
    const n = loadNative();
    if (!belongsToWorkspace(workspaceRoot, payload.sourceProvenance)) return;
    if (!n.saveCacheBlobChunksAsync) return; // Optional cache hint on older addons.
    const meta: SurfaceCacheMetadata = {
      formatVersion: 3, workspaceRoot: normalizeWorkspaceRoot(workspaceRoot), savedAt: Date.now(),
    };
    // Capture entries before the first yield. Incremental updates replace
    // model values, so this stays one consistent revision during serialization.
    const entries = Object.entries(payload).map(([key, value]) => ({ key, value,
      members: value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : undefined }));
    const chunks: Buffer[] = [Buffer.from('{')];
    let sliceStart = performance.now();
    for (let i = 0; i < entries.length; i++) {
      const { key, value, members } = entries[i];
      if (value === undefined) continue;
      chunks.push(Buffer.from(`${chunks.length > 1 ? ',' : ''}${JSON.stringify(key)}:`));
      if (members) {
        chunks.push(Buffer.from('{'));
        for (let j = 0; j < members.length; j++) {
          const [name, member] = members[j];
          chunks.push(Buffer.from(`${j ? ',' : ''}${JSON.stringify(name)}:`));
          if (key === 'lookupCatalog' && member && typeof member === 'object' && !Array.isArray(member)) {
            chunks.push(Buffer.from('{'));
            const catalogEntries = Object.entries(member);
            for (let k = 0; k < catalogEntries.length; k++) {
              const [label, entry] = catalogEntries[k];
              chunks.push(Buffer.from(`${k ? ',' : ''}${JSON.stringify(label)}:${JSON.stringify(entry)}`));
              if (performance.now() - sliceStart >= 4) {
                await new Promise<void>(resolve => setImmediate(resolve));
                sliceStart = performance.now();
              }
            }
            chunks.push(Buffer.from('}'));
          } else chunks.push(Buffer.from(JSON.stringify(member)));
          if (performance.now() - sliceStart >= 4) {
            await new Promise<void>(resolve => setImmediate(resolve));
            sliceStart = performance.now();
          }
        }
        chunks.push(Buffer.from('}'));
      } else chunks.push(Buffer.from(JSON.stringify(value)));
    }
    chunks.push(Buffer.from('}'));
    await n.saveCacheBlobChunksAsync(p, Buffer.from(JSON.stringify(meta)), chunks);
  } catch {
    // Cache is only a hint; authoritative daemon data still wins.
  }
}

/**
 * Load a cached surfaceIndex if one exists and matches the current
 * workspace. Returns null on miss, corruption, or any native error.
 */
export async function loadSurfaceCache(workspaceRoot: string, context?: SurfaceCacheContext): Promise<SurfaceCachePayload | null> {
  if (!context) return null;
  const p = surfaceCachePath(workspaceRoot);
  if (!p) return null;
  try {
    const n = loadNative();
    if (!n.fingerprintPythonSourceProofAsync) return null;
    const hit = n.loadCacheBlob(p);
    if (!hit) return null;
    const meta = JSON.parse(hit.metadata.toString('utf-8')) as Partial<SurfaceCacheMetadata>;
    if (meta.formatVersion !== 3) return null;
    if (meta.workspaceRoot !== normalizeWorkspaceRoot(workspaceRoot)) return null;
    const payload = JSON.parse(hit.payload.toString('utf-8')) as SurfaceCachePayload;
    const proof = payload?.sourceProvenance;
    if (!isSurfaceSourceProvenance(proof) || !payload.surfaceIndex || typeof payload.surfaceIndex !== 'object'
      || Array.isArray(payload.surfaceIndex) || !Array.isArray(payload.modelNames)
      || !payload.modelNames.every(name => typeof name === 'string')
      || !belongsToWorkspace(workspaceRoot, proof) || !await matchesContext(proof, context)) return null;
    const current = await n.fingerprintPythonSourceProofAsync(proof.root, proof.extraRoots);
    if (current.fingerprintVersion !== 2 || current.membershipVersion !== 1 || current.root !== proof.root
      || current.fingerprint !== proof.sourceFingerprint || current.membershipFingerprint !== proof.membershipFingerprint
      || !await matchesContext(proof, context)) return null;
    return payload;
  } catch {
    return null;
  }
}
