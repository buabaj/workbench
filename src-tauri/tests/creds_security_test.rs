//! Negative security suite — the Phase 3 gate. Every assertion is a substring
//! search for a sentinel that must never appear where a secret must not be.

use workbench_lib::agent::config_dir::IsolatedConfigDir;
use workbench_lib::agent::spawn::{build_spawn_plan, EnvValue, InjectionMode, SpawnContext};
use workbench_lib::creds::keychain::MemKeychain;
use workbench_lib::creds::store::{
    add, delete, list, reassign, replace_secret, usage, AddCredentialInput, AuthKind, CredError,
};
use workbench_lib::profiles::{upsert_agent_profile, AgentProfileInput};
use workbench_lib::secret::SecretString;

const SENTINEL: &str = "sk-WBTESTSENTINEL9f3a2c8e1bXYZ";

fn open_file_db(dir: &std::path::Path) -> rusqlite::Connection {
    workbench_lib::db::open(&dir.join("test.db")).unwrap()
}

fn add_sentinel_cred(conn: &rusqlite::Connection, kc: &MemKeychain) -> String {
    add(
        conn,
        kc,
        AddCredentialInput {
            label: "sentinel anthropic".into(),
            auth_kind: AuthKind::ApiKey,
            provider_slug: Some("anthropic".into()),
            custom_provider_id: None,
            scope: "agent".into(),
            api_key: Some(SecretString::new(SENTINEL.into())),
        },
    )
    .unwrap()
    .id
}

fn read_all_db_bytes(dir: &std::path::Path) -> Vec<u8> {
    let mut bytes = Vec::new();
    for name in ["test.db", "test.db-wal", "test.db-shm"] {
        if let Ok(b) = std::fs::read(dir.join(name)) {
            bytes.extend(b);
        }
    }
    bytes
}

fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack
        .windows(needle.len())
        .any(|w| w == needle.as_bytes())
}

#[test]
fn db_file_never_contains_secret() {
    let dir = tempfile::tempdir().unwrap();
    let conn = open_file_db(dir.path());
    let kc = MemKeychain::default();

    let id = add_sentinel_cred(&conn, &kc);
    assert!(!contains(&read_all_db_bytes(dir.path()), SENTINEL));

    // After replace.
    replace_secret(&conn, &kc, &id, SecretString::new(format!("{SENTINEL}-v2"))).unwrap();
    assert!(!contains(&read_all_db_bytes(dir.path()), SENTINEL));

    // After delete + VACUUM (checks freed pages too).
    delete(&conn, &kc, &id).unwrap();
    conn.execute_batch("VACUUM;").unwrap();
    assert!(!contains(&read_all_db_bytes(dir.path()), SENTINEL));
}

#[test]
fn fingerprint_is_short_hex_not_the_key() {
    let dir = tempfile::tempdir().unwrap();
    let conn = open_file_db(dir.path());
    let kc = MemKeychain::default();
    add_sentinel_cred(&conn, &kc);

    let view = &list(&conn).unwrap()[0];
    let fp = view.key_fingerprint.as_deref().unwrap();
    assert_eq!(fp.len(), 12);
    assert!(fp.chars().all(|c| c.is_ascii_hexdigit()));
    assert!(!SENTINEL.contains(fp), "fingerprint must not be a substring of the key");
    // View serialization is sentinel-free.
    let json = serde_json::to_string(view).unwrap();
    assert!(!json.contains(SENTINEL));
}

fn spawn_ctx<'a>(
    cache: &'a std::path::Path,
    agent_dir: &'a std::path::Path,
    session_dir: &'a std::path::Path,
) -> SpawnContext<'a> {
    SpawnContext {
        app_cache: cache,
        real_agent_dir: agent_dir,
        program: "prime-agent".into(),
        path_env: "/usr/bin:/bin".into(),
        session_dir,
        workspace_root: session_dir,
    }
}

#[test]
fn spawn_plan_has_no_secret_in_argv_and_exactly_one_secret_env() {
    let dir = tempfile::tempdir().unwrap();
    let conn = open_file_db(dir.path());
    let kc = MemKeychain::default();
    let cred_id = add_sentinel_cred(&conn, &kc);
    let profile = upsert_agent_profile(
        &conn,
        AgentProfileInput {
            id: None,
            label: "p".into(),
            credential_profile_id: cred_id,
            model_id: Some("claude-sonnet-5".into()),
            thinking_level: Some("medium".into()),
        },
    )
    .unwrap();

    // Decoy in OUR environment: must never reach the plan.
    std::env::set_var("OPENAI_API_KEY", "sk-DECOY-SHOULD-NOT-APPEAR");

    let cache = dir.path().join("cache");
    let fake_agent_home = dir.path().join("prime-agent-home");
    std::fs::create_dir_all(&fake_agent_home).unwrap();
    let sessions = dir.path().join("sessions");
    let ctx = spawn_ctx(&cache, &fake_agent_home, &sessions);

    let plan = build_spawn_plan(&conn, &kc, &profile.id, "task-1", &ctx).unwrap();

    assert_eq!(plan.mode, InjectionMode::IsolatedConfig);
    // argv is sentinel-free.
    let argv = plan.args.join(" ");
    assert!(!argv.contains(SENTINEL));
    assert!(!argv.contains("DECOY"));

    // Exactly one secret-valued env entry, and it's WORKBENCH_PROVIDER_KEY.
    let secrets: Vec<&str> = plan
        .env_set
        .iter()
        .filter(|(_, v)| matches!(v, EnvValue::Secret(_)))
        .map(|(k, _)| k.as_str())
        .collect();
    assert_eq!(secrets, vec!["WORKBENCH_PROVIDER_KEY"]);

    // The decoy var is not among the plain values either.
    for (_, v) in &plan.env_set {
        if let EnvValue::Plain(p) = v {
            assert!(!p.contains("DECOY"));
            assert!(!p.contains(SENTINEL));
        }
    }
    // Known provider vars are explicitly stripped.
    assert!(plan.env_remove.iter().any(|v| v == "OPENAI_API_KEY"));
    assert!(plan.env_remove.iter().any(|v| v == "ANTHROPIC_API_KEY"));

    std::env::remove_var("OPENAI_API_KEY");
}

#[test]
fn isolated_config_dir_contains_zero_secret_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let conn = open_file_db(dir.path());
    let kc = MemKeychain::default();
    let cred_id = add_sentinel_cred(&conn, &kc);
    let profile = upsert_agent_profile(
        &conn,
        AgentProfileInput {
            id: None,
            label: "p".into(),
            credential_profile_id: cred_id,
            model_id: None,
            thinking_level: None,
        },
    )
    .unwrap();

    let cache = dir.path().join("cache");
    let fake_agent_home = dir.path().join("prime-agent-home");
    std::fs::create_dir_all(fake_agent_home.join("extensions")).unwrap();
    std::fs::write(fake_agent_home.join("settings.json"), "{}").unwrap();
    // The user's real auth.json holds another secret — it must NOT be linked in.
    std::fs::write(
        fake_agent_home.join("auth.json"),
        format!(r#"{{"openai":{{"type":"api_key","key":"{SENTINEL}-OTHER"}}}}"#),
    )
    .unwrap();
    let sessions = dir.path().join("sessions");
    let ctx = spawn_ctx(&cache, &fake_agent_home, &sessions);

    let plan = build_spawn_plan(&conn, &kc, &profile.id, "task-2", &ctx).unwrap();
    let conf = plan.config_dir.as_ref().unwrap();

    // Walk every real file in the tree (not following symlinks out).
    let mut stack = vec![conf.root().to_path_buf()];
    let mut checked_auth = false;
    while let Some(p) = stack.pop() {
        for entry in std::fs::read_dir(&p).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            let meta = std::fs::symlink_metadata(&path).unwrap();
            if meta.is_symlink() {
                // auth.json must never be a symlink.
                assert_ne!(path.file_name().unwrap(), "auth.json");
                continue;
            }
            if meta.is_dir() {
                stack.push(path);
            } else {
                let bytes = std::fs::read(&path).unwrap();
                assert!(
                    !contains(&bytes, SENTINEL),
                    "secret bytes found in {path:?}"
                );
                if path.file_name().unwrap() == "auth.json" {
                    checked_auth = true;
                    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                    assert_eq!(v["anthropic"]["key"], "WORKBENCH_PROVIDER_KEY");
                }
            }
        }
    }
    assert!(checked_auth, "isolated auth.json was not written");

    // settings.json got symlinked in (behavioral parity).
    assert!(conf.agent_dir().join("settings.json").exists());

    // Drop shreds the tree.
    let root = conf.root().to_path_buf();
    drop(plan);
    assert!(!root.exists(), "config dir not cleaned up on drop");
}

#[test]
fn spawn_plan_debug_is_redacted() {
    let dir = tempfile::tempdir().unwrap();
    let conn = open_file_db(dir.path());
    let kc = MemKeychain::default();
    let cred_id = add_sentinel_cred(&conn, &kc);
    let profile = upsert_agent_profile(
        &conn,
        AgentProfileInput {
            id: None,
            label: "p".into(),
            credential_profile_id: cred_id,
            model_id: None,
            thinking_level: None,
        },
    )
    .unwrap();
    let cache = dir.path().join("cache");
    let home = dir.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let sessions = dir.path().join("sessions");
    let ctx = spawn_ctx(&cache, &home, &sessions);

    let plan = build_spawn_plan(&conn, &kc, &profile.id, "task-3", &ctx).unwrap();
    let debug = format!("{plan:?}");
    assert!(!debug.contains(SENTINEL), "Debug leaked the secret: {debug}");
    assert!(debug.contains("<redacted>"));
}

#[test]
fn oauth_clean_spawn_injects_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let conn = open_file_db(dir.path());
    let kc = MemKeychain::default();
    let cred = add(
        &conn,
        &kc,
        AddCredentialInput {
            label: "claude pro (host)".into(),
            auth_kind: AuthKind::OauthHost,
            provider_slug: Some("anthropic".into()),
            custom_provider_id: None,
            scope: "agent".into(),
            api_key: None,
        },
    )
    .unwrap();
    let profile = upsert_agent_profile(
        &conn,
        AgentProfileInput {
            id: None,
            label: "oauth p".into(),
            credential_profile_id: cred.id,
            model_id: None,
            thinking_level: None,
        },
    )
    .unwrap();
    let cache = dir.path().join("cache");
    let home = dir.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let sessions = dir.path().join("sessions");
    let ctx = spawn_ctx(&cache, &home, &sessions);

    let plan = build_spawn_plan(&conn, &kc, &profile.id, "task-4", &ctx).unwrap();
    assert_eq!(plan.mode, InjectionMode::OauthClean);
    assert!(plan.config_dir.is_none());
    assert!(
        plan.env_set.iter().all(|(_, v)| matches!(v, EnvValue::Plain(_))),
        "OAuth spawn must inject zero secrets"
    );
    assert!(!plan
        .env_set
        .iter()
        .any(|(k, _)| k == "PRIME_AGENT_CODING_AGENT_DIR"));
}

#[test]
fn delete_blocked_while_referenced_then_reassign_unblocks() {
    let dir = tempfile::tempdir().unwrap();
    let mut conn = open_file_db(dir.path());
    let kc = MemKeychain::default();
    let id_a = add_sentinel_cred(&conn, &kc);
    let id_b = add(
        &conn,
        &kc,
        AddCredentialInput {
            label: "second".into(),
            auth_kind: AuthKind::ApiKey,
            provider_slug: Some("openrouter".into()),
            custom_provider_id: None,
            scope: "both".into(),
            api_key: Some(SecretString::new("sk-or-v1-other1234567".into())),
        },
    )
    .unwrap()
    .id;

    upsert_agent_profile(
        &conn,
        AgentProfileInput {
            id: None,
            label: "uses A".into(),
            credential_profile_id: id_a.clone(),
            model_id: None,
            thinking_level: None,
        },
    )
    .unwrap();

    // Blocked.
    let report = usage(&conn, &id_a).unwrap();
    assert!(report.blocked);
    assert!(matches!(delete(&conn, &kc, &id_a), Err(CredError::InUse)));
    assert!(kc.contains(&format!("cred:{id_a}")), "keychain entry must survive a blocked delete");

    // Reassign, then delete succeeds and the keychain entry is gone.
    let report = reassign(&mut conn, &id_a, &id_b).unwrap();
    assert!(!report.blocked);
    delete(&conn, &kc, &id_a).unwrap();
    assert!(!kc.contains(&format!("cred:{id_a}")));
}

#[test]
fn oauth_profiles_reject_keys_and_key_profiles_require_them() {
    let dir = tempfile::tempdir().unwrap();
    let conn = open_file_db(dir.path());
    let kc = MemKeychain::default();

    let err = add(
        &conn,
        &kc,
        AddCredentialInput {
            label: "bad oauth".into(),
            auth_kind: AuthKind::OauthHost,
            provider_slug: Some("anthropic".into()),
            custom_provider_id: None,
            scope: "agent".into(),
            api_key: Some(SecretString::new("sk-should-not-be-here".into())),
        },
    );
    assert!(matches!(err, Err(CredError::Validation(_))));

    let err = add(
        &conn,
        &kc,
        AddCredentialInput {
            label: "missing key".into(),
            auth_kind: AuthKind::ApiKey,
            provider_slug: Some("anthropic".into()),
            custom_provider_id: None,
            scope: "agent".into(),
            api_key: None,
        },
    );
    assert!(matches!(err, Err(CredError::Validation(_))));

    let err = add(
        &conn,
        &kc,
        AddCredentialInput {
            label: "unknown slug".into(),
            auth_kind: AuthKind::ApiKey,
            provider_slug: Some("not-a-provider".into()),
            custom_provider_id: None,
            scope: "agent".into(),
            api_key: Some(SecretString::new("sk-x1234567890".into())),
        },
    );
    assert!(matches!(err, Err(CredError::Validation(_))));
}

#[test]
fn sweep_removes_stale_config_dirs() {
    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("cache");
    let stale = IsolatedConfigDir::base_dir(&cache).join("dead-task");
    std::fs::create_dir_all(&stale).unwrap();
    std::fs::write(stale.join("junk"), "x").unwrap();
    IsolatedConfigDir::sweep(&cache);
    assert!(!IsolatedConfigDir::base_dir(&cache).exists());
}
