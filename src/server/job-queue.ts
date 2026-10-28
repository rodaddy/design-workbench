import type { GenerationJob, GenerationJobStore } from "./jobs";

/**
 * Bounded in-process job runner.
 *
 * Local agent runs are expensive and CPU/IO heavy, so concurrency is capped
 * rather than fanning out across every queued cell at once. The queue only
 * schedules; the supplied executor owns the actual generation work and the
 * store owns state, which keeps this loop small enough to reason about.
 */
export interface GenerationJobExecutor {
  (job: GenerationJob): Promise<{ artifactPath: string; variantId?: string }>;
}

export interface GenerationQueueOptions {
  /** Maximum simultaneous local agent runs. */
  concurrency?: number;
  /** Notified on every terminal transition; used for logging and tests. */
  onSettled?: (job: GenerationJob) => void;
}

export class GenerationQueue {
  private readonly concurrency: number;
  private readonly onSettled: (job: GenerationJob) => void;
  private active = 0;
  private draining = false;
  private stopped = false;
  private idleWaiters: (() => void)[] = [];

  constructor(
    private readonly store: GenerationJobStore,
    private readonly execute: GenerationJobExecutor,
    options: GenerationQueueOptions = {},
  ) {
    this.concurrency = Math.max(1, options.concurrency ?? 1);
    this.onSettled = options.onSettled ?? (() => {});
  }

  /** Ask the queue to pick up newly enqueued work. Safe to call repeatedly. */
  wake(): void {
    if (this.stopped) return;
    void this.drain();
  }

  /** Stop claiming new work. In-flight jobs are allowed to finish. */
  stop(): void {
    this.stopped = true;
  }

  get activeCount(): number {
    return this.active;
  }

  /**
   * Resolve once no job is in flight and nothing more can be claimed. Idleness
   * means "the queue is drained", not merely "nothing is running right now" —
   * a job that fails synchronously can empty the in-flight count while work is
   * still queued, and returning early there would report a half-run round as
   * finished.
   */
  async onIdle(): Promise<void> {
    if (this.isDrained()) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private isDrained(): boolean {
    if (this.active > 0) return false;
    // Stopping means no further claims, so a stopped queue with nothing in
    // flight is idle even if rows remain queued.
    return this.stopped || !this.store.hasClaimable();
  }

  private settleIdle(): void {
    if (!this.isDrained()) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private async drain(): Promise<void> {
    // A single drain loop owns claiming, so two concurrent wake() calls cannot
    // both claim past the concurrency cap.
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.stopped && this.active < this.concurrency) {
        const job = this.store.claimNext();
        if (!job) break;
        void this.run(job);
      }
    } finally {
      this.draining = false;
    }
  }

  private async run(job: GenerationJob): Promise<void> {
    // The counter is incremented here rather than at the call site: an executor
    // that throws before its first await would otherwise reach the finally
    // below before the caller had incremented, corrupting the active count and
    // stalling the queue below its concurrency cap.
    this.active += 1;
    try {
      const result = await this.execute(job);
      // Cancellation requested mid-run still produced a real artifact; record
      // it as cancelled rather than completed so the operator's intent wins,
      // but keep the path so nothing is silently orphaned.
      if (this.store.isCancelRequested(job.id)) {
        this.onSettled(this.store.finishCancelled(job.id));
      } else {
        this.onSettled(this.store.complete(job.id, result));
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Generation job failed";
      if (this.store.isCancelRequested(job.id)) {
        this.onSettled(this.store.finishCancelled(job.id));
      } else {
        this.onSettled(this.store.fail(job.id, message));
      }
    } finally {
      this.active -= 1;
      this.settleIdle();
      // Immediately look for more work so the cap stays saturated.
      if (!this.stopped) void this.drain();
    }
  }
}
