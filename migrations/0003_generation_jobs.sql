-- Persisted generation jobs.
--
-- Local agent generation takes minutes per artifact. Running it inside the
-- request meant the operator watched a spinning HTTP call with no visible
-- state, no way to cancel, and no record of what a failed attempt had done.
-- Jobs move that work behind a durable queue so the UI can show
-- queued/running/completed/failed/cancelled, and so a crashed process leaves
-- an inspectable row rather than a silently lost run.

CREATE TABLE generation_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES site_projects(id) ON DELETE CASCADE,
  round_id TEXT REFERENCES exploration_rounds(id) ON DELETE SET NULL,
  comparison_id TEXT REFERENCES comparisons(id) ON DELETE CASCADE,
  -- Wide-net jobs target a comparison direction; refinement and asset jobs
  -- target a round option slot, so the direction reference is optional.
  direction_id TEXT REFERENCES aesthetic_directions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CHECK (kind IN ('wide-net', 'refinement', 'assets', 'revision')),
  engine TEXT CHECK (engine IS NULL OR engine IN ('impeccable', 'taste')),
  -- Position distinguishes sibling outputs within one round (refinement
  -- options 0..2, asset candidates 0..n).
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  -- Set when the operator requests cancellation; the worker observes this and
  -- stops at its next safe point rather than being killed mid-write.
  cancel_requested INTEGER NOT NULL DEFAULT 0
    CHECK (cancel_requested IN (0, 1)),
  artifact_path TEXT,
  variant_id TEXT REFERENCES variants(id) ON DELETE SET NULL,
  session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  prompt TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (project_id, idempotency_key),
  -- A terminal job must record why it ended; a non-terminal one must not
  -- pretend it already has.
  CHECK (status <> 'failed' OR error IS NOT NULL),
  CHECK (status NOT IN ('completed', 'failed', 'cancelled') OR finished_at IS NOT NULL),
  CHECK (status = 'queued' OR started_at IS NOT NULL)
) STRICT;

-- One live job per output cell. Terminal rows are excluded so a retry after a
-- failure is allowed, but two concurrent attempts on the same cell are not.
CREATE UNIQUE INDEX generation_jobs_active_cell_idx
  ON generation_jobs(comparison_id, direction_id, engine, kind, position)
  WHERE status IN ('queued', 'running');

CREATE INDEX generation_jobs_status_idx
  ON generation_jobs(status, created_at);
CREATE INDEX generation_jobs_project_idx
  ON generation_jobs(project_id, created_at);
CREATE INDEX generation_jobs_comparison_idx
  ON generation_jobs(comparison_id, created_at);
