import { useCallback, useEffect, useState } from "react";
import { AgentActivity } from "./components/AgentActivity";
import { DotMatrix } from "./components/DotMatrix";
import { EditorPane } from "./components/EditorPane";
import { FileTree } from "./components/FileTree";
import { LinksPanel } from "./components/LinksPanel";
import { PreflightPanel } from "./components/Preflight";
import { ReviewPanel } from "./components/ReviewPanel";
import { SettingsSheet } from "./components/SettingsSheet";
import { onFsChanged } from "./ipc/client";
import { useTasks } from "./store/tasks";
import { useVoice } from "./store/voice";
import { useWorkspace } from "./store/workspace";

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export default function App() {
  const workspace = useWorkspace((s) => s.workspace);
  const mode = useWorkspace((s) => s.mode);
  const active = useWorkspace((s) => s.active);
  const setMode = useWorkspace((s) => s.setMode);
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
          {workspace ? `workbench · ${workspace.name}` : "workbench"}
        </span>
        <div className="bar-mode">
          <button className={mode === "code" ? "on" : ""} onClick={() => setMode("code")}>
            CODE
          </button>
          <button className={mode === "research" ? "on" : ""} onClick={() => setMode("research")}>
            RESEARCH
          </button>
        </div>
        <div className="bar-search">⌘K — search workspace…</div>
      </header>

      <nav className="rail">
        {workspace ? (
          <div className="rail-section">
            <h3>{workspace.name.toUpperCase()}</h3>
            <FileTree />
          </div>
        ) : (
          <div className="rail-section">
            <h3>WORKSPACE</h3>
            <div className="rail-item" onClick={() => void pickWorkspace()}>
              Open folder…
            </div>
          </div>
        )}
      </nav>

      <main className="canvas">
        {active ? (
          <EditorPane />
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

      <aside className="inspector">
        <div className="panel">
          <h3>AGENT ACTIVITY</h3>
          <AgentActivity />
        </div>
        <div className="panel">
          <h3>TASK REVIEW</h3>
          <ReviewPanel />
        </div>
        <div className="panel">
          <h3>CONTEXT SHELF</h3>
          <div className="panel-empty">Select text in a document or file, then add it as context.</div>
        </div>
        <div className="panel">
          <h3>LINKED EVIDENCE</h3>
          <LinksPanel />
        </div>
      </aside>

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
            <span style={{ color: "var(--danger)", fontSize: 10.5 }}>{voiceError}</span>
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
          {voicePhase === "recording" ? (
            <>
              <button
                className="btn"
                style={{ color: "var(--danger)", borderColor: "var(--danger)" }}
                onClick={() => void toggleVoice(insertTranscript)}
                title="Stop and transcribe (⌘⇧V)"
              >
                ■ {formatElapsed(voiceElapsed)}
                <span
                  aria-hidden
                  style={{
                    display: "inline-block",
                    width: 4,
                    height: 4,
                    marginLeft: 6,
                    borderRadius: "50%",
                    background: "var(--danger)",
                    opacity: 0.35 + Math.min(voiceLevel * 3, 0.65),
                  }}
                />
              </button>
              <button className="btn" onClick={() => void cancelVoice()} title="Discard">
                ✕
              </button>
            </>
          ) : (
            <button
              className="btn"
              disabled={voicePhase === "transcribing" || !voiceCapability?.configured}
              onClick={() => void toggleVoice(insertTranscript)}
              title={
                voiceCapability?.configured
                  ? "Record and transcribe (⌘⇧V)"
                  : "Configure voice transcription in settings"
              }
            >
              {voicePhase === "transcribing" ? "transcribing…" : "◉ voice"}
            </button>
          )}
          <button className="btn primary" disabled={!canRun} onClick={submit}>
            {busy ? "Running…" : "Run task"}
          </button>
        </div>
      </footer>

      {settingsOpen && <SettingsSheet onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
