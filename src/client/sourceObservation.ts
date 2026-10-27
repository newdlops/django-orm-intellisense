import * as fs from 'fs';
import * as path from 'path';
import { normalizeSourcePath } from './sourceWatcher';
import { createNativePathWatcher, type NativeSourceBatch, type NativeSourceHandle } from './native/sourceWatcher';

export interface SourceObservationPlan {
  /** Selected config files and raw editable-root links; do not resolve the leaf. */
  configurationFiles: readonly string[];
  /** Only the selected venv's metadata directories, never source authorization. */
  sitePackages: readonly string[];
  /** Absolute owned logical names, including raw root aliases, grouped by target. */
  sourceFiles: readonly { target: string; sources: readonly string[] }[];
}

export interface SourceObservationContext {
  readonly version: 1;
  readonly configurationFiles: readonly string[];
  readonly sitePackages: readonly string[];
  readonly roots: readonly { readonly raw: string; readonly canonical: string }[];
  /** Process-local boundary captured before discovery; never a disk cache key. */
  readonly boundary?: string;
}

/** Collect leaf observations only within already authorized current roots. */
export async function collectSourceObservationPlan(
  context: SourceObservationContext,
  ignored: ReadonlySet<string>,
  isCurrent: () => boolean,
): Promise<SourceObservationPlan | undefined> {
  const byTarget = new Map<string, Set<string>>();
  const identities: Array<{ raw: string; canonical: string; dev: bigint; ino: bigint; birth: bigint }> = [];
  for (const root of context.roots) {
    if (!isCurrent()) return undefined;
    if (currentSourceTarget(root.raw) !== root.canonical) {
      throw Object.assign(new Error('Declared source-root alias changed during observation planning.'),
        {sourceConfigurationChanged: true});
    }
    let identity: fs.BigIntStats;
    try { identity = await fs.promises.stat(root.raw, {bigint: true}); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw error;
    }
    if (!identity.isDirectory() || identity.ino === 0n) continue;
    identities.push({raw: root.raw, canonical: root.canonical,
      dev: identity.dev, ino: identity.ino, birth: identity.birthtimeNs});
    const pending = [root.raw];
    while (pending.length) {
      if (!isCurrent()) return undefined;
      const directory = pending.pop()!;
      let entries: fs.Dirent[];
      try { entries = await fs.promises.readdir(directory, {withFileTypes: true}); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') continue;
        throw error;
      }
      if (!isCurrent()) return undefined;
      for (const entry of entries) {
        if (!isCurrent()) return undefined;
        if (ignored.has(entry.name)) continue;
        const child = directory + path.sep + entry.name;
        if (entry.isDirectory()) pending.push(child);
        else if (entry.isSymbolicLink() && path.extname(entry.name).toLowerCase() === '.py') {
          try {
            if (!(await fs.promises.stat(child)).isFile()) continue;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'ELOOP') throw error;
          }
          if (!isCurrent()) return undefined;
          const target = currentSourceTarget(child);
          if (!target) continue;
          let names = byTarget.get(target);
          if (!names) byTarget.set(target, names = new Set());
          names.add(child);
        }
      }
    }
  }
  for (const before of identities) {
    if (!isCurrent()) return undefined;
    let after: fs.BigIntStats;
    try { after = await fs.promises.stat(before.raw, {bigint: true}); }
    catch (error) {
      throw Object.assign(new Error('Source root disappeared during observation planning.'),
        {sourceObservationChanged: true, cause: error});
    }
    if (!isCurrent()) return undefined;
    if (currentSourceTarget(before.raw) !== before.canonical || !after.isDirectory()
        || before.dev !== after.dev || before.ino !== after.ino || before.birth !== after.birthtimeNs) {
      throw Object.assign(new Error('Source root changed during observation planning.'),
        {sourceConfigurationChanged: true});
    }
  }
  for (const [target, names] of byTarget) {
    for (const name of names) {
      if (!isCurrent()) return undefined;
      if (currentSourceTarget(name) !== target) {
        throw Object.assign(new Error('Source leaf changed during observation planning.'),
          {sourceObservationChanged: true});
      }
    }
  }
  if (!isCurrent()) return undefined;
  return {configurationFiles: [...context.configurationFiles],
    sitePackages: [...context.sitePackages],
    sourceFiles: [...byTarget].map(([target, sources]) => ({target, sources: [...sources]}))};
}

export interface SourceObservationCallbacks {
  configurationChanged(paths?: readonly string[]): void;
  /** Invalidate this owned name; the consumer must capture its current state. */
  sourceChanged(source: string): void;
  /** An uncertain batch requires a fresh owned reconciliation, not a ready claim. */
  reconcile(): void;
}

export interface SourceObservationHandle {
  dispose(): void;
  state(): {
    closed: boolean; roots: number; configurationFiles: number;
    metadataDirectories: number; sourceTargets: number; sourceAliases: number;
    pendingBytes: number; pendingEvents: number;
  };
}

/** Preserve the leaf name when a root/file link has already been retargeted. */
function observationPath(file: string): string {
  const absolute = path.isAbsolute(file) ? file : path.resolve(file);
  return path.join(normalizeSourcePath(path.dirname(absolute)), path.basename(absolute));
}

function observationDirectory(directory: string): { path?: string | null; identity: string } {
  try {
    const info = fs.statSync(directory, {bigint: true});
    const identity = [info.mode, info.dev, info.ino, info.birthtimeNs].join(':');
    if (!info.isDirectory()) return {identity: 'not-directory:' + identity};
    const resolved = normalizeSourcePath(directory);
    return {path: path.dirname(resolved) === resolved ? null : resolved,
      identity: resolved + ':' + identity};
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    return {identity: code};
  }
}

/** Exact-name fallback for a selected object whose parent is a filesystem root. */
function observationIdentity(file: string, metadata: boolean): string {
  const value = (info: fs.BigIntStats): string =>
    [info.mode, info.dev, info.ino, info.birthtimeNs,
      ...(!info.isDirectory() || metadata ? [info.size, info.mtimeNs, info.ctimeNs] : [])].join(':');
  let identity = '';
  try {
    const info = fs.lstatSync(file, {bigint: true});
    identity = value(info) + ':' + currentSourceTarget(file);
    return identity + (info.isSymbolicLink() ? ':' + value(fs.statSync(file, {bigint: true})) : '');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'ELOOP') throw error;
    return identity + ':' + code;
  }
}

/** Also retain dangling targets so deletion can invalidate a still-owned link. */
function currentSourceTarget(source: string): string | undefined {
  try {
    return fs.realpathSync.native(source);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') return undefined;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
  }
  // realpath cannot resolve a dangling parent link. Follow each existing link
  // before dot-dot, retaining the physical missing suffix for invalidation.
  const absolute = path.isAbsolute(source) ? source : process.cwd() + path.sep + source;
  let root = path.parse(absolute).root, resolved = root, links = 0;
  let pending = absolute.slice(root.length).split(path.sep);
  while (pending.length) {
    const segment = pending.shift()!;
    if (!segment || segment === '.') continue;
    if (segment === '..') { resolved = path.dirname(resolved); continue; }
    const candidate = path.join(resolved, segment);
    try {
      if (fs.lstatSync(candidate).isSymbolicLink()) {
        if (++links > 64) return undefined;
        const target = fs.readlinkSync(candidate);
        if (path.isAbsolute(target)) {root = path.parse(target).root; resolved = root;}
        pending = target.slice(path.isAbsolute(target) ? root.length : 0).split(path.sep).concat(pending);
        continue;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ELOOP') return undefined;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
    resolved = candidate;
  }
  return resolved;
}

export function sourceObservationTarget(source: string): string | undefined {
  return currentSourceTarget(source);
}

/**
 * Physical observation never grants source authority. The caller supplies a
 * source-verified plan and invalidates isCurrent synchronously when its owner,
 * session, configuration or publication generation changes.
 */
export function createSourceObservation(
  plan: SourceObservationPlan,
  boundary: string | undefined,
  isCurrent: () => boolean,
  onChange: SourceObservationCallbacks,
  reportFailure: (error: unknown) => void,
  register: typeof createNativePathWatcher = createNativePathWatcher,
): SourceObservationHandle | undefined {
  const configuration = new Set(plan.configurationFiles.map(observationPath));
  const metadata = new Set(plan.sitePackages.map(normalizeSourcePath));
  const sources = new Map<string, Set<string>>();
  for (const entry of plan.sourceFiles) {
    const target = normalizeSourcePath(entry.target);
    let names = sources.get(target);
    if (!names) sources.set(target, names = new Set());
    for (const source of entry.sources) {
      if (!path.isAbsolute(source)) throw new Error('Observed source aliases must be absolute owned names.');
      // Keep the approved logical namespace. Only physical events and targets
      // are normalized; two raw roots can intentionally name the same leaf.
      names.add(source);
    }
  }
  const sourceTargetNames = [...sources.keys()].sort();
  const selectedFiles = [...new Set([...configuration, ...sourceTargetNames])];
  const selectedDirectories = [...metadata];
  const selection = {files: selectedFiles, directories: selectedDirectories};
  const sourceDirectoryEvent = (file: string, flags: number): boolean => {
    if ((flags & 0x20000) === 0 || (flags & (0x100 | 0x200 | 0x800 | 0x20)) === 0) return false;
    const prefix = file.endsWith(path.sep) ? file : file + path.sep;
    let first = 0, last = sourceTargetNames.length;
    while (first < last) {
      const middle = (first + last) >>> 1;
      if (sourceTargetNames[middle] < prefix) first = middle + 1;
      else last = middle;
    }
    return Boolean(sourceTargetNames[first]?.startsWith(prefix));
  };
  const requested = new Map<string, Set<string>>();
  const request = (directory: string, file: string): void => {
    let files = requested.get(directory);
    if (!files) requested.set(directory, files = new Set());
    files.add(file);
  };
  for (const file of configuration) request(path.dirname(file), file);
  for (const directory of metadata) request(directory, directory);
  for (const file of sources.keys()) request(path.dirname(file), file);
  const directories = new Set<string>();
  const probes = new Map<string, { files: Set<string>; identity: string; exact: Map<string, string> }>();
  for (const [directory, files] of requested) {
    const observed = observationDirectory(directory);
    if (observed.path) directories.add(observed.path);
    else probes.set(directory, {files, identity: observed.identity,
      exact: new Map(observed.path === null
        ? [...files].map(file => [file, observationIdentity(file, metadata.has(file))]) : [])});
  }
  requested.clear();
  // Ancestor lookups keep root compaction proportional to path depth, avoiding
  // all-pairs comparisons when a project owns many outside physical targets.
  const roots = [...directories].filter(directory => {
    let parent = path.dirname(directory);
    while (parent !== directory) {
      if (directories.has(parent)) return false;
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    return true;
  }).sort();
  directories.clear();
  const covered = (directory: string): boolean => roots.some(root => {
    const relative = path.relative(root, directory);
    return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  });
  // Existing exact roots already deliver creation below them. Missing parents
  // outside those roots use exact probes instead of widening a native stream.
  for (const directory of probes.keys()) {
    const physical = currentSourceTarget(directory);
    if (physical && covered(physical)) probes.delete(directory);
  }
  const handles: NativeSourceHandle[] = [];
  let disposed = false;
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  let owns: (() => boolean) | undefined = isCurrent;
  let callbacks: SourceObservationCallbacks | undefined = onChange;
  let failure: ((error: unknown) => void) | undefined = reportFailure;
  const current = (): boolean => !disposed && Boolean(owns?.());
  const configurationEvent = (file: string, directory: boolean): boolean => {
    if (configuration.has(file) || metadata.has(file)) return true;
    if (directory && [...configuration, ...metadata].some(target => {
      const relative = path.relative(file, target);
      return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    })) return true;
    const parent = path.dirname(file), name = path.basename(file);
    if (metadata.has(parent) && (name.endsWith('.egg-link') || name.endsWith('.pth')
        || (directory && name.endsWith('.dist-info')))) return true;
    return name === 'direct_url.json' && path.basename(parent).endsWith('.dist-info')
      && metadata.has(path.dirname(parent));
  };
  const deliver = (batch: NativeSourceBatch): void => {
    if (!current()) return;
    try {
      if (batch.rescan || batch.baseChanged) {
        callbacks?.reconcile();
        return;
      }
      const invalidated = new Map<string, string>();
      const changedConfiguration = new Set<string>();
      let changedSourceDirectory = false;
      for (const event of batch.events) {
        if (!current()) return;
        const file = observationPath(event.path);
        if (configurationEvent(file, (event.flags & 0x20000) !== 0)) changedConfiguration.add(file);
        if (sourceDirectoryEvent(file, event.flags)) changedSourceDirectory = true;
        const names = sources.get(file);
        if (names) {
          for (const name of names) {
            if (currentSourceTarget(name) === file) invalidated.set(name, file);
          }
        }
      }
      // Revoke an old configuration before any same-batch old-source delivery.
      if (changedConfiguration.size && current()) callbacks?.configurationChanged([...changedConfiguration]);
      else if (changedSourceDirectory && current()) callbacks?.reconcile();
      for (const [name, target] of invalidated) {
        if (!current()) return;
        // A previous callback can retarget another alias without changing the
        // owner token. Revalidate at the actual delivery boundary as well.
        if (currentSourceTarget(name) === target) callbacks?.sourceChanged(name);
      }
    } catch (error) {
      failure?.(error);
      if (current()) callbacks?.reconcile();
    }
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = undefined;
    for (const handle of handles) handle.dispose();
    handles.length = roots.length = 0;
    configuration.clear();
    metadata.clear();
    sources.clear();
    sourceTargetNames.length = 0;
    selectedFiles.length = selectedDirectories.length = 0;
    probes.clear();
    callbacks = owns = failure = undefined;
  };
  const probe = (): void => {
    probeTimer = undefined;
    if (!current()) {dispose(); return;}
    let changed = false;
    try {
      for (const [directory, entry] of probes) {
        if (!current()) return;
        const observed = observationDirectory(directory);
        if (observed.path) {
          if (!covered(observed.path)) {
            const handle = register(observed.path, boundary, deliver, selection);
            if (!handle) {
              try { if (current()) callbacks?.reconcile(); }
              finally { dispose(); }
              return;
            }
            handles.push(handle);
            roots.push(observed.path);
          }
          probes.delete(directory);
          changed = true;
        } else {
          if (observed.identity !== entry.identity) changed = true;
          entry.identity = observed.identity;
          if (observed.path === null) {
            for (const file of entry.files) {
              const identity = observationIdentity(file, metadata.has(file));
              if (entry.exact.get(file) !== identity) changed = true;
              entry.exact.set(file, identity);
            }
          } else entry.exact.clear();
        }
      }
      // The consumer retires the old owner before its complete fresh scan.
      if (changed && current()) callbacks?.reconcile();
    } catch (error) {
      try {
        failure?.(error);
        if (current()) callbacks?.reconcile();
      } finally { dispose(); }
    } finally {
      if (!current()) dispose();
      else if (probes.size) {
        probeTimer = setTimeout(probe, 300);
        probeTimer.unref();
      }
    }
  };
  try {
    if (!current()) {
      dispose();
      return undefined;
    }
    for (const root of roots) {
      const handle = register(root, boundary, deliver, selection);
      if (!handle) {
        dispose();
        return undefined;
      }
      handles.push(handle);
      if (!current()) {
        dispose();
        return undefined;
      }
    }
    if (probes.size) {
      probeTimer = setTimeout(probe, 300);
      probeTimer.unref();
    }
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    dispose,
    state: () => ({
      closed: disposed, roots: roots.length, configurationFiles: configuration.size,
      metadataDirectories: metadata.size, sourceTargets: sources.size,
      sourceAliases: [...sources.values()].reduce((sum, names) => sum + names.size, 0),
      pendingBytes: handles.reduce((sum, handle) => sum + handle.state().pendingBytes, 0),
      pendingEvents: handles.reduce((sum, handle) => sum + handle.state().pendingEvents, 0),
    }),
  };
}
