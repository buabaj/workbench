-- 0007: conversation history.
--
-- A conversation maps 1:1 to a task_id (= one prime-agent session), so review
-- and checkpoints stay conversation-scoped. Turns are appended as they
-- complete; the agent's own JSONL session file remains the source of truth for
-- replaying inside the agent, while this table is what the UI reads to show
-- history instantly without spawning anything.

CREATE TABLE chat_turns (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text       TEXT NOT NULL DEFAULT '',
  error_text TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (task_id, seq)
);
CREATE INDEX chat_turns_task ON chat_turns(task_id, seq);
