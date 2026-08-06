-- 0005: durable anchors + typed cross-mode links.

CREATE TABLE anchors (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  rel_path            TEXT NOT NULL,
  exact_text          TEXT NOT NULL,        -- capped in Rust; kept so a broken
                                            -- anchor can still show its target
  prefix_text         TEXT NOT NULL DEFAULT '',
  suffix_text         TEXT NOT NULL DEFAULT '',
  hint_from           INTEGER NOT NULL,
  hint_to             INTEGER NOT NULL,
  file_hash_at_create TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'ok'
                        CHECK (status IN ('ok','stale','broken')),
  confidence          REAL NOT NULL DEFAULT 1.0,
  last_resolved_at    INTEGER,
  created_at          INTEGER NOT NULL
);
CREATE INDEX anchors_ws_path ON anchors(workspace_id, rel_path);

CREATE TABLE links (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN
                  ('supports','implements','tests','contradicts','derived_from')),
  src_anchor_id TEXT NOT NULL REFERENCES anchors(id) ON DELETE CASCADE,
  dst_anchor_id TEXT NOT NULL REFERENCES anchors(id) ON DELETE CASCADE,
  note          TEXT,
  created_by    TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user','agent')),
  task_id       TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE (src_anchor_id, dst_anchor_id, kind)
);
CREATE INDEX links_src ON links(src_anchor_id);
CREATE INDEX links_dst ON links(dst_anchor_id);
