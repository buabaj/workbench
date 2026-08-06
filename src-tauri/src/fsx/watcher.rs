//! Workspace file watcher: notify (FSEvents on macOS) with 300ms coalescing.
//! Changes are emitted as a coarse `fs://changed` event carrying relative
//! paths; the frontend refreshes the tree and re-stats open buffers.

use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use notify::Watcher as _;
use tauri::Emitter;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChanged {
    pub workspace_id: String,
    pub paths: Vec<String>,
    pub overflow: bool,
}

pub struct WorkspaceWatcher {
    // Held for lifetime; dropping stops the watch.
    _watcher: notify::RecommendedWatcher,
    stop_tx: mpsc::Sender<()>,
}

impl WorkspaceWatcher {
    pub fn start(
        app: tauri::AppHandle,
        workspace_id: String,
        root: PathBuf,
    ) -> notify::Result<Self> {
        let (event_tx, event_rx) = mpsc::channel::<notify::Result<notify::Event>>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();

        let mut watcher = notify::recommended_watcher(move |res| {
            let _ = event_tx.send(res);
        })?;
        watcher.watch(&root, notify::RecursiveMode::Recursive)?;

        let root_for_thread = root.clone();
        std::thread::spawn(move || {
            let mut pending: std::collections::BTreeSet<String> = Default::default();
            let mut overflow = false;
            loop {
                // Block for the first event, then coalesce for 300ms.
                let first = match event_rx.recv_timeout(Duration::from_millis(500)) {
                    Ok(ev) => Some(ev),
                    Err(mpsc::RecvTimeoutError::Timeout) => None,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                };
                if stop_rx.try_recv().is_ok() {
                    break;
                }
                let Some(first) = first else { continue };
                collect(&root_for_thread, first, &mut pending, &mut overflow);
                let deadline = std::time::Instant::now() + Duration::from_millis(300);
                while let Ok(ev) = event_rx.recv_timeout(
                    deadline.saturating_duration_since(std::time::Instant::now()),
                ) {
                    collect(&root_for_thread, ev, &mut pending, &mut overflow);
                }
                if !pending.is_empty() || overflow {
                    let payload = FsChanged {
                        workspace_id: workspace_id.clone(),
                        paths: std::mem::take(&mut pending).into_iter().collect(),
                        overflow: std::mem::take(&mut overflow),
                    };
                    let _ = app.emit("fs://changed", payload);
                }
            }
        });

        Ok(WorkspaceWatcher {
            _watcher: watcher,
            stop_tx,
        })
    }
}

impl Drop for WorkspaceWatcher {
    fn drop(&mut self) {
        let _ = self.stop_tx.send(());
    }
}

fn collect(
    root: &PathBuf,
    res: notify::Result<notify::Event>,
    pending: &mut std::collections::BTreeSet<String>,
    overflow: &mut bool,
) {
    match res {
        Ok(event) => {
            if matches!(event.kind, notify::EventKind::Other) && event.need_rescan() {
                *overflow = true;
            }
            for path in event.paths {
                if path.components().any(|c| c.as_os_str() == ".git") {
                    continue;
                }
                if let Ok(rel) = path.strip_prefix(root) {
                    let rel = rel
                        .components()
                        .map(|c| c.as_os_str().to_string_lossy())
                        .collect::<Vec<_>>()
                        .join("/");
                    if !rel.is_empty() {
                        pending.insert(rel);
                    }
                }
            }
        }
        Err(_) => *overflow = true,
    }
}
