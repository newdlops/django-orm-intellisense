import { SurfaceSnapshotEncoder } from './surfaceSnapshotEncoder';

export type SurfaceUpdateMethod = 'django/updateSurfaceIndex' | 'django/updateSurfaceIndexDelta' | 'django/clearSurfaceIndex';

interface ContextDelivery {
  owner: object;
  key: string;
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
  send?: (signal: AbortSignal) => Promise<void>;
}

/** One context request and the latest owner; superseded callers release their snapshots. */
export class SurfaceCacheContextDelivery {
  private current?: ContextDelivery;
  private pending?: ContextDelivery;
  private active?: AbortController;
  private disposed = false;

  deliver(owner: object, key: string, send: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.disposed) {
      const rejected = Promise.reject<void>(new Error('Surface cache context delivery is disposed.'));
      void rejected.catch(() => {});
      return rejected;
    }
    if (this.current?.owner === owner && this.current.key === key) return this.current.promise;
    this.current?.reject(new Error('Surface cache context belongs to an inactive language server session.'));
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    // State hooks need not await delivery. A surface publication can still
    // observe the same rejection and recover using its current owner.
    void promise.catch(() => {});
    const delivery = { owner, key, promise, resolve, reject, send };
    this.current = delivery;
    this.pending = delivery;
    void this.run();
    return promise;
  }

  dispose(): void {
    this.disposed = true;
    this.current?.reject(new Error('Surface cache context delivery is disposed.'));
    this.current = undefined;
    this.pending = undefined;
    this.active?.abort();
  }

  private async run(): Promise<void> {
    if (this.active) return;
    while (this.pending && !this.disposed) {
      const delivery = this.pending;
      this.pending = undefined;
      const controller = new AbortController();
      this.active = controller;
      let abort!: () => void;
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(new Error('Surface cache context delivery is disposed.'));
        controller.signal.addEventListener('abort', abort, { once: true });
      });
      try {
        const operation = delivery.send!(controller.signal);
        delivery.send = undefined;
        await Promise.race([operation, cancelled]);
        if (this.current === delivery && !this.disposed) delivery.resolve();
      } catch (error) {
        delivery.reject(error);
        if (this.current === delivery) this.current = undefined;
      } finally {
        delivery.send = undefined;
        controller.signal.removeEventListener('abort', abort);
        this.active = undefined;
      }
    }
  }
}

interface SurfacePublisherOptions {
  currentScope(): string | undefined;
  snapshot(): unknown;
  isRetired?(): boolean;
  send(method: SurfaceUpdateMethod, params: unknown): Promise<{ applied: boolean }>;
  reportFailure(error: unknown): void;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  snapshotTransportEnabled?(): boolean;
}

/** Serialize acknowledged updates, recovering lost deltas from current state. */
export class SurfacePublisher {
  private fullPending = true;
  private revision = 0;
  private active: Promise<boolean> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private disposed = false;
  private readonly snapshotEncoder = new SurfaceSnapshotEncoder();
  private transportScope?: string;

  constructor(private readonly options: SurfacePublisherOptions) {}

  requestFull(): void {
    if (this.disposed) return;
    this.fullPending = true;
    this.revision++;
    this.schedule(0);
  }

  async publishDelta(params: unknown, scope: string): Promise<boolean> {
    while (this.active) await this.active;
    if (this.disposed) return false;
    if (scope !== this.options.currentScope()) {
      this.requestFull();
      return false;
    }
    // Saves can continue while transport is unavailable. One pending full
    // snapshot covers their latest state without retaining failed payloads.
    if (this.fullPending && this.retryTimer && this.failures > 0) return false;
    if (this.fullPending) return this.publishFull();
    return this.send('django/updateSurfaceIndexDelta', params, scope);
  }

  dispose(): void {
    this.disposed = true;
    this.snapshotEncoder.reset();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private schedule(delayMs: number): void {
    if (this.disposed || this.active || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.publishFull();
    }, delayMs);
  }

  private publishFull(): Promise<boolean> {
    if (this.disposed || this.active || !this.fullPending) return Promise.resolve(false);
    const scope = this.options.currentScope();
    // Startup/stop needs a new state event, not a polling loop.
    if (scope === undefined) return Promise.resolve(false);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    return this.options.isRetired?.()
      ? this.send('django/clearSurfaceIndex', {}, scope)
      : this.send('django/updateSurfaceIndex', this.options.snapshot(), scope);
  }

  private send(method: SurfaceUpdateMethod, params: unknown, scope: string): Promise<boolean> {
    const revision = this.revision;
    const task = Promise.resolve().then(async () => {
      // The queued microtask may have crossed a process/workspace handoff.
      if (this.disposed || scope !== this.options.currentScope()) {
        this.fullPending = true;
        return false;
      }
      try {
        if (scope !== this.transportScope) {
          this.snapshotEncoder.reset();
          this.transportScope = scope;
        }
        const prepared = method === 'django/updateSurfaceIndex' && this.options.snapshotTransportEnabled?.()
          ? this.snapshotEncoder.prepare(params) : undefined;
        if (method === 'django/clearSurfaceIndex' || (method === 'django/updateSurfaceIndex' && !prepared)) this.snapshotEncoder.reset();
        const result = await this.options.send(method, prepared?.payload ?? params);
        if (!result.applied) throw new Error('Language server did not apply the surface update.');
        if (this.disposed) return false;
        if (scope !== this.options.currentScope()) {
          this.snapshotEncoder.reset();
          this.fullPending = true;
          return false;
        }
        if (prepared && !this.snapshotEncoder.commit(prepared)) throw new Error('Surface transport ownership changed before acknowledgement.');
        this.failures = 0;
        if (method !== 'django/updateSurfaceIndexDelta' && revision === this.revision) this.fullPending = false;
        return true;
      } catch (error) {
        this.snapshotEncoder.reset();
        if (!this.disposed) {
          this.fullPending = true;
          if (scope !== this.options.currentScope()) return false;
          this.failures++;
          this.options.reportFailure(error);
        }
        return false;
      }
    });
    this.active = task;
    void task.then(() => {
      if (this.active === task) this.active = undefined;
      if (this.disposed || !this.fullPending) return;
      const base = this.options.retryDelayMs ?? 300;
      const maximum = this.options.maxRetryDelayMs ?? 5000;
      const delay = this.failures > 0 ? Math.min(maximum, base * 2 ** Math.min(this.failures - 1, 10)) : 0;
      this.schedule(delay);
    });
    return task;
  }
}
