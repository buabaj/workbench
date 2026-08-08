-- What a model wrote into a note, recorded outside the note.
--
-- The first attempt marked generated prose inline with HTML comments. It was
-- correct about the problem — unmarked model output becomes indistinguishable
-- from your own writing — and wrong about the remedy: it broke the shape of
-- the document you were writing, which is the one thing a notes tool must not
-- do. The record belongs beside the note, not inside it.
CREATE TABLE note_generations (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  rel_path     TEXT NOT NULL,
  model        TEXT NOT NULL,
  instruction  TEXT NOT NULL,
  text         TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX note_generations_by_note
  ON note_generations (workspace_id, rel_path, created_at DESC);
