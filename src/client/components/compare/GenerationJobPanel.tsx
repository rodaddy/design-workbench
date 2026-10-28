import type { GenerationJob } from "../../studio/types";
import type { ComparisonDirection } from "./types";

/*
THESIS: A dense job register makes every queued, running, and failed proof visible; it refuses the silent spinner it replaces.
OWN-WORLD: Dark rows, hairline rules, mono status registers, one warm amber signal for running work — the studio console.
STORY: Enqueue the missing proofs, watch each cell move through its states, cancel or read the failure without leaving Compare.
FIRST VIEWPORT: A compact header with the enqueue action over one row per job, status at the leading edge.
FORM: Operate mode; inherits the console register, no card grid, no progress theatre.
*/

const STATUS_LABEL: Record<GenerationJob["status"], string> = {
  queued: "Queued",
  running: "Running",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

function directionLabel(
  directions: readonly ComparisonDirection[],
  job: GenerationJob,
): string {
  const index = directions.findIndex((item) => item.id === job.directionId);
  const direction = index === -1 ? undefined : directions[index];
  if (!direction) return job.directionId ?? "—";
  return `V${index + 1} ${direction.title}`;
}

/** Elapsed wall-clock for a job, so a long run reads as progress not a hang. */
function elapsed(job: GenerationJob): string {
  if (!job.startedAt) return "";
  const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
  const seconds = Math.max(
    0,
    Math.round((end - Date.parse(job.startedAt)) / 1000),
  );
  if (!Number.isFinite(seconds)) return "";
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

export function GenerationJobPanel({
  jobs,
  directions,
  onEnqueue,
  onCancel,
  busy,
  status,
}: {
  readonly jobs: readonly GenerationJob[];
  readonly directions: readonly ComparisonDirection[];
  readonly onEnqueue: () => void;
  readonly onCancel: (jobId: string) => void;
  readonly busy: boolean;
  readonly status: string;
}) {
  const active = jobs.filter(
    (job) => job.status === "queued" || job.status === "running",
  ).length;
  const completed = jobs.filter((job) => job.status === "completed").length;
  const failed = jobs.filter((job) => job.status === "failed").length;

  return (
    <section
      className="generation-jobs"
      aria-labelledby="generation-jobs-title"
    >
      <header>
        <div>
          <p className="compare-kicker">Generation queue</p>
          <h3 id="generation-jobs-title">Local proof jobs</h3>
        </div>
        <div className="generation-jobs-actions">
          <button type="button" disabled={busy} onClick={onEnqueue}>
            Generate all missing proofs
          </button>
          <p role="status">
            {status ||
              (jobs.length === 0
                ? "No generation jobs yet."
                : `${active} active · ${completed} done · ${failed} failed`)}
          </p>
        </div>
      </header>
      {jobs.length > 0 ? (
        <ol className="generation-job-list">
          {jobs.map((job) => (
            <li key={job.id} data-status={job.status}>
              <span className="generation-job-status">
                {STATUS_LABEL[job.status]}
              </span>
              <span className="generation-job-target">
                {directionLabel(directions, job)}
              </span>
              <span className="generation-job-engine">
                {job.engine === "impeccable" ? "Impeccable" : "Taste"}
              </span>
              <span className="generation-job-elapsed">{elapsed(job)}</span>
              {job.status === "queued" || job.status === "running" ? (
                <button type="button" onClick={() => onCancel(job.id)}>
                  Cancel
                </button>
              ) : (
                <span />
              )}
              {job.error ? (
                <p className="generation-job-error" role="alert">
                  {job.error}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
