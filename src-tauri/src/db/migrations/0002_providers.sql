-- 0002: providers, credentials (METADATA ONLY — never a secret value), profiles.
-- credential deletion is blocked by ON DELETE RESTRICT while referenced;
-- foreign_keys=ON is set per-connection in db::configure.

CREATE TABLE custom_providers (
  id                   TEXT PRIMARY KEY,               -- ULID; on-disk key = 'workbench-' || id
  label                TEXT NOT NULL UNIQUE,
  base_url             TEXT NOT NULL,
  api                  TEXT NOT NULL CHECK (api IN
                         ('openai-completions','openai-responses',
                          'anthropic-messages','google-generative-ai')),
  auth_header          INTEGER NOT NULL DEFAULT 1,
  headers_json         TEXT NOT NULL DEFAULT '{}',     -- non-secret only; validated in Rust
  models_json          TEXT NOT NULL DEFAULT '[]',
  model_overrides_json TEXT NOT NULL DEFAULT '{}',
  merged_at            INTEGER,
  merged_file_hash     TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  CHECK (api <> 'google-generative-ai' OR length(base_url) > 0)
);

CREATE TABLE credential_profiles (
  id                 TEXT PRIMARY KEY,                 -- ULID
  label              TEXT NOT NULL UNIQUE,
  auth_kind          TEXT NOT NULL CHECK (auth_kind IN
                       ('api_key','oauth_host','custom_provider')),
  provider_slug      TEXT,                             -- NULL for custom_provider
  custom_provider_id TEXT REFERENCES custom_providers(id) ON DELETE RESTRICT,
  keychain_account   TEXT UNIQUE,                      -- NULL iff auth_kind='oauth_host'
  scope              TEXT NOT NULL DEFAULT 'agent'
                       CHECK (scope IN ('agent','appai','both')),
  key_fingerprint    TEXT,                             -- hex(sha256(key))[..12], irreversible
  last_tested_at     INTEGER,
  last_test_status   TEXT,
  last_test_detail   TEXT,                             -- redacted before storage
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  CHECK ((auth_kind = 'oauth_host') = (keychain_account IS NULL)),
  CHECK ((auth_kind = 'custom_provider') = (custom_provider_id IS NOT NULL))
);

CREATE TABLE agent_profiles (
  id                    TEXT PRIMARY KEY,
  label                 TEXT NOT NULL UNIQUE,
  credential_profile_id TEXT NOT NULL
    REFERENCES credential_profiles(id) ON DELETE RESTRICT,
  model_id              TEXT,
  thinking_level        TEXT CHECK (thinking_level IS NULL OR thinking_level IN
                          ('off','minimal','low','medium','high','xhigh')),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE TABLE capability_profiles (
  id                    TEXT PRIMARY KEY,
  label                 TEXT NOT NULL,
  capability            TEXT NOT NULL,                 -- 'voice.transcription', ...
  credential_profile_id TEXT NOT NULL
    REFERENCES credential_profiles(id) ON DELETE RESTRICT,
  model_ids_json        TEXT NOT NULL DEFAULT '[]',    -- ordered fallback chain
  privacy_mode          TEXT NOT NULL DEFAULT 'strict'
                          CHECK (privacy_mode IN ('strict','balanced','off')),
  params_json           TEXT NOT NULL DEFAULT '{}',
  timeout_ms            INTEGER NOT NULL DEFAULT 90000,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX ix_capprof_cap ON capability_profiles(capability);
