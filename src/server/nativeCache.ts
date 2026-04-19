// ============================================================================
// Native (Rust) cache layer for the TS language server.
// ============================================================================
//
// Persists the last-received surfaceIndex (and accompanying modelNames,
// customLookups) to a bincode envelope via napi. On LSP startup the cache
// is restored before the Python daemon finishes booting, so completions
// are available in ~10-30ms instead of 500-1000ms.
//
// The cache is treated as a pre-warm hint only. Authoritative data still
// arrives via django/updateSurfaceIndex once the Python daemon is ready.
// On mismatch, the fresh payload wins.
// ============================================================================

import * as os from 'os';
import * as path from 'path';
import { loadNative } from '../client/native/loader';
import type { SurfaceIndex } from './workspaceIndexer';

const CACHE_FILENAME = 'surface-index-v1.bin';

export interface SurfaceCachePayload {
  surfaceIndex: SurfaceIndex;
  modelNames: string[];
  surfaceFingerprints?: Record<string, string>;
  customLookups?: Record<string, string[]>;
  customLookupsFingerprint?: string;
  staticFallback?: Record<string, { fields: string[]; relations: string[] }>;
  staticFallbackFingerprint?: string | null;
}

export interface SurfaceCacheMetadata {
  /** Bumped whenever SurfaceCachePayload shape changes. */
  formatVersion: 1;
  /** Workspace root used as the cache key on disk. */
  workspaceRoot: string;
  /** Epoch ms of when the cache was written. */
  savedAt: number;
}

function normalizeWorkspaceRoot(workspaceRoot: string): string {
  let r = workspaceRoot;
  if (r.startsWith('file://')) r = r.replace(/^file:\/\//, '');
  return r;
}

function cacheRoot(): string {
  const override = process.env.DJANGO_ORM_INTELLISENSE_CACHE_DIR;
  if (override) return override;
  return path.join(os.tmpdir(), 'django-orm-intellisense');
}

function surfaceCachePath(workspaceRoot: string): string | null {
  const normalized = normalizeWorkspaceRoot(workspaceRoot);
  try {
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
  const p = surfaceCachePath(workspaceRoot);
  if (!p) return;
  try {
    const n = loadNative();
    const meta: SurfaceCacheMetadata = {
      formatVersion: 1,
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

/**
 * Load a cached surfaceIndex if one exists and matches the current
 * workspace. Returns null on miss, corruption, or any native error.
 */
export function loadSurfaceCache(workspaceRoot: string): SurfaceCachePayload | null {
  const p = surfaceCachePath(workspaceRoot);
  if (!p) return null;
  try {
    const n = loadNative();
    const hit = n.loadCacheBlob(p);
    if (!hit) return null;
    const meta = JSON.parse(hit.metadata.toString('utf-8')) as Partial<SurfaceCacheMetadata>;
    if (meta.formatVersion !== 1) return null;
    if (meta.workspaceRoot !== normalizeWorkspaceRoot(workspaceRoot)) return null;
    return JSON.parse(hit.payload.toString('utf-8')) as SurfaceCachePayload;
  } catch {
    return null;
  }
}
