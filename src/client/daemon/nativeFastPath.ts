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
  ExportOriginResolution,
  ModuleResolution,
  RelationTargetResolution,
  RelationTargetsResult,
  LookupPathResolution,
  LookupPathCompletionsResult,
  OrmMemberResolution,
  OrmMemberCompletionsResult,
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
      // AST init populates modules directly, so downstream export
      // queries can run without a separate ensure call.
      astModulesEnsured = true;
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
  astModulesEnsured = false;
  astModulesEnsuring = null;
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
      // Surface hydrate leaves `modules` empty. A follow-up
      // `ensureNativeAstModules` call has to run before export-origin
      // queries can be answered natively.
      astModulesEnsured = false;
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

/**
 * Try bulk `listLookupPathCompletions` on the resident state. Returns
 * `undefined` when the native path is unavailable; otherwise a full
 * completion list (may be empty when `resolved=false`).
 */
export function nativeListLookupPathCompletions(
  baseModelLabel: string,
  prefix: string,
  method: string,
): LookupPathCompletionsResult | undefined {
  if (!initialized || disabled) return undefined;
  const n = getNative();
  if (!n) return undefined;
  try {
    const buf = n.nativeListLookupPathCompletions(baseModelLabel, prefix, method);
    return tryParse<LookupPathCompletionsResult>(buf);
  } catch {
    return undefined;
  }
}

/**
 * Try bulk `listOrmMemberCompletions` on the resident state. Returns the
 * static complement — project `def` methods and dynamic managers remain
 * served by Python. Callers should fall back to Python for the richer
 * member surface when the receiver is instance without a local class
 * source, etc.
 */
export function nativeListOrmMemberCompletions(
  modelLabel: string,
  receiverKind: OrmReceiverKind,
  prefix: string,
  managerName?: string,
): OrmMemberCompletionsResult | undefined {
  if (!initialized || disabled) return undefined;
  const n = getNative();
  if (!n) return undefined;
  try {
    const buf = n.nativeListOrmMemberCompletions(
      modelLabel,
      receiverKind,
      prefix || null,
      managerName ?? null,
    );
    return tryParse<OrmMemberCompletionsResult>(buf);
  } catch {
    return undefined;
  }
}

/**
 * Try `resolveExportOrigin` on the resident static index. Returns
 * `undefined` when either the native state is missing or the modules
 * data has not been populated yet — caller should fall back to Python.
 * When `resolution.resolved === false`, the caller can still use that
 * result (Python would return the same). Callers that want a definitive
 * hit before falling back should check `resolved` before returning.
 */
export function nativeResolveExportOrigin(
  moduleName: string,
  symbol: string,
): ExportOriginResolution | undefined {
  if (!initialized || disabled) return undefined;
  const n = getNative();
  if (!n) return undefined;
  try {
    const buf = n.nativeResolveExportOrigin(moduleName, symbol);
    if (!buf) return undefined;
    const parsed = tryParse<ExportOriginResolution | null>(buf);
    return parsed ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Try `resolveModule` on the resident static index. Returns `undefined`
 * when the native state is missing or modules are not populated.
 */
export function nativeResolveModule(
  moduleName: string,
): ModuleResolution | undefined {
  if (!initialized || disabled) return undefined;
  const n = getNative();
  if (!n) return undefined;
  try {
    const buf = n.nativeResolveModule(moduleName);
    if (!buf) return undefined;
    const parsed = tryParse<ModuleResolution | null>(buf);
    return parsed ?? undefined;
  } catch {
    return undefined;
  }
}

let astModulesEnsured = false;
let astModulesEnsuring: Promise<boolean> | null = null;

/**
 * Populate `modules` on the resident Rust state by running the AST
 * indexer in the background. Call once after the surface hydrate so
 * subsequent `resolveExportOrigin` / `resolveModule` queries can be
 * answered natively.
 */
export function ensureNativeAstModules(
  workspaceRoot: string,
  log?: Logger,
): Promise<boolean> {
  if (disabled) return Promise.resolve(false);
  if (astModulesEnsured && currentRoot === workspaceRoot) {
    return Promise.resolve(true);
  }
  if (astModulesEnsuring) return astModulesEnsuring;
  const n = getNative();
  if (!n) return Promise.resolve(false);

  astModulesEnsuring = new Promise<boolean>((resolve) => {
    setImmediate(() => {
      const started = performance.now();
      try {
        const ok = n.nativeEnsureAstModules(workspaceRoot);
        const elapsedMs = performance.now() - started;
        astModulesEnsured = ok;
        log?.(
          'info',
          `[fastpath] nativeEnsureAstModules ok=${ok} elapsed=${elapsedMs.toFixed(1)}ms`,
        );
        resolve(ok);
      } catch (err) {
        log?.(
          'warn',
          `[fastpath] nativeEnsureAstModules failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        astModulesEnsured = false;
        resolve(false);
      } finally {
        astModulesEnsuring = null;
      }
    });
  });
  return astModulesEnsuring;
}

/** Reset the AST-modules ensure flag. Call when workspace root changes. */
export function resetNativeAstModulesFlag(): void {
  astModulesEnsured = false;
  astModulesEnsuring = null;
}
