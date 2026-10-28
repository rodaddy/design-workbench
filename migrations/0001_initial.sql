CREATE TABLE inspirations (
  id TEXT PRIMARY KEY,
  source_url TEXT NOT NULL UNIQUE,
  resolved_url TEXT,
  title TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  aesthetic_family TEXT NOT NULL DEFAULT '',
  visual_vocabulary TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(visual_vocabulary) AND json_type(visual_vocabulary) = 'array'),
  brief TEXT NOT NULL DEFAULT '',
  capture_type TEXT NOT NULL,
  confidence TEXT NOT NULL,
  source_status TEXT NOT NULL CHECK (source_status IN ('captured', 'partial', 'blocked')),
  provenance_path TEXT NOT NULL UNIQUE,
  limitation TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE inspiration_assets (
  id TEXT PRIMARY KEY,
  inspiration_id TEXT NOT NULL REFERENCES inspirations(id) ON DELETE CASCADE,
  content_hash TEXT,
  relative_path TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  role TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('seed', 'user')),
  is_available INTEGER NOT NULL DEFAULT 0 CHECK (is_available IN (0, 1)),
  motion_timestamp_ms INTEGER CHECK (motion_timestamp_ms IS NULL OR motion_timestamp_ms >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (inspiration_id, relative_path, role)
) STRICT;

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE inspiration_tags (
  inspiration_id TEXT NOT NULL REFERENCES inspirations(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('seed', 'user')),
  PRIMARY KEY (inspiration_id, tag_id)
) STRICT;

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  inclusion_rules TEXT NOT NULL DEFAULT '',
  exclusion_rules TEXT NOT NULL DEFAULT '',
  is_provisional INTEGER NOT NULL DEFAULT 0 CHECK (is_provisional IN (0, 1)),
  is_retired INTEGER NOT NULL DEFAULT 0 CHECK (is_retired IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE inspiration_categories (
  inspiration_id TEXT NOT NULL REFERENCES inspirations(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (inspiration_id, category_id)
) STRICT;

CREATE TABLE briefs (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  markdown TEXT NOT NULL,
  final_prompt TEXT NOT NULL,
  source_inspiration_id TEXT REFERENCES inspirations(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE comparisons (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  source_brief_id TEXT REFERENCES briefs(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE aesthetic_directions (
  id TEXT PRIMARY KEY,
  comparison_id TEXT NOT NULL REFERENCES comparisons(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0 AND position < 5),
  metadata TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(metadata) AND json_type(metadata) = 'object'),
  created_at TEXT NOT NULL,
  UNIQUE (comparison_id, slug),
  UNIQUE (comparison_id, position)
) STRICT;

CREATE TABLE variants (
  id TEXT PRIMARY KEY,
  direction_id TEXT NOT NULL REFERENCES aesthetic_directions(id) ON DELETE CASCADE,
  engine TEXT NOT NULL CHECK (engine IN ('impeccable', 'taste')),
  artifact_path TEXT NOT NULL,
  viewport TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(viewport) AND json_type(viewport) = 'object'),
  metadata TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(metadata) AND json_type(metadata) = 'object'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (direction_id, engine),
  UNIQUE (artifact_path)
) STRICT;

CREATE INDEX inspiration_assets_inspiration_id_idx
  ON inspiration_assets(inspiration_id);
CREATE INDEX inspiration_tags_tag_id_idx ON inspiration_tags(tag_id);
CREATE INDEX inspiration_categories_category_id_idx
  ON inspiration_categories(category_id);
CREATE INDEX aesthetic_directions_comparison_id_idx
  ON aesthetic_directions(comparison_id);
CREATE INDEX variants_direction_id_idx ON variants(direction_id);
