import * as path from 'path';
import * as fs from 'fs';

export interface CacheHit {
  metadata: Buffer;
  payload: Buffer;
}

export interface PythonSourceEntry {
  relativePath: string;
  size: number;
  /** Stringified i128 (nanoseconds since epoch). JS numbers can't hold
   *  full precision, so callers compare as strings. */
  mtimeNs: string;
  fingerprint: string;
}

export interface PythonSourceSnapshot {
  root: string;
  fingerprint: string;
  entries: PythonSourceEntry[];
  /** Array of [directory_path, directory_fingerprint] tuples. */
  directoryFingerprints: Array<[string, string]>;
}

export interface NativeInitResult {
  root: string;
  modelCount: number;
  fieldCount: number;
  edgeCount: number;
  elapsedMs: number;
  rebuilt: boolean;
  source?: string;
  parsedFileCount?: number;
  parseFailureCount?: number;
  directModelCount?: number;
  expandedModelCount?: number;
}

export interface NativeStateInfo {
  initialized: boolean;
  root: string | null;
  modelCount: number;
  fieldCount: number;
  /** Stringified epoch ms at which the state was last built. */
  builtAtMs: string;
}

export interface NativeBindings {
  hello(name: string): string;
  nativeVersion(): string;
  saveCacheBlob(path: string, metadata: Buffer, payload: Buffer): void;
  loadCacheBlob(path: string): CacheHit | null;
  workspaceCacheDir(cacheRoot: string, workspaceRoot: string): string;
  cacheSchemaVersion(): number;
  snapshotPythonSources(root: string, extraRoots?: string[]): PythonSourceSnapshot;
  fileFingerprint(relativePath: string, size: number, mtimeNs: string): string;
  buildStaticIndexJson(root: string, files: string[]): Buffer;
  parseModuleJson(root: string, filePath: string): Buffer | null;
  buildSurfaceIndexJson(root: string): Buffer;

  // Fast-path resident state for analysisDaemon routing.
  nativeInit(root: string, forceRebuild?: boolean): NativeInitResult;
  nativeInitFromSurface(root: string, surfaceBytes: Buffer): NativeInitResult;
  nativeDrop(): void;
  nativeStateInfo(): NativeStateInfo;
  nativeResolveRelationTarget(value: string): Buffer | null;
  nativeListRelationTargets(prefix?: string | null): Buffer | null;
  nativeResolveLookupPath(
    baseModelLabel: string,
    value: string,
    method: string,
  ): Buffer | null;
  nativeResolveOrmMember(
    modelLabel: string,
    receiverKind: string,
    name: string,
    managerName?: string | null,
  ): Buffer | null;
}

let cached: NativeBindings | undefined;
let loadError: Error | undefined;

function currentTriple(): string {
  const { platform, arch } = process;
  if (platform === 'darwin') {
    if (arch === 'arm64') return 'darwin-arm64';
    if (arch === 'x64') return 'darwin-x64';
  } else if (platform === 'linux') {
    if (arch === 'x64') return 'linux-x64-gnu';
    if (arch === 'arm64') return 'linux-arm64-gnu';
  } else if (platform === 'win32') {
    if (arch === 'x64') return 'win32-x64-msvc';
  }
  throw new Error(`unsupported platform for native addon: ${platform}-${arch}`);
}

function candidatePaths(triple: string): string[] {
  // Both compiled (out/client/native) and ts-node (src/client/native) sit
  // three levels below the extension root where native/ lives.
  const fromCompiledOrSrc = path.join(__dirname, '..', '..', '..', 'native', triple, 'index.node');
  return [fromCompiledOrSrc];
}

export function loadNative(): NativeBindings {
  if (cached) return cached;
  if (loadError) throw loadError;

  const triple = currentTriple();
  const candidates = candidatePaths(triple);
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const mod = require(p);
      cached = mod as NativeBindings;
      return cached;
    }
  }

  loadError = new Error(
    `native addon not found for ${triple}. searched:\n  ${candidates.join('\n  ')}`,
  );
  throw loadError;
}

export function tryLoadNative(): NativeBindings | undefined {
  try {
    return loadNative();
  } catch {
    return undefined;
  }
}
