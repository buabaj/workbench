import { useCallback, useEffect, useState } from "react";
import { AgentActivity } from "./components/AgentActivity";
import { DotMatrix } from "./components/DotMatrix";
import { EditorPane } from "./components/EditorPane";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FileTree } from "./components/FileTree";
import { LinksPanel } from "./components/LinksPanel";
import { Palette, type PaletteMode } from "./components/Palette";
import { PreflightPanel } from "./components/Preflight";
import { ReviewPanel } from "./components/ReviewPanel";
import { SettingsSheet } from "./components/SettingsSheet";
import { TabStrip } from "./components/TabStrip";
import { VoiceButton } from "./components/VoiceButton";
import { ipc, onFsChanged, type WorkspaceView } from "./ipc/client";
import { useLayout } from "./store/layout";
import { useTasks } from "./store/tasks";
import { useVoice } from "./store/voice";
import { useWorkspace } from "./store/workspace";

/** The centre when the chat tab is active: the conversation, at a reading
 *  measure, instead of a cramped box at the bottom of the window. */
function ChatView() {
  const status = useTasks((s) => s.status);
  return (
    <div style={{ maxWidth: "var(--w-chat)", margin: "0 auto", padding: "var(--s-8) var(--s-6)" }}>
      {status === "idle" ? (
        <div style={{ color: "var(--ink-muted)" }}>
          <div
            style={{
              fontFamily: "var(--serif)",
              fontVariationSettings: "var(--serif-settings)",
              fontSize: "var(--display-sm)",
              color: "var(--ink)",
              letterSpacing: "var(--track-snug)",
              marginBottom: "var(--s-2)",
            }}
          >
            What are we working on?
          </div>
          <div style={{ fontSize: "var(--text-base)" }}>
            Describe a task below, or open a file from the sidebar.
          </div>
        </div>
      ) : (
        <AgentActivity />
      )}
    </div>
  );
}

export default function App() {
  const workspace = useWorkspace((s) => s.workspace);
  const pickWorkspace = useWorkspace((s) => s.pickWorkspace);
  const openWorkspace = useWorkspace((s) => s.openWorkspace);
  const refreshPreflight = useWorkspace((s) => s.refreshPreflight);
  const handleFsChanged = useWorkspace((s) => s.handleFsChanged);

  const tabs = useLayout((s) => s.tabs);
  const activeTabId = useLayout((s) => s.activeTabId);
  const railOpen = useLayout((s) => s.railOpen);
  const inspectorOpen = useLayout((s) => s.inspectorOpen);
  const toggleRail = useLayout((s) => s.toggleRail);
  const toggleInspector = useLayout((s) => s.toggleInspector);
  const focusChat = useLayout((s) => s.focusChat);
  const cycleTab = useLayout((s) => s.cycleTab);
  const closeTab = useLayout((s) => s.closeTab);
  const openSettingsTab = useLayout((s) => s.openSettings);

  const taskStatus = useTasks((s) => s.status);
  const matrix = useTasks((s) => s.matrix);
  const resolvedProfile = useTasks((s) => s.resolvedProfile);
  const profileMissing = useTasks((s) => s.profileMissing);
  const refreshProfile = useTasks((s) => s.refreshProfile);
  const runTask = useTasks((s) => s.runTask);

  const voicePhase = useVoice((s) => s.phase);
  const voiceElapsed = useVoice((s) => s.elapsedMs);
  const voiceLevel = useVoice((s) => s.level);
  const voiceError = useVoice((s) => s.error);
  const voiceCapability = useVoice((s) => s.capability);
  const toggleVoice = useVoice((s) => s.toggle);
  const cancelVoice = useVoice((s) => s.cancel);
  const refreshVoiceCapability = useVoice((s) => s.refreshCapability);

  const [prompt, setPrompt] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [recent, setRecent] = useState<WorkspaceView[]>([]);

  const activeTab = tabs.find((t) => t.id === activeTabId);

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

  // Transcript arrives as ordinary editable text. There is deliberately no
  // path from here to submitting the task.
  const insertTranscript = useCallback(
    (text: string) => setPrompt((p) => (p ? `${p.trimEnd()} ${text}` : text)),
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === "p") {
        e.preventDefault();
        setPalette(e.shiftKey ? "commands" : "files");
      } else if (k === "l" && !e.shiftKey) {
        e.preventDefault();
        focusChat();
      } else if (k === "b") {
        e.preventDefault();
        if (e.altKey) toggleInspector();
        else toggleRail();
      } else if (k === ",") {
        e.preventDefault();
        openSettingsTab();
      } else if (k === "w") {
        e.preventDefault();
        closeTab(useLayout.getState().activeTabId);
      } else if (e.shiftKey && (k === "]" || k === "[")) {
        e.preventDefault();
        cycleTab(k === "]" ? 1 : -1);
      } else if (e.shiftKey && k === "v") {
        e.preventDefault();
        void toggleVoice(insertTranscript);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    focusChat,
    toggleRail,
    toggleInspector,
    openSettingsTab,
    closeTab,
    cycleTab,
    toggleVoice,
    insertTranscript,
  ]);

  const busy = taskStatus === "starting" || taskStatus === "running";
  const canRun = Boolean(workspace && resolvedProfile && prompt.trim() && !busy);

  const submit = () => {
    if (!canRun || !workspace) return;
    const p = prompt.trim();
    setPrompt("");
    focusChat(); // sending from a file tab lands you where the answer appears
    void runTask(workspace.id, p);
  };

  return (
    <div
      className="app"
      style={{
        gridTemplateColumns: `${railOpen ? "auto" : "0"} 1fr ${inspectorOpen ? "auto" : "0"}`,
      }}
    >
      <header className="bar" data-tauri-drag-region>
        <span className="bar-ws" data-tauri-drag-region>
          Workbench{workspace && <span className="dim"> / {workspace.name}</span>}
        </span>
        <div
          className="bar-search"
          role="button"
          tabIndex={0}
          onClick={() => setPalette("files")}
          onKeyDown={(e) => {
            if (e.key === "Enter") setPalette("files");
          }}
        >
          <span>Go to file…</span>
          <kbd>⌘P</kbd>
        </div>
        <button className="btn icon" onClick={toggleRail} aria-label="Toggle sidebar" title="Toggle sidebar (⌘B)">
          <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden>
            <rect x="1.5" y="2.5" width="12" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <path d="M5.5 2.5v10" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
        <button
          className="btn icon"
          onClick={toggleInspector}
          aria-label="Toggle inspector"
          title="Toggle inspector (⌥⌘B)"
        >
          <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden>
            <rect x="1.5" y="2.5" width="12" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <path d="M9.5 2.5v10" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
        <button className="btn icon" onClick={() => setSettingsOpen(true)} aria-label="Providers" title="Providers">
          <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden>
            <circle cx="7.5" cy="7.5" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <path
              d="M7.5 1.5v1.6M7.5 11.9v1.6M13.5 7.5h-1.6M3.1 7.5H1.5M11.7 3.3l-1.1 1.1M4.4 10.6l-1.1 1.1M11.7 11.7l-1.1-1.1M4.4 4.4L3.3 3.3"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </header>

      {railOpen && (
        <nav className="rail" aria-label="Workspace">
          <ErrorBoundary>
            {workspace ? (
              <div className="rail-section">
                <h3>Files</h3>
                <FileTree />
              </div>
            ) : (
              <>
                <div className="rail-section">
                  <h3>Workspace</h3>
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
                    <span className="label">Open folder…</span>
                  </div>
                </div>
                {recent.length > 0 && (
                  <div className="rail-section">
                    <h3>Recent</h3>
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
                        <span className="label">{w.name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </ErrorBoundary>
        </nav>
      )}

      <div className="center">
        <TabStrip />
        <main className="canvas" aria-label="Main">
          <ErrorBoundary>
            {activeTab?.kind === "file" ? (
              <EditorPane />
            ) : activeTab?.kind === "settings" ? (
              <div style={{ maxWidth: 640, margin: "0 auto", padding: "var(--s-8) var(--s-6)" }}>
                <PreflightPanel />
              </div>
            ) : (
              <ChatView />
            )}
          </ErrorBoundary>
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
                <b>{profileMissing ? "set up a provider…" : "resolving…"}</b>
              )}
            </span>
            {resolvedProfile && <span className="chip origin">{resolvedProfile.origin} default</span>}
            {voiceError && <span style={{ color: "var(--error)", fontSize: "var(--text-xs)" }}>{voiceError}</span>}
          </div>
          <div className="composer-row">
            <input
              className="composer-input"
              placeholder={workspace ? "Describe a task…" : "Open a workspace to run tasks"}
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
              {busy ? "Running…" : "Send"}
            </button>
          </div>
        </footer>
      </div>

      {inspectorOpen && (
        <aside className="inspector" aria-label="Inspector">
          <ErrorBoundary>
            <section className="panel" aria-labelledby="p-agent">
              <h3 id="p-agent">Agent</h3>
              <div className="state-row">
                <DotMatrix state={matrix} />
                <div className="state-sub">{taskStatus}</div>
              </div>
            </section>
            <section className="panel" aria-labelledby="p-review">
              <h3 id="p-review">Task review</h3>
              <ReviewPanel />
            </section>
            <section className="panel" aria-labelledby="p-links">
              <h3 id="p-links">Linked evidence</h3>
              <LinksPanel />
            </section>
          </ErrorBoundary>
        </aside>
      )}

      {settingsOpen && <SettingsSheet onClose={() => setSettingsOpen(false)} />}
      {palette && <Palette mode={palette} onClose={() => setPalette(null)} />}
    </div>
  );
}
