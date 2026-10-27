/** Debounce cache hints and retain only the latest request behind an active save. */
export class SurfaceCacheWriter<T> {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: { value: T; ready: boolean } | undefined;
  private writing = false;

  constructor(
    private readonly write: (value: T) => Promise<void>,
    private readonly delayMs = 200,
  ) {}

  schedule(value: T): void {
    this.pending = { value, ready: false };
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.pending) this.pending.ready = true;
      void this.flush();
    }, this.delayMs);
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
  }

  private async flush(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.pending?.ready) {
        const request = this.pending;
        this.pending = undefined;
        try {
          await this.write(request.value);
        } catch {
          // Cache hints must not poison later saves after a failed write.
        }
      }
    } finally {
      this.writing = false;
    }
  }
}
