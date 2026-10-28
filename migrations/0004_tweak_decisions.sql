-- Tweak decisions and immutable artifact revisions.
--
-- The existing tweak_snapshots table models a filesystem snapshot (path,
-- content hash, file and byte counts) taken of a whole project. What the tweak
-- dock actually produces is different in kind: a small set of per-control
-- decisions against one variant's manifest. Recording those as a fake
-- filesystem snapshot would mean inventing a path and hash for something that
-- has neither, so decisions get their own table and the older one is left for
-- the project-snapshot purpose it was designed for.

CREATE TABLE tweak_decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES site_projects(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  -- The artifact path the decisions were made against. Kept alongside the
  -- variant id so a decision set stays interpretable even if the variant row
  -- is later repointed.
  artifact_path TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  -- { controlId: value } validated against the variant's manifest on write.
  decisions TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(decisions) AND json_type(decisions) = 'object'),
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, id),
  UNIQUE (project_id, idempotency_key)
) STRICT;

-- An agent-applied revision is a new immutable artifact, never an edit of the
-- proof it came from: exploration evidence must stay comparable to what
-- replaced it.
CREATE TABLE artifact_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES site_projects(id) ON DELETE CASCADE,
  -- The proof this revision was derived from.
  parent_variant_id TEXT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  parent_artifact_path TEXT NOT NULL,
  artifact_path TEXT NOT NULL UNIQUE,
  decision_id TEXT REFERENCES tweak_decisions(id) ON DELETE SET NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'failed')),
  error TEXT,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, id),
  UNIQUE (parent_variant_id, sequence),
  UNIQUE (project_id, idempotency_key),
  CHECK (status <> 'failed' OR error IS NOT NULL),
  CHECK (artifact_path <> parent_artifact_path)
) STRICT;

CREATE INDEX tweak_decisions_variant_idx
  ON tweak_decisions(variant_id, created_at);
CREATE INDEX tweak_decisions_project_idx
  ON tweak_decisions(project_id, created_at);
CREATE INDEX artifact_revisions_parent_idx
  ON artifact_revisions(parent_variant_id, sequence);
