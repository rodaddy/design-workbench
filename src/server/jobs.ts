import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

/**
 * Persisted generation jobs.
 *
 * The store owns job state transitions; the queue owns execution. Keeping them
 * apart means a job's lifecycle is inspectable and testable without running a
 * local agent, and a process crash leaves durable rows instead of losing work
 * silently.
 */

const identifier = z.string().trim().min(1).max(200);
const jsonObject = z.record(z.string(), z.unknown());

export const JOB_KINDS = [
  "wide-net",
  "refinement",
  "assets",
  "revision",
] as const;
export const JOB_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export type GenerationJobKind = (typeof JOB_KINDS)[number];
export type GenerationJobStatus = (typeof JOB_STATUSES)[number];

const enqueueSchema = z
  .object({
    projectId: identifier,
    roundId: identifier.nullable().default(null),
    comparisonId: identifier.nullable().default(null),
    directionId: identifier.nullable().default(null),
    kind: z.enum(JOB_KINDS),
    engine: z.enum(["impeccable", "taste"]).nullable().default(null),
    position: z.number().int().nonnegative().default(0),
    prompt: z.string().max(200_000).default(""),
    payload: jsonObject.default({}),
    idempotencyKey: identifier,
  })
  .strict();

export type EnqueueGenerationJob = z.input<typeof enqueueSchema>;

export interface GenerationJob {
  id: string;
  projectId: string;
  roundId: string | null;
  comparisonId: string | null;
  directionId: string | null;
  kind: GenerationJobKind;
  engine: "impeccable" | "taste" | null;
  position: number;
  status: GenerationJobStatus;
  cancelRequested: boolean;
  artifactPath: string | null;
  variantId: string | null;
  sessionId: string | null;
  runId: string | null;
  prompt: string;
  payload: Record<string, unknown>;
  error: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

type JobRow = {
  id: string;
  project_id: string;
  round_id: string | null;
  comparison_id: string | null;
  direction_id: string | null;
  kind: GenerationJobKind;
  engine: "impeccable" | "taste" | null;
  position: number;
  status: GenerationJobStatus;
  cancel_requested: number;
  artifact_path: string | null;
  variant_id: string | null;
  session_id: string | null;
  run_id: string | null;
  prompt: string;
  payload: string;
  error: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export class GenerationJobError extends Error {
  constructor(
    readonly code:
      | "JOB_CONFLICT"
      | "JOB_INVALID_INPUT"
      | "JOB_NOT_FOUND"
      | "JOB_DATA_INVALID",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GenerationJobError";
  }
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class GenerationJobStore {
  constructor(private readonly database: Database) {}

  private toJob(row: JobRow): GenerationJob {
    let payload: Record<string, unknown>;
    try {
      payload = jsonObject.parse(JSON.parse(row.payload));
    } catch (error) {
      throw new GenerationJobError(
        "JOB_DATA_INVALID",
        "Stored job payload is invalid",
        { cause: error },
      );
    }
    return {
      id: row.id,
      projectId: row.project_id,
      roundId: row.round_id,
      comparisonId: row.comparison_id,
      directionId: row.direction_id,
      kind: row.kind,
      engine: row.engine,
      position: row.position,
      status: row.status,
      cancelRequested: row.cancel_requested === 1,
      artifactPath: row.artifact_path,
      variantId: row.variant_id,
      sessionId: row.session_id,
      runId: row.run_id,
      prompt: row.prompt,
      payload,
      error: row.error,
      attempts: row.attempts,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    };
  }

  get(jobId: string): GenerationJob {
    const row = this.database
      .query<JobRow, [string]>("SELECT * FROM generation_jobs WHERE id = ?")
      .get(identifier.parse(jobId));
    if (!row) {
      throw new GenerationJobError("JOB_NOT_FOUND", "Job does not exist");
    }
    return this.toJob(row);
  }

  listForComparison(comparisonId: string): GenerationJob[] {
    return this.database
      .query<JobRow, [string]>(
        `SELECT * FROM generation_jobs WHERE comparison_id = ?
         ORDER BY created_at, id`,
      )
      .all(identifier.parse(comparisonId))
      .map((row) => this.toJob(row));
  }

  listForRound(roundId: string): GenerationJob[] {
    return this.database
      .query<JobRow, [string]>(
        `SELECT * FROM generation_jobs WHERE round_id = ?
         ORDER BY position, created_at, id`,
      )
      .all(identifier.parse(roundId))
      .map((row) => this.toJob(row));
  }

  /**
   * Enqueue a job. Re-enqueueing with the same idempotency key returns the
   * existing job when the request matches, so a retried click never doubles a
   * generation. A different request under the same key is a conflict.
   */
  enqueue(input: EnqueueGenerationJob): GenerationJob {
    const parsed = enqueueSchema.safeParse(input);
    if (!parsed.success) {
      throw new GenerationJobError(
        "JOB_INVALID_INPUT",
        "Job input is invalid",
        {
          cause: parsed.error,
        },
      );
    }
    const value = parsed.data;
    const requestFingerprint = fingerprint(value);
    const existing = this.database
      .query<JobRow & { request_fingerprint: string }, [string, string]>(
        `SELECT * FROM generation_jobs
         WHERE project_id = ? AND idempotency_key = ?`,
      )
      .get(value.projectId, value.idempotencyKey);
    if (existing) {
      if (existing.request_fingerprint !== requestFingerprint) {
        throw new GenerationJobError(
          "JOB_CONFLICT",
          "Job idempotency key was used for different input",
        );
      }
      return this.toJob(existing);
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      this.database
        .query(
          `INSERT INTO generation_jobs (
            id, project_id, round_id, comparison_id, direction_id, kind, engine,
            position, status, prompt, payload, idempotency_key,
            request_fingerprint, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id,
          value.projectId,
          value.roundId,
          value.comparisonId,
          value.directionId,
          value.kind,
          value.engine,
          value.position,
          value.prompt,
          JSON.stringify(value.payload),
          value.idempotencyKey,
          requestFingerprint,
          now,
          now,
        );
    } catch (error) {
      // The partial unique index rejects a second live job for one cell.
      throw new GenerationJobError(
        "JOB_CONFLICT",
        "A generation job is already active for this output cell",
        { cause: error },
      );
    }
    return this.get(id);
  }

  /** Whether any job is still waiting to be claimed. */
  hasClaimable(): boolean {
    return (
      this.database
        .query<{ id: string }, []>(
          `SELECT id FROM generation_jobs
           WHERE status = 'queued' AND cancel_requested = 0 LIMIT 1`,
        )
        .get() !== null
    );
  }

  /**
   * Atomically claim the oldest queued job, so concurrent workers never take
   * the same one. Returns null when nothing is claimable.
   */
  claimNext(): GenerationJob | null {
    const now = new Date().toISOString();
    const claim = this.database.transaction(() => {
      const candidate = this.database
        .query<{ id: string }, []>(
          `SELECT id FROM generation_jobs
           WHERE status = 'queued' AND cancel_requested = 0
           ORDER BY created_at, id LIMIT 1`,
        )
        .get();
      if (!candidate) return null;
      this.database
        .query(
          `UPDATE generation_jobs
           SET status = 'running', started_at = ?, updated_at = ?,
               attempts = attempts + 1, version = version + 1
           WHERE id = ? AND status = 'queued'`,
        )
        .run(now, now, candidate.id);
      return candidate.id;
    });
    const claimedId = claim.immediate();
    return claimedId === null ? null : this.get(claimedId);
  }

  /** Attach agent session/run identity once the worker has started them. */
  attachRun(jobId: string, sessionId: string, runId: string): void {
    this.database
      .query(
        `UPDATE generation_jobs
         SET session_id = ?, run_id = ?, updated_at = ?, version = version + 1
         WHERE id = ?`,
      )
      .run(sessionId, runId, new Date().toISOString(), jobId);
  }

  complete(
    jobId: string,
    result: { artifactPath: string; variantId?: string | null },
  ): GenerationJob {
    const now = new Date().toISOString();
    this.database
      .query(
        `UPDATE generation_jobs
         SET status = 'completed', artifact_path = ?, variant_id = ?,
             error = NULL, finished_at = ?, updated_at = ?,
             version = version + 1
         WHERE id = ?`,
      )
      .run(result.artifactPath, result.variantId ?? null, now, now, jobId);
    return this.get(jobId);
  }

  fail(jobId: string, message: string): GenerationJob {
    const now = new Date().toISOString();
    this.database
      .query(
        `UPDATE generation_jobs
         SET status = 'failed', error = ?, finished_at = ?, updated_at = ?,
             version = version + 1
         WHERE id = ?`,
      )
      // The schema requires a non-null error on a failed job.
      .run(message.slice(0, 20_000) || "Generation failed", now, now, jobId);
    return this.get(jobId);
  }

  /**
   * Request cancellation. A queued job stops immediately; a running job is
   * flagged so the worker can stop at its next safe point rather than being
   * killed mid-write and leaving unowned partial output.
   */
  requestCancel(jobId: string): GenerationJob {
    const job = this.get(jobId);
    const now = new Date().toISOString();
    if (job.status === "queued") {
      this.database
        .query(
          `UPDATE generation_jobs
           SET status = 'cancelled', cancel_requested = 1, started_at = ?,
               finished_at = ?, updated_at = ?, version = version + 1
           WHERE id = ? AND status = 'queued'`,
        )
        .run(now, now, now, jobId);
      return this.get(jobId);
    }
    if (job.status === "running") {
      this.database
        .query(
          `UPDATE generation_jobs
           SET cancel_requested = 1, updated_at = ?, version = version + 1
           WHERE id = ?`,
        )
        .run(now, jobId);
      return this.get(jobId);
    }
    // Cancelling an already-terminal job is a no-op, not an error, so a
    // duplicate click does not surface a spurious failure.
    return job;
  }

  /** Mark a cancel-requested running job as actually cancelled. */
  finishCancelled(jobId: string): GenerationJob {
    const now = new Date().toISOString();
    this.database
      .query(
        `UPDATE generation_jobs
         SET status = 'cancelled', finished_at = ?, updated_at = ?,
             version = version + 1
         WHERE id = ? AND status = 'running'`,
      )
      .run(now, now, jobId);
    return this.get(jobId);
  }

  isCancelRequested(jobId: string): boolean {
    const row = this.database
      .query<{ cancel_requested: number }, [string]>(
        "SELECT cancel_requested FROM generation_jobs WHERE id = ?",
      )
      .get(jobId);
    return row?.cancel_requested === 1;
  }

  listFailed(): GenerationJob[] {
    return this.database
      .query<JobRow, []>(
        "SELECT * FROM generation_jobs WHERE status = 'failed' ORDER BY created_at, id",
      )
      .all()
      .map((row) => this.toJob(row));
  }

  /**
   * Return failed jobs to the queue. Attempts are preserved so a repeatedly
   * failing cell stays visible rather than looking like a first try. The
   * partial unique index still refuses a requeue that would collide with a job
   * already live for the same cell.
   */
  retryFailed(): number {
    const now = new Date().toISOString();
    return this.database
      .query(
        `UPDATE generation_jobs
         SET status = 'queued', error = NULL, started_at = NULL,
             finished_at = NULL, cancel_requested = 0, updated_at = ?,
             version = version + 1
         WHERE status = 'failed'
           AND NOT EXISTS (
             SELECT 1 FROM generation_jobs AS live
             WHERE live.status IN ('queued', 'running')
               AND live.comparison_id IS generation_jobs.comparison_id
               AND live.direction_id IS generation_jobs.direction_id
               AND live.engine IS generation_jobs.engine
               AND live.kind = generation_jobs.kind
               AND live.position = generation_jobs.position
           )`,
      )
      .run(now).changes;
  }

  /**
   * Reconcile jobs left running by a previous process. A row still marked
   * running at startup cannot be resumed (its worker is gone), so it is failed
   * explicitly rather than left to look active forever.
   */
  recoverInterrupted(): number {
    const now = new Date().toISOString();
    return this.database
      .query(
        `UPDATE generation_jobs
         SET status = 'failed',
             error = 'Interrupted: the workbench process exited during this run',
             finished_at = ?, updated_at = ?, version = version + 1
         WHERE status = 'running'`,
      )
      .run(now, now).changes;
  }
}
