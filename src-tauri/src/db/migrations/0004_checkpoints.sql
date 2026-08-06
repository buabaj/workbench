-- 0004: checkpoints + the agent/user write ledger that drives attribution.

CREATE TABLE checkpoints (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id      TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('pre_task','post_task','pre_restore')),
  tree_oid     TEXT NOT NULL,
  commit_oid   TEXT NOT NULL,
  ref_name     TEXT NOT NULL,
  file_count   INTEGER NOT NULL DEFAULT 0,
  total_bytes  INTEGER NOT NULL DEFAULT 0,
  skipped_json TEXT NOT NULL DEFAULT '[]',
  created_at   INTEGER NOT NULL
);
CREATE INDEX checkpoints_task ON checkpoints(task_id, kind);

-- Which files the USER touched through Workbench's own editor during a task.
-- Anything changed but absent here is attributed to the agent.
CREATE TABLE file_touches (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  rel_path  TEXT NOT NULL,
  origin    TEXT NOT NULL CHECK (origin IN ('user_editor','agent_tool','external')),
  ts        INTEGER NOT NULL
);
CREATE INDEX file_touches_task ON file_touches(task_id, rel_path);

ALTER TABLE tasks ADD COLUMN review_state TEXT NOT NULL DEFAULT 'none'
  CHECK (review_state IN ('none','pending','kept','restored'));
