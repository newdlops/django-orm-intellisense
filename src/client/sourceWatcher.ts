import * as fs from 'fs';
import * as path from 'path';

const NO_IGNORED_SEGMENTS: ReadonlySet<string> = new Set<string>();

/** Find Python sources already present when a directory appears in a watched root. */
export async function pythonFilesBelowDirectory(directory: string, ignored: ReadonlySet<string>, strict = false): Promise<string[]> {
  const pending = [normalizeSourcePath(directory)];
  const files: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (strict) throw error;
      // A create event can race with a rename or deletion. Later file events
      // will enqueue surviving files, so a stale directory scan is harmless.
      continue;
    }
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.py') files.push(child);
      else if (entry.isSymbolicLink() && path.extname(entry.name).toLowerCase() === '.py') {
        try {
          if ((await fs.promises.stat(child)).isFile()) files.push(child);
        } catch (error) {
          // A broken or looping leaf can still revoke an indexed module.
          // Do not recurse through directory links or open other file kinds.
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ELOOP') files.push(child);
        else if (strict) throw error;
        }
      }
    }
  }
  return files;
}

/** A complete restored-root scan is usable only by the same current owner. */
export async function currentPythonFilesBelowRoot(
  directory: string, ignored: ReadonlySet<string>, isCurrent: () => boolean,
  scan: typeof pythonFilesBelowDirectory = pythonFilesBelowDirectory,
): Promise<string[] | undefined> {
  if (!isCurrent()) return undefined;
  const readRoot = async (): Promise<fs.BigIntStats | undefined> => {
    try { return await fs.promises.stat(directory, { bigint: true }); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
      throw error;
    }
  };
  const before = await readRoot();
  if (!before?.isDirectory() || before.ino === 0n || !isCurrent()) return undefined;
  const files = await scan(directory, ignored, true);
  const after = await readRoot();
  if (!isCurrent() || !after?.isDirectory() || before.dev !== after.dev
      || before.ino !== after.ino || before.birthtimeNs !== after.birthtimeNs) return undefined;
  return files;
}

function absoluteSourcePath(filePath: string): string {
  // POSIX must follow a symlink before processing its following '..'. Keep
  // that order for realpath and for the existing missing-parent fallback.
  return path.sep === '/' && /(?:^|\/)\.\.(?:\/|$)/.test(filePath)
    ? (path.isAbsolute(filePath) ? filePath : `${process.cwd()}/${filePath}`)
    : path.resolve(filePath);
}

function normalizeAbsoluteSourcePath(absolute: string): string {
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    // A deletion event still needs to match its source root through aliases.
    let ancestor = path.dirname(absolute);
    while (true) {
      try {
        return path.join(fs.realpathSync.native(ancestor), path.relative(ancestor, absolute));
      } catch {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) return absolute;
        ancestor = parent;
      }
    }
  }
}

export function normalizeSourcePath(filePath: string): string {
  return normalizeAbsoluteSourcePath(absoluteSourcePath(filePath));
}

/** Prefer an owned file-link namespace, retaining canonical aliases into roots. */
export function normalizeSourceEventPath(filePath: string, roots: readonly string[]): string {
  const absolute = absoluteSourcePath(filePath);
  const normalized = normalizeAbsoluteSourcePath(absolute);
  if (normalized === absolute) return normalized;
  try {
    if (fs.lstatSync(absolute).isSymbolicLink() && !fs.statSync(absolute).isDirectory()) {
      const namespace = path.join(normalizeSourcePath(path.dirname(absolute)), path.basename(absolute));
      if (isWatchedSourcePath(roots, namespace, NO_IGNORED_SEGMENTS)) return namespace;
    }
  } catch {
    // Missing paths keep normalizeSourcePath's nearest-parent namespace.
  }
  return normalized;
}

export function sourceWatcherRoots(workspaceRoot: string, editableRoots: readonly string[]): string[] {
  return [...new Set([workspaceRoot, ...editableRoots].map(normalizeSourcePath))].sort();
}

export function isWatchedSourcePath(roots: readonly string[], filePath: string, ignored: ReadonlySet<string>): boolean {
  return roots.some(root => {
    // POSIX roots and normalized event paths can use a boundary-aware prefix
    // check without allocating a relative path. Keep path.relative for Windows
    // and lexical paths containing dot segments, where platform semantics matter.
    if (path.sep === '/' && path.posix.isAbsolute(root) && path.posix.isAbsolute(filePath)
      && !root.split('/').some(segment => segment === '.' || segment === '..')
      && !filePath.split('/').some(segment => segment === '.' || segment === '..')) {
      if (filePath === root) return false;
      const prefix = root.endsWith('/') ? root : `${root}/`;
      if (!filePath.startsWith(prefix)) return false;
      return !filePath.slice(prefix.length).split('/').some(segment => ignored.has(segment));
    }
    const relative = path.relative(root, filePath);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative) && !relative.split(path.sep).some(segment => ignored.has(segment));
  });
}

/** Keep queued events only while they remain owned by the same workspace. */
export function retainPendingSourceEvents(
  previousWorkspaceRoot: string | undefined,
  nextWorkspaceRoot: string | undefined,
  nextRoots: readonly string[],
  files: Set<string>,
  deletedPaths: Set<string>,
  ignored: ReadonlySet<string>,
): void {
  if (!nextWorkspaceRoot || previousWorkspaceRoot !== nextWorkspaceRoot) {
    files.clear();
    deletedPaths.clear();
    return;
  }
  for (const file of files) {
    if (!isWatchedSourcePath(nextRoots, file, ignored)) files.delete(file);
  }
  for (const deletedPath of deletedPaths) {
    if (!nextRoots.includes(deletedPath) && !isWatchedSourcePath(nextRoots, deletedPath, ignored)) {
      deletedPaths.delete(deletedPath);
    }
  }
}

/** Keep scans of source directories and parents of separately watched roots. */
export function shouldScanSourceDirectory(
  roots: readonly string[], directory: string, ignored: ReadonlySet<string>,
): boolean {
  if (isWatchedSourcePath(roots, directory, ignored)) return true;
  return roots.some(root => {
    const relative = path.relative(directory, root);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
  });
}
