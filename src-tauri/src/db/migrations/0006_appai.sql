-- 0006: app-AI telemetry. Scalars only — the table has no column capable of
-- holding a prompt, a transcript, audio, or a file path.

CREATE TABLE appai_invocations (
  id              TEXT PRIMARY KEY,
  capability      TEXT NOT NULL,
  model_requested TEXT,
  model_served    TEXT,
  status          TEXT NOT NULL,
  error_code      TEXT,
  duration_ms     INTEGER,
  input_bytes     INTEGER,
  output_chars    INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX appai_invocations_cap ON appai_invocations(capability, created_at DESC);
