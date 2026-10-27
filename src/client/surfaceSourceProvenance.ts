/** Captured by the Python producer, never synthesized by a cache writer. */
export interface SurfaceSourceProvenance {
  version: 2;
  fingerprintVersion: 2;
  membershipVersion: 1;
  root: string;
  extraRoots: string[];
  sourceFingerprint: string;
  membershipFingerprint: string;
  requestedSettingsModule: string | null;
  launchEnvironmentFingerprint: string;
  interpreter: { path: string; realPath: string; identity: string[] };
}

/** Resolved before spawning Python; owner distinguishes session/root ABA. */
export interface SurfaceCacheContext {
  owner: string;
  workspaceRoot: string;
  pythonPath: string;
  settingsModule: string | null;
  launchEnvironmentFingerprint: string;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const settings = (value: unknown): value is string | null => value === null || text(value);

export function isSurfaceSourceProvenance(value: unknown): value is SurfaceSourceProvenance {
  if (!record(value) || value.version !== 2 || value.fingerprintVersion !== 2 || value.membershipVersion !== 1
    || !text(value.root) || !Array.isArray(value.extraRoots) || !value.extraRoots.every(text)
    || !digest(value.sourceFingerprint) || !digest(value.membershipFingerprint)
    || !settings(value.requestedSettingsModule) || !digest(value.launchEnvironmentFingerprint)
    || !record(value.interpreter)) return false;
  const interpreter = value.interpreter;
  return text(interpreter.path) && text(interpreter.realPath)
    && Array.isArray(interpreter.identity) && interpreter.identity.length === 5
    && interpreter.identity.every(part => typeof part === 'string' && /^-?\d+$/.test(part));
}

export function isSurfaceCacheContext(value: unknown): value is SurfaceCacheContext {
  return record(value) && text(value.owner) && text(value.workspaceRoot)
    && text(value.pythonPath) && settings(value.settingsModule) && digest(value.launchEnvironmentFingerprint);
}
