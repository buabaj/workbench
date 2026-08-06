//! Preflight: is this machine ready to run agent tasks? Rendered generically by
//! the frontend — one card per check, a button per FixAction — so new checks
//! need zero frontend work.

use serde::Serialize;

use super::discovery;

pub const MIN_VERSION: (u64, u64, u64) = (0, 7, 0);
pub const TESTED_MAX: (u64, u64, u64) = (0, 7, 999);

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    Ok,
    Warn,
    Fail,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum FixAction {
    CopyCommand { label: String, command: String },
    PickExecutable,
    Rescan,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub id: String,
    pub level: Level,
    pub title: String,
    pub detail: Option<String>,
    pub fix: Option<FixAction>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightReport {
    pub ready: bool,
    pub checks: Vec<Check>,
    pub resolved: Option<discovery::ResolvedAgent>,
    pub generated_at: i64,
}

const INSTALL_CMD: &str = "curl -fsSL https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent/main/install.sh | bash";

fn parse_semver(v: &str) -> Option<(u64, u64, u64)> {
    let mut it = v.split('.');
    Some((
        it.next()?.parse().ok()?,
        it.next()?.parse().ok()?,
        it.next()?.parse().ok()?,
    ))
}

pub async fn run(override_path: Option<String>) -> PreflightReport {
    let mut checks = Vec::new();

    let resolved = discovery::discover(override_path.as_deref()).await;

    match &resolved {
        Some(agent) => {
            checks.push(Check {
                id: "executable".into(),
                level: Level::Ok,
                title: format!("prime-agent found ({})", agent.source),
                detail: Some(agent.program.to_string_lossy().into_owned()),
                fix: None,
            });
            match agent.version.as_deref().and_then(parse_semver) {
                Some(v) if v < MIN_VERSION => checks.push(Check {
                    id: "version".into(),
                    level: Level::Fail,
                    title: format!(
                        "prime-agent {}.{}.{} is too old (need ≥ {}.{}.{})",
                        v.0, v.1, v.2, MIN_VERSION.0, MIN_VERSION.1, MIN_VERSION.2
                    ),
                    detail: None,
                    fix: Some(FixAction::CopyCommand {
                        label: "Copy update command".into(),
                        command: "prime-agent update".into(),
                    }),
                }),
                Some(v) if v > TESTED_MAX => checks.push(Check {
                    id: "version".into(),
                    level: Level::Warn,
                    title: format!(
                        "prime-agent {}.{}.{} is newer than tested — proceeding",
                        v.0, v.1, v.2
                    ),
                    detail: None,
                    fix: None,
                }),
                Some(v) => checks.push(Check {
                    id: "version".into(),
                    level: Level::Ok,
                    title: format!("version {}.{}.{}", v.0, v.1, v.2),
                    detail: None,
                    fix: None,
                }),
                None => checks.push(Check {
                    id: "version".into(),
                    level: Level::Warn,
                    title: "could not determine version".into(),
                    detail: None,
                    fix: Some(FixAction::Rescan),
                }),
            }
        }
        None => {
            checks.push(Check {
                id: "executable".into(),
                level: Level::Fail,
                title: "prime-agent is not installed (or not findable)".into(),
                detail: Some("Workbench drives the host-installed prime-agent CLI.".into()),
                fix: Some(FixAction::CopyCommand {
                    label: "Copy install command".into(),
                    command: INSTALL_CMD.into(),
                }),
            });
            checks.push(Check {
                id: "executable-pick".into(),
                level: Level::Warn,
                title: "already installed somewhere unusual?".into(),
                detail: None,
                fix: Some(FixAction::PickExecutable),
            });
        }
    }

    let (kernel_ok, kernel_detail) = discovery::kernel_status();
    checks.push(Check {
        id: "kernel".into(),
        level: if kernel_ok { Level::Ok } else { Level::Warn },
        title: if kernel_ok {
            "Python kernel ready".into()
        } else {
            "Python kernel not bootstrapped".into()
        },
        detail: Some(kernel_detail),
        fix: if kernel_ok {
            None
        } else {
            Some(FixAction::CopyCommand {
                label: "Copy bootstrap command".into(),
                command: "prime-agent -p 'hello'".into(),
            })
        },
    });

    let auth = super::oauth_discovery::discover();
    checks.push(Check {
        id: "auth".into(),
        level: if auth.is_empty() { Level::Warn } else { Level::Ok },
        title: if auth.is_empty() {
            "no host credentials found".into()
        } else {
            format!(
                "host credentials: {}",
                auth.iter()
                    .map(|a| a.provider_slug.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        },
        detail: Some("add keys in Settings → Providers, or use existing host sessions".into()),
        fix: None,
    });

    let ready = checks
        .iter()
        .all(|c| c.level != Level::Fail);

    PreflightReport {
        ready,
        checks,
        resolved,
        generated_at: crate::db::now_ms(),
    }
}
