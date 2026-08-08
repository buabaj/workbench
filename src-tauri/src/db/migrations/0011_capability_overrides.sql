-- A chosen model for a capability, independent of a credential.
--
-- `capability_profiles` cannot hold this: its `credential_profile_id` is NOT
-- NULL, so picking a model there means first creating a keychain credential.
-- Every capability already runs off the ambient `.env` key without one, and
-- having to invent a credential in order to change a model would be a strange
-- toll to charge.
--
-- One row per capability. Empty or absent means the registry's defaults, which
-- is what makes "Reset" a delete rather than a second kind of state.
CREATE TABLE capability_overrides (
  capability     TEXT PRIMARY KEY,
  model_ids_json TEXT NOT NULL DEFAULT '[]',
  updated_at     INTEGER NOT NULL
);
