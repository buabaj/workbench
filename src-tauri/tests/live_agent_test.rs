//! Live integration against the host-installed prime-agent. Ignored by default
//! (`cargo test -- --ignored`) since it needs the real CLI plus a working
//! credential; it is the end-to-end proof that a SpawnPlan actually launches a
//! usable agent under config-dir isolation.

use std::time::Duration;

use workbench_lib::agent::child::TokioChild;
use workbench_lib::agent::dispatch::Dispatcher;
use workbench_lib::agent::spawn::{build_spawn_plan, EnvValue, SpawnContext};
use workbench_lib::creds::keychain::MemKeychain;
use workbench_lib::creds::store::{add, AddCredentialInput, AuthKind};
use workbench_lib::profiles::{upsert_agent_profile, AgentProfileInput};
use workbench_lib::secret::SecretString;
use serde_json::json;

fn prime_agent_path() -> Option<std::path::PathBuf> {
    for dir in ["/opt/homebrew/bin", "/usr/local/bin"] {
        let p = std::path::Path::new(dir).join("prime-agent");
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Reads the ambient Prime Inference key from ~/.prime/config.json so the test
/// can exercise a real provider without any test-only credential setup.
fn ambient_prime_key() -> Option<String> {
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from)?;
    let bytes = std::fs::read(home.join(".prime/config.json")).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    v.get("api_key")?.as_str().map(String::from)
}

#[tokio::test]
#[ignore = "requires host prime-agent + credential"]
async fn spawn_plan_launches_a_working_agent() {
    let Some(program) = prime_agent_path() else {
        eprintln!("prime-agent not found; skipping");
        return;
    };
    let Some(key) = ambient_prime_key() else {
        eprintln!("no ambient prime key; skipping");
        return;
    };

    let dir = tempfile::tempdir().unwrap();
    let conn = workbench_lib::db::open(&dir.path().join("t.db")).unwrap();
    let kc = MemKeychain::default();

    let cred = add(
        &conn,
        &kc,
        AddCredentialInput {
            label: "live prime".into(),
            auth_kind: AuthKind::ApiKey,
            provider_slug: Some("prime-inference".into()),
            custom_provider_id: None,
            scope: "agent".into(),
            api_key: Some(SecretString::new(key)),
        },
    )
    .unwrap();
    let profile = upsert_agent_profile(
        &conn,
        AgentProfileInput {
            id: None,
            label: "live".into(),
            credential_profile_id: cred.id,
            model_id: None,
            thinking_level: None,
        },
    )
    .unwrap();

    let cache = dir.path().join("cache");
    let real_agent_dir = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap()
        .join(".prime/agent");
    let sessions = dir.path().join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();

    let ctx = SpawnContext {
        app_cache: &cache,
        real_agent_dir: &real_agent_dir,
        program,
        path_env: std::env::var("PATH").unwrap_or_default(),
        session_dir: &sessions,
        workspace_root: &sessions,
    };
    let plan = build_spawn_plan(&conn, &kc, &profile.id, "live-task", &ctx).unwrap();

    // Launch exactly the way the supervisor does.
    let mut cmd = tokio::process::Command::new(&plan.program);
    cmd.args(&plan.args).current_dir(dir.path()).env_clear();
    for (k, v) in &plan.env_set {
        match v {
            EnvValue::Plain(p) => cmd.env(k, p),
            EnvValue::Secret(s) => cmd.env(k, s.expose()),
        };
    }
    let (child, output) = TokioChild::spawn(cmd).expect("spawn");
    let (d, _stream) = Dispatcher::start(Box::new(child), output);

    let state = d
        .request("get_state", json!({}), Duration::from_secs(60))
        .await
        .unwrap_or_else(|e| panic!("get_state failed: {e} — stderr: {}", d.stderr_tail()));
    assert!(state.success);
    let data = state.data.expect("state data");
    let model = data["model"]["id"].as_str().unwrap_or_default();
    assert!(!model.is_empty(), "no model resolved: {data}");
    eprintln!("live agent ready — model {model}, session {}", data["sessionId"]);

    // The isolated dir carried the env-var NAME, never the key.
    let auth = std::fs::read_to_string(plan.config_dir.as_ref().unwrap().agent_dir().join("auth.json")).unwrap();
    assert!(auth.contains("WORKBENCH_PROVIDER_KEY"));
    assert!(!auth.contains("pit_"));

    d.kill();
}
