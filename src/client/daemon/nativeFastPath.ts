// ============================================================================
// Native (Rust) fast-path for analysisDaemon IPC routing.
// ============================================================================
//
// Wraps the napi addon's resident-state query functions so analysisDaemon
// can try a microsecond Rust resolve before falling through to the slow
// Python IPC path. On any failure (addon missing, state not initialised,
// unresolved, exception) the wrapper returns `undefined` and the caller
// uses the original Python path unchanged — this keeps the migration
// zero-risk.
//
// Observed impact (from real-project logs):
//   - resolveRelationTarget:  Python 950-3084ms → Rust <0.02ms
//   - resolveLookupPath:      Python 2623ms     → Rust <0.01ms
//   - resolveOrmMember hit:   Python 280ms      → Rust <0.01ms
//   - hover budget exhaust:   disappears for pure-static members
// ============================================================================

import { tryLoadNative, type NativeBindings } from '../native/loader';
import type { SurfaceIndex } from '../../server/workspaceIndexer';
import type {
  RelationTargetResolution,
  RelationTargetsResult,
  LookupPathResolution,
  OrmMemberResolution,
  OrmMemberItem,
  OrmReceiverKind,
} from '../protocol';

type Logger = (level: 'info' | 'warn' | 'error', message: string) => void;

let native: NativeBindings | undefined;
let attempted = false;
let initialized = false;
let initInProgress: Promise<boolean> | null = null;
let currentRoot: string | null = null;
let stateSource: 'ast' | 'surface' | null = null;
let disabled = false;

function getNative(): NativeBindings | undefined {
  if (!attempted) {
    attempted = true;
    native = tryLoadNative();
  }
  return native;
}

export interface NativeFastPathInitOptions {
  workspaceRoot: string;
  log?: Logger;
  forceRebuild?: boolean;
}

export interface NativeFastPathSurfaceOptions {
  workspaceRoot: string;
  surfaceIndex: SurfaceIndex;
  log?: Logger;
  reason?: string;
}

function formatInitStats(res: { modelCount: number; fieldCount: number; edgeCount: number; elapsedMs: number; rebuilt: boolean; source?: string; parsedFileCount?: number; parseFailureCount?: number; directModelCount?: number; expandedModelCount?: number }): string {
  const source = res.source ?? 'unknown';
  const parseStats = res.parsedFileCount !== undefined || res.parseFailureCount !== undefined
    ? ` parsed=${res.parsedFileCount ?? 0} parseFailures=${res.parseFailureCount ?? 0}`
    : '';
  const modelStats = res.directModelCount !== undefined || res.expandedModelCount !== undefined
    ? ` direct=${res.directModelCount ?? 0} expanded=${res.expandedModelCount ?? 0}`
    : '';
  return `source=${source} models=${res.modelCount} fields=${res.fieldCount} ` +
    `edges=${res.edgeCount} elapsed=${res.elapsedMs}ms rebuilt=${res.rebuilt}` +
    parseStats +
    modelStats;
}

/**
 * Ensure the Rust resident state is built for `workspaceRoot`. Safe to
 * call repeatedly — subsequent calls for the same root are O(1) no-op
 * hits on the Rust side.
 *
 * Returns `true` if the fast path is ready after this call, `false` if
 * the native addon is missing/disabled or the init failed. Callers
 * should ignore `false` and continue with Python IPC.
 */
export async function ensureNativeFastPath(
  options: NativeFastPathInitOptions,
): Promise<boolean> {
  if (disabled) return false;
  const n = getNative();
  if (!n) return false;
  if (initialized && currentRoot === options.workspaceRoot && !options.forceRebuild) {
    return true;
  }
  if (initInProgress && currentRoot === options.workspaceRoot && !options.forceRebuild) {
    return initInProgress;
  }

  const work = (async () => {
    try {
      const res = n.nativeInit(options.workspaceRoot, options.forceRebuild ?? false);
      initialized = true;
      currentRoot = options.workspaceRoot;
      stateSource = 'ast';
      options.log?.(
        'info',
        `[fastpath] nativeInit ${formatInitStats(res)}`,
      );
      return true;
    } catch (err) {
      options.log?.(
        'warn',
        `[fastpath] nativeInit failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      disabled = true; // don't retry on every call
      return false;
    } finally {
      initInProgress = null;
    }
  })();
  initInProgress = work;
  return work;
}

export function isNativeFastPathReady(): boolean {
  return initialized && !disabled && stateSource === 'surface';
}

export function dropNativeFastPath(): void {
  const n = getNative();
  if (n) {
    try {
      n.nativeDrop();
    } catch {
      // non-critical
    }
  }
  initialized = false;
  currentRoot = null;
  stateSource = null;
  initInProgress = null;
}

/**
 * Hydrate the Rust resident state from the Python daemon's surfaceIndex.
 *
 * This is the authoritative fast-path input during the Rust migration:
 * Python owns high-coverage Django semantics, while Rust serves the
 * already-built surface with microsecond query latency. Empty surface
 * data intentionally disables the native fast path so queries fall back
 * to Python instead of returning AST-only false negatives.
 */
export async function hydrateNativeFastPathFromSurface(
  options: NativeFastPathSurfaceOptions,
): Promise<boolean> {
  if (disabled) return false;
  const n = getNative();
  if (!n) return false;

  const modelCount = Object.keys(options.surfaceIndex).length;
  if (modelCount === 0) {
    dropNativeFastPath();
    options.log?.('info', `[fastpath] native surface hydrate skipped (${options.reason ?? 'unknown'}): empty surfaceIndex`);
    return false;
  }

  const work = (async () => {
    try {
      const surfaceJson = JSON.stringify(options.surfaceIndex);
      const res = n.nativeInitFromSurface(
        options.workspaceRoot,
        Buffer.from(surfaceJson, 'utf-8'),
      );
      initialized = true;
      currentRoot = options.workspaceRoot;
      stateSource = 'surface';
      options.log?.(
        'info',
        `[fastpath] nativeInitFromSurface reason=${options.reason ?? 'unknown'} ` +
          `${formatInitStats(res)} payloadKb=${(surfaceJson.length / 1024).toFixed(1)}`,
      );
      return true;
    } catch (err) {
      dropNativeFastPath();
      options.log?.(
        'warn',
        `[fastpath] nativeInitFromSurface failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    } finally {
      initInProgress = null;
    }
  })();
  initInProgress = work;
  return work;
}

function tryParse<T>(buf: Buffer | null): T | undefined {
  if (!buf) return undefined;
  try {
    return JSON.parse(buf.toString('utf-8')) as T;
  } catch {
    return undefined;
  }
}

/**
 * Try `resolveRelationTarget` on the resident state. Returns:
 *   - `undefined` when native path is unavailable (use Python)
 *   - `RelationTargetResolution` shaped exactly like the Python reply
 *     when a static answer (resolved / ambiguous / not_found) can be
 *     given. For `not_found` we still return the negative result so
 *     the caller can skip the IPC for truly-missing values. If the
 *     caller wants runtime-augmented answers it should re-check the
 *     `matchKind` / `reason` fields and decide.
 */
export function nativeResolveRelationTarget(
  value: string,
): RelationTargetResolution | undefined {
  if (!initialized || disabled) return undefined;
  const n = getNative();
  if (!n) return undefined;
  try {
    const buf = n.nativeResolveRelationTarget(value);
    return tryParse<RelationTargetResolution>(buf);
  } catch {
    return undefined;
  }
}

export function nativeListRelationTargets(
  prefix: string | undefined,
): RelationTargetsResult | undefined {
  if (!initialized || disabled) return undefined;
  const n = getNative();
  if (!n) return undefined;
  try {
    const buf = n.nativeListRelationTargets(prefix ?? null);
    const items = tryParse<RelationTargetsResult['items']>(buf);
    if (!Array.isArray(items)) return undefined;
    return { items };
  } catch {
    return undefined;
  }
}

export function nativeResolveLookupPath(
  baseModelLabel: string,
  value: string,
  method: string,
): LookupPathResolution | undefined {
  if (!initialized || disabled) return undefined;
  const n = getNative();
  if (!n) return undefined;
  try {
    const buf = n.nativeResolveLookupPath(baseModelLabel, value, method);
    return tryParse<LookupPathResolution>(buf);
  } catch {
    return undefined;
  }
}

/**
 * Try `resolveOrmMember` statically. Returns:
 *   - `undefined` if native path unavailable or the member is unknown
 *     to the static surface (caller falls back to Python for
 *     runtime-defined methods).
 *   - `OrmMemberResolution` with `resolved: true` when we have a
 *     confident static hit (declared field or Django built-in).
 */
export function nativeResolveOrmMember(
  modelLabel: string,
  receiverKind: OrmReceiverKind,
  name: string,
  managerName?: string,
): OrmMemberResolution | undefined {
  if (!initialized || disabled) return undefined;
  const n = getNative();
  if (!n) return undefined;
  try {
    const buf = n.nativeResolveOrmMember(modelLabel, receiverKind, name, managerName ?? null);
    if (!buf) return undefined;
    const item = tryParse<OrmMemberItem | null>(buf);
    if (!item) return undefined;
    return { resolved: true, item };
  } catch {
    return undefined;
  }
}
