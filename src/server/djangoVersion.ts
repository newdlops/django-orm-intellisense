const FEATURE_VERSIONS: Record<string, readonly [number, number]> = {
  fetch_mode: [6, 1],
  totally_ordered: [6, 1],
};

export function djangoBuiltinAvailable(name: string, version: string | undefined): boolean {
  const minimum = FEATURE_VERSIONS[name];
  if (!minimum) return true;
  const parts = version?.match(/^(\d+)(?:\.(\d+))?/);
  if (!parts) return false;
  const major = Number(parts[1]);
  const minor = Number(parts[2] ?? 0);
  return major > minimum[0] || (major === minimum[0] && minor >= minimum[1]);
}
