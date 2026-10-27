/** Keep source-refresh replay within each original request's absolute budget. */
export class SourceConfigurationRequests {
  private revision = 0;
  private pending?: { promise: Promise<unknown>; queued: boolean };
  private readonly active = new Set<Promise<unknown>>();
  private logicalRequests = 0;
  private readonly abortWaiters = new Map<AbortSignal, { callbacks: Set<() => void>; abort: () => void }>();
  private readonly promiseWaiters = new Map<Promise<unknown>, {
    callbacks: Set<{resolve: (value: unknown) => void; reject: (error: unknown) => void}>;
  }>();

  private watchPromise<T>(
    promise: Promise<T>, resolve: (value: T) => void, reject: (error: unknown) => void,
  ): () => void {
    let group = this.promiseWaiters.get(promise);
    if (!group) {
      const callbacks = new Set<{resolve: (value: unknown) => void; reject: (error: unknown) => void}>();
      group = {callbacks};
      this.promiseWaiters.set(promise, group);
      const settle = (value: unknown, failed: boolean): void => {
        if (this.promiseWaiters.get(promise)?.callbacks === callbacks) this.promiseWaiters.delete(promise);
        for (const waiting of [...callbacks]) {
          if (failed) waiting.reject(value);
          else waiting.resolve(value);
        }
        callbacks.clear();
      };
      promise.then(value => settle(value, false), error => settle(error, true));
    }
    const callback = {resolve: (value: unknown) => resolve(value as T), reject};
    group.callbacks.add(callback);
    const registered = group;
    return () => {registered.callbacks.delete(callback);};
  }

  private watchAbort(signal: AbortSignal, callback: () => void): () => void {
    let group = this.abortWaiters.get(signal);
    if (!group) {
      const callbacks = new Set<() => void>();
      const abort = (): void => {for (const pending of [...callbacks]) pending();};
      group = {callbacks, abort};
      this.abortWaiters.set(signal, group);
      signal.addEventListener('abort', abort, {once: true});
    }
    group.callbacks.add(callback);
    const registered = group;
    return () => {
      registered.callbacks.delete(callback);
      if (registered.callbacks.size === 0) {
        signal.removeEventListener('abort', registered.abort);
        if (this.abortWaiters.get(signal) === registered) this.abortWaiters.delete(signal);
      }
    };
  }

  get refreshing(): boolean { return this.pending !== undefined; }

  async waitForCurrent(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const pending = this.pending;
    if (pending) await this.within(pending.promise, performance.now() + timeoutMs, 'Source configuration refresh', signal);
  }

  reset(): void {
    this.revision++;
    this.pending = undefined;
  }

  private within<T>(promise: Promise<T>, deadline: number, method: string, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopAbort: (() => void) | undefined;
      let stopPromise: (() => void) | undefined;
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        stopAbort?.();
        stopAbort = undefined;
        stopPromise?.();
        stopPromise = undefined;
      };
      const abort = (): void => { cleanup(); reject(new Error('Aborted: ' + method)); };
      if (signal?.aborted) { abort(); return; }
      const remaining = deadline - performance.now();
      if (remaining <= 0) { reject(new Error('Request "' + method + '" timed out.')); return; }
      timer = setTimeout(() => { cleanup(); reject(new Error('Request "' + method + '" timed out.')); }, remaining);
      if (signal) stopAbort = this.watchAbort(signal, abort);
      stopPromise = this.watchPromise(promise,
        value => {cleanup(); resolve(value);}, error => {cleanup(); reject(error);});
    });
  }

  request<T>(
    method: string,
    timeoutMs: number,
    send: (remainingMs: number) => Promise<T>,
    ownsSession: () => boolean,
    signal?: AbortSignal,
  ): Promise<T> {
    if (method !== 'initialize' && this.logicalRequests >= 64) {
      return Promise.reject(new Error('Pending request queue full (64). Dropping ' + method + '.'));
    }
    const deadline = performance.now() + timeoutMs;
    const replay = !['initialize', 'reindexFile', 'reindexSourceRoot',
      'reindexSourceDirectory', 'resyncSurfaceSnapshot'].includes(method);
    this.logicalRequests++;
    const attempt = async (): Promise<T> => {
      if (signal?.aborted) throw new Error('Aborted: ' + method);
      const pending = this.pending;
      if (pending && method !== 'initialize') await this.within(pending.promise, deadline, method, signal);
      if (!ownsSession()) throw new Error('Request belongs to an inactive daemon session.');
      if (signal?.aborted) throw new Error('Aborted: ' + method);
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error('Request "' + method + '" timed out.');
      const revision = this.revision;
      const raw = send(remaining);
      this.active.add(raw);
      raw.then(() => this.active.delete(raw), () => this.active.delete(raw));
      try {
        const value = await raw;
        if (replay && revision !== this.revision) {
          if (!ownsSession()) throw new Error('Request belongs to an inactive daemon session.');
          return attempt();
        }
        return value;
      } catch (error) {
        if (replay && revision !== this.revision && ownsSession()
            && performance.now() < deadline && !signal?.aborted) return attempt();
        throw error;
      }
    };
    const promise = attempt();
    promise.then(() => {this.logicalRequests--;}, () => {this.logicalRequests--;});
    return promise;
  }

  refresh<T>(
    timeoutMs: number,
    invalidate: () => void,
    run: (remainingMs: number) => Promise<T>,
    adopt: (value: T) => T,
  ): Promise<T> {
    if (this.pending) {
      this.pending.queued = true;
      this.revision++;
      return this.pending.promise as Promise<T>;
    }
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
    const pending = {promise, queued: false};
    const deadline = performance.now() + timeoutMs;
    this.pending = pending;
    this.revision++;
    const revision = this.revision;
    const work = async (): Promise<T> => {
      invalidate();
      await this.within(Promise.allSettled([...this.active]), deadline, 'Source configuration refresh');
      let value!: T;
      do {
        pending.queued = false;
        if (this.pending !== pending || this.revision < revision) {
          throw new Error('Source configuration refresh belongs to an inactive daemon session.');
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Error('Request "Source configuration refresh" timed out.');
        value = await run(remaining);
      } while (pending.queued);
      if (this.pending !== pending) throw new Error('Source configuration refresh belongs to an inactive daemon session.');
      return adopt(value);
    };
    void work().then(value => {
      if (this.pending === pending) this.pending = undefined;
      resolve(value);
    }, error => {
      if (this.pending === pending) this.pending = undefined;
      reject(error);
    });
    return promise;
  }
}
