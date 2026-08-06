-- 0001: foundation. Workspaces + scoped settings. NEVER a secret value in any table.

CREATE TABLE workspaces (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  root_path      TEXT NOT NULL,           -- as the user provided it (display)
  root_real      TEXT NOT NULL UNIQUE,    -- canonicalized, NFC-normalized
  kind           TEXT NOT NULL CHECK (kind IN ('git', 'plain')),
  settings_json  TEXT NOT NULL DEFAULT '{}',
  created_at     INTEGER NOT NULL,
  last_opened_at INTEGER
);

CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE workspace_settings (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  value_json   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
) WITHOUT ROWID;
