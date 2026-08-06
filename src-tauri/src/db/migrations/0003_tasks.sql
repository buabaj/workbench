-- 0003: agent tasks. Records the RESOLVED provider/model/credential-reference
-- and injection mode for auditability — never a secret.

CREATE TABLE tasks (
  id                              TEXT PRIMARY KEY,
  workspace_id                    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_profile_id                TEXT REFERENCES agent_profiles(id) ON DELETE SET NULL,
  resolved_credential_profile_id  TEXT,     -- snapshot, intentionally no FK
  profile_origin                  TEXT CHECK (profile_origin IN ('task','workspace','app')),
  injection_mode                  TEXT,
  provider                        TEXT,
  model                           TEXT,
  thinking_level                  TEXT,
  prompt_text                     TEXT NOT NULL,
  status                          TEXT NOT NULL CHECK (status IN
                                    ('starting','running','succeeded','failed','cancelled')),
  session_id                      TEXT,
  session_path                    TEXT,
  error_text                      TEXT,     -- redacted before storage
  created_at                      INTEGER NOT NULL,
  started_at                      INTEGER,
  ended_at                        INTEGER
);
CREATE INDEX tasks_ws_created ON tasks(workspace_id, created_at DESC);
