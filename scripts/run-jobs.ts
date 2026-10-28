/**
 * Drain the generation job queue in a stable, non-watching process.
 *
 * The dev server runs under `bun --watch`, so editing server source restarts it
 * and kills any in-flight local agent run. Long generation rounds therefore run
 * here instead: this process only executes queued jobs, so source edits during
 * a round cannot interrupt it.
 *
 * Usage:
 *   bun run scripts/run-jobs.ts                 # drain whatever is queued
 *   bun run scripts/run-jobs.ts --concurrency 2
 *   bun run scripts/run-jobs.ts --retry-failed  # requeue failed jobs first
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { LocalAgentRunner } from "../src/server/agent-runner";
import { archiveOwnedPath } from "../src/server/project-filesystem";
import { openDatabase } from "../src/server/database";
import {
  generateComparisonVariant,
  GenerationError,
} from "../src/server/generation";
import { GenerationQueue } from "../src/server/job-queue";
import { GenerationJobStore } from "../src/server/jobs";
import { StudioProjectStore } from "../src/server/projects";
import {
  generateRefinementOption,
  resolveRefinementParent,
  REFINEMENT_LENSES,
} from "../src/server/refinements";
import { StudioService } from "../src/server/studio";

function flag(name: string, fallback: string): string {
  const index = Bun.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (Bun.argv[index + 1] ?? fallback);
}

const workbenchRoot = resolve(import.meta.dir, "..");
const databasePath = resolve(
  workbenchRoot,
  flag("database", "data/design-workbench.sqlite"),
);
const generatedRoot = resolve(workbenchRoot, "generated-variants");
const projectRuntimeRoot = resolve(workbenchRoot, "data/projects");
const projectSourceRoots = [
  resolve(workbenchRoot, "..", "rtech-consulting", "site"),
];
const concurrency = Math.max(1, Number.parseInt(flag("concurrency", "2"), 10));
const model = flag("model", Bun.env.GENERATION_MODEL ?? "claude-opus-5");
const effort = flag("effort", Bun.env.GENERATION_EFFORT ?? "high") as
  "low" | "medium" | "high";

const database = openDatabase(databasePath);
const jobStore = new GenerationJobStore(database);
const projects = new StudioProjectStore(database, {
  allowedSourceRoots: projectSourceRoots,
  runtimeRoot: projectRuntimeRoot,
});
const studio = new StudioService(database);
const runner = new LocalAgentRunner({
  executable: Bun.env.LOCAL_AGENT_EXECUTABLE ?? "claude",
  reviewRoots: [projectRuntimeRoot],
  buildRoots: [projectRuntimeRoot, generatedRoot],
});

// Jobs marked running belong to a process that is gone; fail them so they are
// visible and retryable rather than appearing active forever.
const recovered = jobStore.recoverInterrupted();
if (recovered > 0) {
  console.info(`Recovered ${recovered} interrupted job(s) from a prior run.`);
}

if (Bun.argv.includes("--retry-failed")) {
  // A job killed mid-run leaves its copied baseline behind, and generation
  // requires a prepared empty cell. Archive that partial output (never delete)
  // so the requeued job can actually start.
  for (const job of jobStore.listFailed()) {
    if (!job.comparisonId || !job.directionId || !job.engine) continue;
    const direction = database
      .query<{ slug: string }, [string]>(
        "SELECT slug FROM aesthetic_directions WHERE id = ?",
      )
      .get(job.directionId);
    if (!direction) continue;
    const cell = resolve(
      generatedRoot,
      job.comparisonId,
      direction.slug,
      job.engine,
    );
    if (existsSync(cell) && readdirSync(cell).length > 0) {
      archiveOwnedPath(cell, generatedRoot);
      mkdirSync(cell, { recursive: true });
      console.info(
        `Archived partial output for ${direction.slug}/${job.engine}.`,
      );
    }
  }
  const requeued = jobStore.retryFailed();
  console.info(`Requeued ${requeued} failed job(s).`);
}

const queue = new GenerationQueue(
  jobStore,
  async (job) => {
    if (job.kind === "refinement") {
      if (!job.roundId) {
        throw new GenerationError(
          "GENERATION_NOT_FOUND",
          "Refinement job does not identify a round",
        );
      }
      const lens = REFINEMENT_LENSES[job.position];
      if (!lens) {
        throw new GenerationError(
          "GENERATION_NOT_FOUND",
          `Refinement job position ${job.position} has no lens`,
        );
      }
      return generateRefinementOption({
        database,
        studio,
        runner,
        generatedVariantsRoot: generatedRoot,
        workbenchRoot,
        projectId: job.projectId,
        target: resolveRefinementParent(
          database,
          job.roundId,
          job.engine ?? undefined,
        ),
        lens,
        model,
        effort,
      });
    }

    if (!job.comparisonId || !job.directionId || !job.engine) {
      throw new GenerationError(
        "GENERATION_NOT_FOUND",
        "Job does not identify a comparison direction and engine",
      );
    }
    const variant = await generateComparisonVariant({
      database,
      projects,
      studio,
      runner,
      projectRuntimeRoot,
      generatedVariantsRoot: generatedRoot,
      workbenchRoot,
      comparisonId: job.comparisonId,
      directionId: job.directionId,
      engine: job.engine,
      model,
      effort,
    });
    return { artifactPath: variant.artifactPath, variantId: variant.id };
  },
  {
    concurrency,
    onSettled: (job) => {
      const label = `${job.kind} pos${job.position} ${job.engine ?? ""}`.trim();
      console.info(
        job.status === "completed"
          ? `✓ ${label} → ${job.artifactPath}`
          : `✗ ${label} [${job.status}] ${job.error ?? ""}`,
      );
    },
  },
);

let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  console.info("Stopping after in-flight jobs finish…");
  queue.stop();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

console.info(
  `Draining generation jobs (concurrency ${concurrency}, model ${model}/${effort}).`,
);
queue.wake();
await queue.onIdle();

const remaining = jobStore.hasClaimable();
console.info(
  remaining
    ? "Stopped with jobs still queued."
    : "Queue drained; no claimable jobs remain.",
);
database.close(false);
