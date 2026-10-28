import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createComparison } from "../../src/server/comparisons";
import { migrateDatabase } from "../../src/server/database";
import { GenerationQueue } from "../../src/server/job-queue";
import {
  GenerationJobError,
  GenerationJobStore,
  type GenerationJob,
} from "../../src/server/jobs";
import { StudioProjectStore } from "../../src/server/projects";

const root = resolve(
  (process.env.TMPDIR ?? "/tmp") + "/design-workbench/job-tests",
  `${process.pid}-${Date.now()}`,
);

const brief = `# Jobs proof

## Aesthetic family
Editorial systems

## Visual vocabulary
- measured
- tactile
- typographic
- quiet
- precise

## References and borrowed qualities
- Quiet ledgers: borrow pacing, not identity.

## Intent
Prove the job queue.

## Audience
Operators.

## Primary action
Watch progress.

## Always
- Preserve real content

## Never
- Hide failures

## Open risks
- None

## Final copy-ready generation prompt
Create a measured editorial glam-up.
`;

/** Build a migrated database with one project and one 5-direction comparison. */
function scenario() {
  const run = resolve(root, crypto.randomUUID());
  const allowed = resolve(run, "allowed");
  const source = resolve(allowed, "site");
  const runtime = resolve(run, "runtime");
  const generated = resolve(run, "generated");
  const briefPath = resolve(run, "brief.md");
  mkdirSync(source, { recursive: true });
  mkdirSync(generated, { recursive: true });
  writeFileSync(resolve(source, "index.html"), "<h1>Owned baseline</h1>\n");
  writeFileSync(briefPath, brief);

  const database = new Database(":memory:", { strict: true });
  migrateDatabase(database);
  const projects = new StudioProjectStore(database, {
    allowedSourceRoots: [allowed],
    runtimeRoot: runtime,
  });
  const project = projects.createProject({
    slug: "owned-site",
    title: "Owned Site",
    sourcePath: source,
    idempotencyKey: "owned-site",
  });
  const comparison = createComparison(database, {
    brief: briefPath,
    directions: 5,
    generatedRoot: generated,
  });
  return {
    database,
    project,
    comparison,
    store: new GenerationJobStore(database),
  };
}

describe("generation job store", () => {
  test("enqueues a queued job and reads it back", () => {
    const { database, project, comparison, store } = scenario();
    const job = store.enqueue({
      projectId: project.id,
      comparisonId: comparison.comparisonId,
      directionId: comparison.directions[0]?.id ?? null,
      kind: "wide-net",
      engine: "impeccable",
      idempotencyKey: "d1-impeccable",
    });

    expect(job.status).toBe("queued");
    expect(job.engine).toBe("impeccable");
    expect(job.attempts).toBe(0);
    expect(job.finishedAt).toBeNull();
    expect(store.get(job.id).id).toBe(job.id);
    database.close();
  });

  test("returns the same job for a repeated idempotency key", () => {
    const { database, project, comparison, store } = scenario();
    const request = {
      projectId: project.id,
      comparisonId: comparison.comparisonId,
      directionId: comparison.directions[0]?.id ?? null,
      kind: "wide-net" as const,
      engine: "impeccable" as const,
      idempotencyKey: "d1-impeccable",
    };
    expect(store.enqueue(request).id).toBe(store.enqueue(request).id);
    database.close();
  });

  test("rejects a second live job for the same output cell", () => {
    const { database, project, comparison, store } = scenario();
    const base = {
      projectId: project.id,
      comparisonId: comparison.comparisonId,
      directionId: comparison.directions[0]?.id ?? null,
      kind: "wide-net" as const,
      engine: "impeccable" as const,
    };
    store.enqueue({ ...base, idempotencyKey: "first" });

    // Same cell, different idempotency key: the partial unique index must
    // refuse it, because two agents writing one directory corrupts output.
    let caught: unknown;
    try {
      store.enqueue({ ...base, idempotencyKey: "second" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GenerationJobError);
    expect((caught as GenerationJobError).code).toBe("JOB_CONFLICT");
    database.close();
  });

  test("allows a retry on the same cell once the earlier job failed", () => {
    const { database, project, comparison, store } = scenario();
    const base = {
      projectId: project.id,
      comparisonId: comparison.comparisonId,
      directionId: comparison.directions[0]?.id ?? null,
      kind: "wide-net" as const,
      engine: "impeccable" as const,
    };
    const first = store.enqueue({ ...base, idempotencyKey: "first" });
    store.claimNext();
    store.fail(first.id, "agent exited non-zero");

    const retry = store.enqueue({ ...base, idempotencyKey: "retry" });
    expect(retry.status).toBe("queued");
    expect(store.get(first.id).status).toBe("failed");
    expect(store.get(first.id).error).toContain("agent exited");
    database.close();
  });

  test("claims queued jobs oldest-first and only once each", () => {
    const { database, project, comparison, store } = scenario();
    for (const [index, direction] of comparison.directions.entries()) {
      store.enqueue({
        projectId: project.id,
        comparisonId: comparison.comparisonId,
        directionId: direction.id,
        kind: "wide-net",
        engine: "impeccable",
        idempotencyKey: `job-${index}`,
      });
    }

    const claimed = new Set<string>();
    for (let index = 0; index < 5; index += 1) {
      const job = store.claimNext();
      expect(job).not.toBeNull();
      expect(job?.status).toBe("running");
      expect(job?.attempts).toBe(1);
      claimed.add(job?.id ?? "");
    }
    expect(claimed.size).toBe(5);
    expect(store.claimNext()).toBeNull();
    database.close();
  });

  test("cancels a queued job immediately", () => {
    const { database, project, comparison, store } = scenario();
    const job = store.enqueue({
      projectId: project.id,
      comparisonId: comparison.comparisonId,
      directionId: comparison.directions[0]?.id ?? null,
      kind: "wide-net",
      engine: "impeccable",
      idempotencyKey: "cancel-me",
    });
    const cancelled = store.requestCancel(job.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.finishedAt).not.toBeNull();
    // A cancelled job is not claimable.
    expect(store.claimNext()).toBeNull();
    database.close();
  });

  test("flags a running job for cooperative cancellation", () => {
    const { database, project, comparison, store } = scenario();
    const job = store.enqueue({
      projectId: project.id,
      comparisonId: comparison.comparisonId,
      directionId: comparison.directions[0]?.id ?? null,
      kind: "wide-net",
      engine: "impeccable",
      idempotencyKey: "cancel-running",
    });
    store.claimNext();

    const flagged = store.requestCancel(job.id);
    // Still running: the worker must stop at a safe point, not be killed here.
    expect(flagged.status).toBe("running");
    expect(flagged.cancelRequested).toBe(true);
    expect(store.isCancelRequested(job.id)).toBe(true);
    expect(store.finishCancelled(job.id).status).toBe("cancelled");
    database.close();
  });

  test("fails jobs left running by a previous process", () => {
    const { database, project, comparison, store } = scenario();
    const job = store.enqueue({
      projectId: project.id,
      comparisonId: comparison.comparisonId,
      directionId: comparison.directions[0]?.id ?? null,
      kind: "wide-net",
      engine: "impeccable",
      idempotencyKey: "orphan",
    });
    store.claimNext();

    expect(store.recoverInterrupted()).toBe(1);
    const recovered = store.get(job.id);
    expect(recovered.status).toBe("failed");
    expect(recovered.error).toContain("Interrupted");
    database.close();
  });

  test("lists jobs for a comparison in creation order", () => {
    const { database, project, comparison, store } = scenario();
    for (const [index, direction] of comparison.directions.entries()) {
      store.enqueue({
        projectId: project.id,
        comparisonId: comparison.comparisonId,
        directionId: direction.id,
        kind: "wide-net",
        engine: "taste",
        idempotencyKey: `listed-${index}`,
      });
    }
    expect(store.listForComparison(comparison.comparisonId)).toHaveLength(5);
    database.close();
  });
});

describe("generation queue", () => {
  test("runs every queued job and records completion", async () => {
    const { database, project, comparison, store } = scenario();
    for (const [index, direction] of comparison.directions.entries()) {
      store.enqueue({
        projectId: project.id,
        comparisonId: comparison.comparisonId,
        directionId: direction.id,
        kind: "wide-net",
        engine: "impeccable",
        idempotencyKey: `run-${index}`,
      });
    }

    const settled: GenerationJob[] = [];
    const queue = new GenerationQueue(
      store,
      async (job) => ({ artifactPath: `artifacts/${job.position}` }),
      { concurrency: 2, onSettled: (job) => settled.push(job) },
    );
    queue.wake();
    await queue.onIdle();

    expect(settled).toHaveLength(5);
    expect(settled.every((job) => job.status === "completed")).toBe(true);
    expect(store.claimNext()).toBeNull();
    database.close();
  });

  test("never exceeds the configured concurrency", async () => {
    const { database, project, comparison, store } = scenario();
    for (const [index, direction] of comparison.directions.entries()) {
      store.enqueue({
        projectId: project.id,
        comparisonId: comparison.comparisonId,
        directionId: direction.id,
        kind: "wide-net",
        engine: "impeccable",
        idempotencyKey: `bounded-${index}`,
      });
    }

    let inFlight = 0;
    let peak = 0;
    const queue = new GenerationQueue(
      store,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Bun.sleep(10);
        inFlight -= 1;
        return { artifactPath: "artifact" };
      },
      { concurrency: 2 },
    );
    queue.wake();
    await queue.onIdle();

    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
    database.close();
  });

  test("records a failing job as failed without stopping the queue", async () => {
    const { database, project, comparison, store } = scenario();
    for (const [index, direction] of comparison.directions.entries()) {
      store.enqueue({
        projectId: project.id,
        comparisonId: comparison.comparisonId,
        directionId: direction.id,
        kind: "wide-net",
        engine: "impeccable",
        idempotencyKey: `mixed-${index}`,
      });
    }

    let call = 0;
    const settled: GenerationJob[] = [];
    const queue = new GenerationQueue(
      store,
      async () => {
        call += 1;
        if (call === 1) throw new Error("agent produced no index.html");
        return { artifactPath: "artifact" };
      },
      { concurrency: 1, onSettled: (job) => settled.push(job) },
    );
    queue.wake();
    await queue.onIdle();

    const failed = settled.filter((job) => job.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error).toContain("no index.html");
    // One failure must not abandon the rest of the round.
    expect(settled.filter((job) => job.status === "completed")).toHaveLength(4);
    database.close();
  });

  test("honours a cancel requested while a job is running", async () => {
    const { database, project, comparison, store } = scenario();
    const job = store.enqueue({
      projectId: project.id,
      comparisonId: comparison.comparisonId,
      directionId: comparison.directions[0]?.id ?? null,
      kind: "wide-net",
      engine: "impeccable",
      idempotencyKey: "cancel-inflight",
    });

    const queue = new GenerationQueue(
      store,
      async (running) => {
        store.requestCancel(running.id);
        return { artifactPath: "artifact" };
      },
      { concurrency: 1 },
    );
    queue.wake();
    await queue.onIdle();

    // The operator's cancellation wins over the late-arriving success.
    expect(store.get(job.id).status).toBe("cancelled");
    database.close();
  });
});
