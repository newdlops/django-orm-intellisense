import type { SurfaceCacheContext } from '../client/surfaceSourceProvenance';

/** One active read plus the latest context; no old read can publish after an
 * authoritative update, retirement, or a new session with the same root. */
export class SurfaceCachePrewarmer<T> {
  private revision = 0;
  private context: SurfaceCacheContext | null = null;
  private pending?: { context: SurfaceCacheContext; revision: number };
  private running = false;

  constructor(private readonly options: {
    load(context: SurfaceCacheContext): Promise<T | null>;
    hasResident(): boolean;
    apply(value: T): void;
  }) {}

  update(context: SurfaceCacheContext | null): void {
    if (JSON.stringify(context) === JSON.stringify(this.context)) return;
    this.context = context;
    this.invalidate();
    if (context && !this.options.hasResident()) {
      this.pending = { context, revision: this.revision };
      void this.run();
    }
  }

  invalidate(): void {
    this.revision++;
    this.pending = undefined;
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending) {
        const request = this.pending;
        this.pending = undefined;
        try {
          const value = await this.options.load(request.context);
          if (value !== null && request.revision === this.revision && !this.options.hasResident()) {
            this.options.apply(value);
          }
        } catch {
          // Failed/unsupported cache validation falls back to the producer.
        }
      }
    } finally {
      this.running = false;
    }
  }
}
