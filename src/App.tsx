import { useCallback, useEffect, useState } from "react";
import { AgentActivity } from "./components/AgentActivity";
import { DotMatrix } from "./components/DotMatrix";
import { EditorPane } from "./components/EditorPane";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FileTree } from "./components/FileTree";
import { LinksPanel } from "./components/LinksPanel";
import { PreflightPanel } from "./components/Preflight";
import { ReviewPanel } from "./components/ReviewPanel";
import { SettingsSheet } from "./components/SettingsSheet";
import { VoiceButton } from "./components/VoiceButton";
import { ipc, onFsChanged, type WorkspaceView } from "./ipc/client";
import { useTasks } from "./store/tasks";
import { useVoice } from "./store/voice";
import { useWorkspace } from "./store/workspace";

export default function App() {
  const workspace = useWorkspace((s) => s.workspace);
  const active = useWorkspace((s) => s.active);
  const pickWorkspace = useWorkspace((s) => s.pickWorkspace);
  const refreshPreflight = useWorkspace((s) => s.refreshPreflight);
  const handleFsChanged = useWorkspace((s) => s.handleFsChanged);

  const taskStatus = useTasks((s) => s.status);
  const resolvedProfile = useTasks((s) => s.resolvedProfile);
  const profileMissing = useTasks((s) => s.profileMissing);
  const refreshProfile = useTasks((s) => s.refreshProfile);
  const runTask = useTasks((s) => s.runTask);

  const [prompt, setPrompt] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [recent, setRecent] = useState<WorkspaceView[]>([]);
  const openWorkspace = useWorkspace((s) => s.openWorkspace);

  const voicePhase = useVoice((s) => s.phase);
  const voiceElapsed = useVoice((s) => s.elapsedMs);
  const voiceLevel = useVoice((s) => s.level);
  const voiceError = useVoice((s) => s.error);
  const voiceCapability = useVoice((s) => s.capability);
  const toggleVoice = useVoice((s) => s.toggle);
  const cancelVoice = useVoice((s) => s.cancel);
  const refreshVoiceCapability = useVoice((s) => s.refreshCapability);

  useEffect(() => {
    void refreshPreflight();
    void ipc.workspaceRecent().then(setRecent).catch(() => {});
    const un = onFsChanged(handleFsChanged);
    return () => {
      void un.then((f) => f());
    };
  }, [refreshPreflight, handleFsChanged]);

  useEffect(() => {
    void refreshProfile(workspace?.id ?? null);
  }, [workspace?.id, refreshProfile]);

  useEffect(() => {
    void refreshVoiceCapability();
  }, [refreshVoiceCapability, settingsOpen]);

  // Transcript arrives as ordinary editable text appended to the composer.
  // There is deliberately no path from here to submitting the task.
  const insertTranscript = useCallback(
    (text: string) => setPrompt((p) => (p ? `${p.trimEnd()} ${text}` : text)),
    [],
  );

  // ⌘⇧V toggles recording — click-to-start/stop, never hold-to-talk.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "v") {
        e.preventDefault();
        void toggleVoice(insertTranscript);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleVoice, insertTranscript]);

  const busy = taskStatus === "starting" || taskStatus === "running";
  const canRun = Boolean(workspace && resolvedProfile && prompt.trim() && !busy);

  const submit = () => {
    if (!canRun || !workspace) return;
    const p = prompt.trim();
    setPrompt("");
    void runTask(workspace.id, p);
  };

  return (
    <div className="app">
      <header className="bar" data-tauri-drag-region>
        <span className="bar-ws" data-tauri-drag-region>
          Workbench{workspace && <span className="dim"> / {workspace.name}</span>}
        </span>
        <div className="bar-search" role="button" tabIndex={0}>
          <span>Search files…</span>
          <kbd>⌘P</kbd>
        </div>
      </header>

      <nav className="rail" aria-label="Workspace">
        <ErrorBoundary>
          {workspace ? (
            <div className="rail-section">
              <h3>{workspace.name.toUpperCase()}</h3>
              <FileTree />
            </div>
          ) : (
            <>
              <div className="rail-section">
                <h3>WORKSPACE</h3>
                <div
                  className="rail-item"
                  role="button"
                  tabIndex={0}
                  onClick={() => void pickWorkspace()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      void pickWorkspace();
                    }
                  }}
                >
                  Open folder…
                </div>
              </div>
              {recent.length > 0 && (
                <div className="rail-section">
                  <h3>RECENT</h3>
                  {recent.map((w) => (
                    <div
                      key={w.id}
                      className="rail-item"
                      role="button"
                      tabIndex={0}
                      title={w.rootPath}
                      onClick={() => void openWorkspace(w.rootPath)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          void openWorkspace(w.rootPath);
                        }
                      }}
                    >
                      {w.name}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </ErrorBoundary>
      </nav>

      <div className="center">
      <main className="canvas" aria-label="Editor">
        {active ? (
          <ErrorBoundary>
            <EditorPane />
          </ErrorBoundary>
        ) : (
          <div className="canvas-empty">
            <DotMatrix state="awaiting-input" />
            {workspace ? (
              <div className="serif">Select a file, or describe a task below.</div>
            ) : (
              <>
                <div className="serif">Open a workspace to begin.</div>
                <button className="btn" onClick={() => void pickWorkspace()}>
                  Open folder…
                </button>
              </>
            )}
            <PreflightPanel />
          </div>
        )}
      </main>

      <footer className="composer">
        <div className="composer-meta">
          <span
            className="chip"
            style={{ cursor: "pointer" }}
            onClick={() => setSettingsOpen(true)}
            title="Configure providers"
          >
            {resolvedProfile ? (
              <>
                <b>{resolvedProfile.profile.label}</b>
                {resolvedProfile.profile.modelId ? ` · ${resolvedProfile.profile.modelId}` : ""}
              </>
            ) : (
              <b>{profileMissing ? "set up a provider…" : "resolving profile…"}</b>
            )}
          </span>
          {resolvedProfile && (
            <span className="chip origin">{resolvedProfile.origin} default</span>
          )}
          {voiceError && (
            <span style={{ color: "var(--error)", fontSize: 10.5 }}>{voiceError}</span>
          )}
        </div>
        <div className="composer-row">
          <input
            className="composer-input"
            placeholder={
              workspace
                ? "Describe a task for the agent…"
                : "Open a workspace to run tasks"
            }
            value={prompt}
            disabled={!workspace || busy}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <VoiceButton
            phase={voicePhase}
            elapsedMs={voiceElapsed}
            level={voiceLevel}
            configured={Boolean(voiceCapability?.configured)}
            onToggle={() => void toggleVoice(insertTranscript)}
            onCancel={() => void cancelVoice()}
          />
          <button className="btn primary" disabled={!canRun} onClick={submit}>
            {busy ? "Running…" : "Run task"}
          </button>
        </div>
      </footer>
      </div>

      <aside className="inspector" aria-label="Inspector">
        <ErrorBoundary>
          <section className="panel" aria-labelledby="p-agent">
            <h3 id="p-agent">AGENT ACTIVITY</h3>
            <AgentActivity />
          </section>
          <section className="panel" aria-labelledby="p-review">
            <h3 id="p-review">TASK REVIEW</h3>
            <ReviewPanel />
          </section>
          <section className="panel" aria-labelledby="p-links">
            <h3 id="p-links">LINKED EVIDENCE</h3>
            <LinksPanel />
          </section>
        </ErrorBoundary>
      </aside>


      {settingsOpen && <SettingsSheet onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
