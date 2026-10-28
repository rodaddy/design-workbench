CREATE TABLE site_projects (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  canonical_source_path TEXT NOT NULL UNIQUE,
  runtime_path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, version)
) STRICT;

CREATE TABLE project_baselines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES site_projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  source_path TEXT NOT NULL,
  snapshot_path TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL
    CHECK (
      length(content_hash) = 64
      AND content_hash NOT GLOB '*[^0-9a-f]*'
    ),
  file_count INTEGER NOT NULL CHECK (file_count >= 0),
  byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, id),
  UNIQUE (project_id, revision),
  UNIQUE (project_id, idempotency_key)
) STRICT;

CREATE TABLE exploration_rounds (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES site_projects(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  stage TEXT NOT NULL
    CHECK (stage IN ('wide-net', 'refinement', 'assets', 'tuning')),
  comparison_id TEXT REFERENCES comparisons(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'running', 'completed', 'cancelled')),
  prompt TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, id),
  UNIQUE (project_id, sequence),
  UNIQUE (project_id, idempotency_key)
) STRICT;

CREATE TABLE exploration_round_lineage (
  project_id TEXT NOT NULL REFERENCES site_projects(id) ON DELETE CASCADE,
  ancestor_round_id TEXT NOT NULL,
  descendant_round_id TEXT NOT NULL,
  depth INTEGER NOT NULL CHECK (depth >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, ancestor_round_id, descendant_round_id),
  FOREIGN KEY (project_id, ancestor_round_id)
    REFERENCES exploration_rounds(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, descendant_round_id)
    REFERENCES exploration_rounds(project_id, id) ON DELETE CASCADE,
  CHECK (
    (depth = 0 AND ancestor_round_id = descendant_round_id)
    OR
    (depth > 0 AND ancestor_round_id <> descendant_round_id)
  )
) STRICT;

CREATE TABLE direction_selections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES site_projects(id) ON DELETE CASCADE,
  round_id TEXT NOT NULL,
  comparison_direction_id TEXT REFERENCES aesthetic_directions(id) ON DELETE SET NULL,
  direction_key TEXT NOT NULL,
  title TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL CHECK (position >= 0),
  payload TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, id),
  UNIQUE (project_id, round_id, direction_key),
  UNIQUE (project_id, round_id, position),
  UNIQUE (project_id, round_id, idempotency_key),
  FOREIGN KEY (project_id, round_id)
    REFERENCES exploration_rounds(project_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES site_projects(id) ON DELETE CASCADE,
  round_id TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'completed', 'failed', 'cancelled')),
  metadata TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(metadata) AND json_type(metadata) = 'object'),
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, id),
  UNIQUE (project_id, idempotency_key),
  FOREIGN KEY (project_id, round_id)
    REFERENCES exploration_rounds(project_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES site_projects(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  input TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(input) AND json_type(input) = 'object'),
  output TEXT
    CHECK (
      output IS NULL
      OR (json_valid(output) AND json_type(output) = 'object')
    ),
  error TEXT,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, id),
  UNIQUE (project_id, session_id, id),
  UNIQUE (project_id, session_id, sequence),
  UNIQUE (project_id, session_id, idempotency_key),
  FOREIGN KEY (project_id, session_id)
    REFERENCES agent_sessions(project_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE agent_messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES site_projects(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  run_id TEXT,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(metadata) AND json_type(metadata) = 'object'),
  created_at TEXT NOT NULL,
  UNIQUE (project_id, session_id, id),
  UNIQUE (project_id, session_id, sequence),
  FOREIGN KEY (project_id, session_id)
    REFERENCES agent_sessions(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, session_id, run_id)
    REFERENCES agent_runs(project_id, session_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE tweak_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES site_projects(id) ON DELETE CASCADE,
  baseline_id TEXT NOT NULL,
  selection_id TEXT,
  variant_id TEXT REFERENCES variants(id) ON DELETE SET NULL,
  parent_snapshot_id TEXT,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  snapshot_path TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL
    CHECK (
      length(content_hash) = 64
      AND content_hash NOT GLOB '*[^0-9a-f]*'
    ),
  file_count INTEGER NOT NULL CHECK (file_count >= 0),
  byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
  payload TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, id),
  UNIQUE (project_id, sequence),
  UNIQUE (project_id, idempotency_key),
  FOREIGN KEY (project_id, baseline_id)
    REFERENCES project_baselines(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, selection_id)
    REFERENCES direction_selections(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, parent_snapshot_id)
    REFERENCES tweak_snapshots(project_id, id) ON DELETE RESTRICT,
  CHECK (parent_snapshot_id IS NULL OR parent_snapshot_id <> id)
) STRICT;

CREATE INDEX project_baselines_project_id_idx
  ON project_baselines(project_id);
CREATE INDEX exploration_rounds_project_id_idx
  ON exploration_rounds(project_id);
CREATE INDEX exploration_rounds_comparison_id_idx
  ON exploration_rounds(comparison_id);
CREATE INDEX exploration_round_lineage_ancestor_idx
  ON exploration_round_lineage(project_id, ancestor_round_id);
CREATE INDEX exploration_round_lineage_descendant_idx
  ON exploration_round_lineage(project_id, descendant_round_id);
CREATE INDEX direction_selections_round_id_idx
  ON direction_selections(project_id, round_id);
CREATE INDEX agent_sessions_round_id_idx
  ON agent_sessions(project_id, round_id);
CREATE INDEX agent_runs_session_id_idx
  ON agent_runs(project_id, session_id);
CREATE INDEX agent_messages_session_id_idx
  ON agent_messages(project_id, session_id);
CREATE INDEX agent_messages_run_id_idx
  ON agent_messages(project_id, run_id);
CREATE INDEX tweak_snapshots_baseline_id_idx
  ON tweak_snapshots(project_id, baseline_id);
CREATE INDEX tweak_snapshots_selection_id_idx
  ON tweak_snapshots(project_id, selection_id);
CREATE INDEX tweak_snapshots_variant_id_idx
  ON tweak_snapshots(variant_id);
CREATE INDEX tweak_snapshots_parent_id_idx
  ON tweak_snapshots(project_id, parent_snapshot_id);
