import { useCallback, useEffect, useState } from "react";
import { AgentActivity } from "./components/AgentActivity";
import { DotMatrix } from "./components/DotMatrix";
import { EditorPane } from "./components/EditorPane";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FileTree } from "./components/FileTree";
import { LinksPanel } from "./components/LinksPanel";
import { Palette, type PaletteMode } from "./components/Palette";
import { ReviewPanel } from "./components/ReviewPanel";
import { SettingsView } from "./components/SettingsView";
import { TabStrip } from "./components/TabStrip";
import { VoiceButton } from "./components/VoiceButton";
import { ipc, onFsChanged, type WorkspaceView } from "./ipc/client";
import { useLayout } from "./store/layout";
import { useTheme } from "./store/theme";
import { useTasks } from "./store/tasks";
import { useVoice } from "./store/voice";
import { useWorkspace } from "./store/workspace";

const STATUS_LABEL: Record<string, string> = {
  idle: "READY",
  starting: "STARTING",
  running: "WORKING",
  succeeded: "DONE",
  failed: "FAILED",
  cancelled: "STOPPED",
};

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

  const resolvedTheme = useTheme((s) => s.resolved);
  const toggleTheme = useTheme((s) => s.toggle);
  const initTheme = useTheme((s) => s.init);

  const taskStatus = useTasks((s) => s.status);
  const matrix = useTasks((s) => s.matrix);
  const resolvedProfile = useTasks((s) => s.resolvedProfile);
  const refreshProfile = useTasks((s) => s.refreshProfile);
  const runTask = useTasks((s) => s.runTask);

  const voicePhase = useVoice((s) => s.phase);
  const voiceElapsed = useVoice((s) => s.elapsedMs);
  const voiceLevels = useVoice((s) => s.levels);
  const voiceError = useVoice((s) => s.error);
  const voiceCapability = useVoice((s) => s.capability);
  const toggleVoice = useVoice((s) => s.toggle);
  const cancelVoice = useVoice((s) => s.cancel);
  const refreshVoiceCapability = useVoice((s) => s.refreshCapability);

  const [prompt, setPrompt] = useState("");
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [recent, setRecent] = useState<WorkspaceView[]>([]);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  useEffect(() => {
    initTheme();
    void refreshPreflight();
    void ipc.workspaceRecent().then(setRecent).catch(() => {});
    const un = onFsChanged(handleFsChanged);
    return () => {
      void un.then((f) => f());
    };
  }, [initTheme, refreshPreflight, handleFsChanged]);

  useEffect(() => {
    void refreshProfile(workspace?.id ?? null);
  }, [workspace?.id, refreshProfile]);

  useEffect(() => {
    void refreshVoiceCapability();
  }, [refreshVoiceCapability, activeTabId]);

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
        <button
          className="btn icon"
          onClick={() => {}}
          aria-label="Toggle terminal"
          title="Terminal — arriving in the next pass"
          disabled
        >
          <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden>
            <rect x="1.5" y="2.5" width="12" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <path d="M1.5 8.5h12" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
        <button
          className="btn icon"
          onClick={toggleTheme}
          aria-label={`Switch to ${resolvedTheme === "dark" ? "light" : "dark"} theme`}
          title={`Switch to ${resolvedTheme === "dark" ? "light" : "dark"} theme`}
        >
          {resolvedTheme === "dark" ? (
            <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden>
              <circle cx="7.5" cy="7.5" r="3" fill="none" stroke="currentColor" strokeWidth="1.2" />
              <path
                d="M7.5 1v1.8M7.5 12.2V14M14 7.5h-1.8M2.8 7.5H1M12.1 2.9l-1.3 1.3M4.2 10.8l-1.3 1.3M12.1 12.1l-1.3-1.3M4.2 4.2L2.9 2.9"
                stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"
              />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden>
              <path
                d="M12.5 9.3A5.5 5.5 0 0 1 5.7 2.5a5.5 5.5 0 1 0 6.8 6.8Z"
                fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"
              />
            </svg>
          )}
        </button>
        <button className="btn icon" onClick={openSettingsTab} aria-label="Settings" title="Settings (⌘,)">
          <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden>
            <circle cx="7.5" cy="7.5" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <path
              d="M7.5 1.5v1.6M7.5 11.9v1.6M13.5 7.5h-1.6M3.1 7.5H1.5M11.7 3.3l-1.1 1.1M4.4 10.6l-1.1 1.1M11.7 11.7l-1.1-1.1M4.4 4.4L3.3 3.3"
              stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"
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
              <SettingsView />
            ) : (
              <ChatView />
            )}
          </ErrorBoundary>
        </main>

        <footer className="composer">
          {voiceError && (
            <div className="composer-meta" role="alert">
              <span style={{ color: "var(--error)", fontSize: "var(--text-xs)" }}>{voiceError}</span>
            </div>
          )}
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
              levels={voiceLevels}
              configured={Boolean(voiceCapability?.configured)}
              onToggle={() => void toggleVoice(insertTranscript)}
              onCancel={() => void cancelVoice()}
            />
            <button
              className="btn primary send"
              disabled={!canRun}
              onClick={submit}
              aria-label={busy ? "Running" : "Send"}
              title={busy ? "Running…" : "Send (↵)"}
            >
              {busy ? (
                <span className="matrix animate" style={{ gridTemplateColumns: "repeat(3, 3px)" }}>
                  {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                    <i key={i} className={i % 3 === 1 ? "a" : ""} />
                  ))}
                </span>
              ) : (
                <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden>
                  <path d="M7.5 12V3M4 6.5L7.5 3l3.5 3.5" fill="none" stroke="currentColor"
                        strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          </div>
        </footer>
      </div>

      {inspectorOpen && (
        <aside className="inspector" aria-label="Inspector">
          <ErrorBoundary>
            <section className="panel" aria-labelledby="p-agent">
              <h3 id="p-agent">Agent</h3>
              <div className="card">
                <div className="state-row">
                  <DotMatrix state={matrix} />
                  <div style={{ flex: 1 }}>
                    <div className="state-label" role="status" aria-live="polite">
                      {STATUS_LABEL[taskStatus] ?? taskStatus}
                    </div>
                    <div className="state-sub">
                      {resolvedProfile
                        ? `${resolvedProfile.profile.label}${
                            resolvedProfile.profile.modelId ? ` · ${resolvedProfile.profile.modelId}` : ""
                          }`
                        : "no provider configured"}
                    </div>
                  </div>
                </div>
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

      {palette && <Palette mode={palette} onClose={() => setPalette(null)} />}
    </div>
  );
}
