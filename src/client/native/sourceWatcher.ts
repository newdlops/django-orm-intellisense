import * as path from 'path';

export interface NativeSourceEvent { path: string; flags: number; id: string }
export interface NativeSourceBatch {
  events: readonly NativeSourceEvent[];
  rescan: boolean;
  baseChanged: boolean;
  historyDone: boolean;
}
export interface NativeSourceHandle {
  dispose(): void;
  state(): { closed: boolean; pendingBytes: number; pendingEvents: number;
    capacityBytes: number; capacityEvents: number; rescan: boolean };
}
/** Physical hints only; source authorization remains with the current owner. */
export interface NativePathSelection {
  readonly files: readonly string[];
  readonly directories: readonly string[];
}
export interface NativeSourceBindings {
  watermark(): string;
  start(root: string, watermark: string | null, ignored: readonly string[],
    callback: (batch: NativeSourceBatch) => void, includeNonPython?: boolean,
    selection?: NativePathSelection): NativeSourceHandle;
  liveStreams(): number;
  pathObservationVersion?(): number;
  pathSelectionVersion?(): number;
}
export interface NativeSourceCallbacks {
  create(file: string): void;
  change(file: string): void;
  delete(file: string): void;
  rootCreate(file: string): void;
  rootDelete(file: string): void;
  rescan(baseChanged: boolean): void;
}

let bindings: NativeSourceBindings | undefined;
let unavailable = false;

export function tryLoadNativeSourceWatcher(): NativeSourceBindings | undefined {
  if (bindings || unavailable) return bindings;
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
    unavailable = true;
    return undefined;
  }
  try {
    const file = path.join(__dirname, '..', '..', '..', 'native', `darwin-${process.arch}`, 'source-watcher.node');
    const loaded = require(file) as NativeSourceBindings;
    if (typeof loaded.start !== 'function' || typeof loaded.watermark !== 'function'
      || typeof loaded.liveStreams !== 'function') throw new Error('Invalid native source watcher module.');
    bindings = loaded;
  } catch {
    unavailable = true;
  }
  return bindings;
}

/** Capture before revoking an owner; never persist or restore this process-local boundary. */
export function captureNativeSourceBoundary(): string | undefined {
  const value = tryLoadNativeSourceWatcher()?.watermark();
  return value && /^[1-9][0-9]*$/.test(value) ? value : undefined;
}

/** The returned handle has forward observation registered, not a fresh metadata proof. */
export function createNativeSourceWatcher(
  root: string,
  boundary: string | undefined,
  ignored: ReadonlySet<string>,
  callbacks: NativeSourceCallbacks,
  reportFailure: (error: unknown) => void,
): NativeSourceHandle | undefined {
  const native = tryLoadNativeSourceWatcher();
  if (!native) return undefined;
  let disposed = false;
  const handle = native.start(root, boundary ?? null, [...ignored], batch => {
    if (disposed) return;
    try {
      if (batch.rescan) {
        callbacks.rescan(batch.baseChanged);
        return;
      }
      for (const event of batch.events) {
        if (disposed) break;
        const removed = (event.flags & 0x200) !== 0;
        const renamed = (event.flags & 0x800) !== 0;
        const created = (event.flags & 0x100) !== 0;
        if (event.path === root) {
          // A remove/create ABA can arrive as one coalesced event. Recover the
          // current source even when the pathname already exists again.
          if (removed || renamed) callbacks.rootDelete(root);
          if (created || removed || renamed) callbacks.rootCreate(root);
          continue;
        }
        if (removed || renamed) callbacks.delete(event.path);
        if (disposed) break;
        if (created || renamed || (event.flags & 0x20000) !== 0) callbacks.create(event.path);
        else if (!removed) callbacks.change(event.path);
      }
    } catch (error) {
      reportFailure(error);
      if (!disposed) callbacks.rescan(false);
    }
  });
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      handle.dispose();
    },
    state: () => handle.state(),
  };
}

/** Observe physical paths only. Callers must filter events to current owned names. */
export function createNativePathWatcher(
  root: string,
  boundary: string | undefined,
  callback: (batch: NativeSourceBatch) => void,
  selection?: NativePathSelection,
): NativeSourceHandle | undefined {
  const native = tryLoadNativeSourceWatcher();
  // Older binaries ignore additional arguments. Never report full-path coverage
  // unless the actual loaded module explicitly supports this observation mode.
  if (!native || native.pathObservationVersion?.() !== 1) return undefined;
  let disposed = false;
  const deliver = (batch: NativeSourceBatch): void => {
    if (!disposed) callback(batch);
  };
  // Older physical observers retain their complete unfiltered behavior.
  // Only the explicit optional capability permits filtering before the queue.
  const handle = selection && native.pathSelectionVersion?.() === 1
    ? native.start(root, boundary ?? null, [], deliver, true, selection)
    : native.start(root, boundary ?? null, [], deliver, true);
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      handle.dispose();
    },
    state: () => handle.state(),
  };
}
