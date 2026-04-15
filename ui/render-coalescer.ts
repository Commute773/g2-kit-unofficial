// Tiny async render coalescer.
//
// Motivation: the bridge pushes screens as they arrive from the backend, but
// the G2 firmware can only handle one render at a time (concurrent Cmd=7 /
// Cmd=3 writes jam the BLE write channel and leave both hanging). So we
// serialise renders and, crucially, *coalesce* them — if a newer screen
// arrives while one is being rendered, we drop any intermediate screens and
// render only the latest one after the current render finishes.
//
// This is a one-deep queue on purpose. Catching up to the latest state
// matters more than preserving every intermediate frame.

export type RenderCoalescerOpts<T> = {
  render: (item: T) => Promise<void>;
  onError?: (err: unknown) => void;
};

export class RenderCoalescer<T> {
  private pending: Promise<void> | null = null;
  private queued: T | null = null;
  private readonly render: (item: T) => Promise<void>;
  private readonly onError: (err: unknown) => void;

  constructor(opts: RenderCoalescerOpts<T>) {
    this.render = opts.render;
    this.onError = opts.onError ?? ((e) => console.error("render error", e));
  }

  /**
   * Schedule `item` for rendering. If a render is already in flight, this
   * queues behind it and may be replaced by a later `schedule` before it
   * runs. Returns immediately.
   */
  schedule(item: T): void {
    this.queued = item;
    if (this.pending) return;
    this.pending = (async () => {
      while (this.queued) {
        const next = this.queued;
        this.queued = null;
        try {
          await this.render(next);
        } catch (e) {
          this.onError(e);
        }
      }
      this.pending = null;
    })();
  }
}
