import type { CancellationToken, Disposable } from 'vscode';

const REQUEST_ENDED = 'Provider request ended';

export interface ProviderRequestScope {
  readonly signal: AbortSignal;
  readonly cancelled: Promise<undefined>;
  dispose(): void;
}

/** Own only active requests; completed calls leave no shared Promise reactions. */
export class ProviderRequestOwner {
  private disposed = false;
  private readonly pending = new Set<() => void>();

  begin(token: CancellationToken, timeoutMs?: number): ProviderRequestScope {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let subscription: Disposable | undefined;
    let finished = false;
    let resolveCancelled!: (value: undefined) => void;
    const cancelled = new Promise<undefined>(resolve => { resolveCancelled = resolve; });
    const finish = (): void => {
      if (finished) return;
      finished = true;
      this.pending.delete(finish);
      if (timer !== undefined) clearTimeout(timer);
      subscription?.dispose();
      // This private signal only carries cancellation state. Reuse its reason
      // instead of allocating an exception stack for every completed request.
      controller.abort(REQUEST_ENDED);
      resolveCancelled(undefined);
    };
    this.pending.add(finish);
    if (this.disposed || token.isCancellationRequested) {
      finish();
    } else {
      subscription = token.onCancellationRequested(finish);
      // A token can cancel synchronously while installing its listener.
      if (finished) subscription.dispose();
      else if (timeoutMs !== undefined) timer = setTimeout(finish, timeoutMs);
    }
    return { signal: controller.signal, cancelled, dispose: finish };
  }

  dispose(): void {
    this.disposed = true;
    for (const finish of this.pending) finish();
  }
}
