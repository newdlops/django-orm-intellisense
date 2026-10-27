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

/** Filesystem state only; metadata requires a separate producer/source binding. */
export interface PythonSourceFingerprintV2 {
  fingerprintVersion: 2;
  root: string;
  fingerprint: string;
  fileCount: number;
}

export interface PythonSourceProof extends PythonSourceFingerprintV2 {
  membershipVersion: 1;
  membershipFingerprint: string;
}

export interface PythonSourceSnapshotV2 {
  fingerprintVersion: 2;
  root: string;
  fingerprint: string;
  entries: Array<{
    relativePath: string;
    /** Exact decimal strings, including values outside JS integer precision. */
    size: string;
    mtimeNs: string;
    ctimeNs: string;
    device: string;
    inode: string;
    fingerprint: string;
  }>;
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
  saveCacheBlobChunksAsync?(path: string, metadata: Buffer, chunks: Buffer[]): Promise<void>;
  hello(name: string): string;
  nativeVersion(): string;
  saveCacheBlob(path: string, metadata: Buffer, payload: Buffer): void;
  loadCacheBlob(path: string): CacheHit | null;
  workspaceCacheDir(cacheRoot: string, workspaceRoot: string): string;
  cacheSchemaVersion(): number;
  snapshotPythonSources(root: string, extraRoots?: string[]): PythonSourceSnapshot;
  /** Throws on unsupported platforms/incomplete inventories; never use the
   * legacy API as a substitute when this optional v2 capability is absent. */
  snapshotPythonSourcesV2?(root: string, extraRoots?: string[]): PythonSourceSnapshotV2;
  fingerprintPythonSourcesV2Async?(root: string, extraRoots?: string[]): Promise<PythonSourceFingerprintV2>;
  fingerprintPythonSourceProofAsync?(root: string, extraRoots?: string[]): Promise<PythonSourceProof>;
  fileFingerprint(relativePath: string, size: number, mtimeNs: string): string;
  buildStaticIndexJson(root: string, files: string[]): Buffer;
  parseModuleJson(root: string, filePath: string): Buffer | null;
  buildSurfaceIndexJson(root: string): Buffer;

  // Fast-path resident state for analysisDaemon routing.
  nativeInit(root: string, forceRebuild?: boolean): NativeInitResult;
  nativeInitFromSurface(root: string, surfaceBytes: Buffer): NativeInitResult;
  nativeInitFromSurfaceAsync?(root: string, surfaceBytes: Buffer): Promise<NativeInitResult | null>;
  nativeInitFromSurfaceChunksAsync?(root: string, chunks: Buffer[]): Promise<NativeInitResult | null>;
  nativeDrop(): void;
  nativeDropAsync?(): Promise<void>;
  nativeStateInfo(): NativeStateInfo;
  nativeLiveStateCount?(): number;
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
  nativeListLookupPathCompletions(
    baseModelLabel: string,
    prefix: string,
    method: string,
  ): Buffer | null;
  nativeListOrmMemberCompletions(
    modelLabel: string,
    receiverKind: string,
    prefix?: string | null,
    managerName?: string | null,
  ): Buffer | null;
  nativeResolveExportOrigin(
    moduleName: string,
    symbol: string,
  ): Buffer | null;
  nativeResolveModule(moduleName: string): Buffer | null;
  // Async napi task — resolves to whether the AST modules were ensured.
  nativeEnsureAstModules(root: string): Promise<boolean>;
  nativeInvalidateAstModules?(): void;
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
