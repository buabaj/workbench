import { useCallback, useEffect, useState } from "react";
import { AgentActivity } from "./components/AgentActivity";
import { ArrowUp, Moon, PanelLeft, PanelRight, Settings, SquareTerminal, Sun } from "lucide-react";
import { AgentOrb, PHASE_LABEL, phaseFromTask } from "./components/AgentOrb";
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
        <span style={{ marginLeft: "auto" }} />
        <button className="btn icon" onClick={toggleRail} aria-label="Toggle sidebar" title="Toggle sidebar (⌘B)">
          <PanelLeft size={15} strokeWidth={1.6} />
        </button>
        <button
          className="btn icon"
          onClick={toggleInspector}
          aria-label="Toggle inspector"
          title="Toggle inspector (⌥⌘B)"
        >
          <PanelRight size={15} strokeWidth={1.6} />
        </button>
        <button
          className="btn icon"
          onClick={() => {}}
          aria-label="Toggle terminal"
          title="Terminal — arriving in the next pass"
          disabled
        >
          <SquareTerminal size={15} strokeWidth={1.6} />
        </button>
        <button
          className="btn icon"
          onClick={toggleTheme}
          aria-label={`Switch to ${resolvedTheme === "dark" ? "light" : "dark"} theme`}
          title={`Switch to ${resolvedTheme === "dark" ? "light" : "dark"} theme`}
        >
          {resolvedTheme === "dark" ? <Sun size={15} strokeWidth={1.6} /> : <Moon size={15} strokeWidth={1.6} />}
        </button>
        <button className="btn icon" onClick={openSettingsTab} aria-label="Settings" title="Settings (⌘,)">
          <Settings size={15} strokeWidth={1.6} />
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
              {busy ? <AgentOrb phase="thinking" /> : <ArrowUp size={16} strokeWidth={2} />}
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
                  <AgentOrb phase={phaseFromTask(taskStatus, matrix)} />
                  <div style={{ flex: 1 }}>
                    <div className="state-label" role="status" aria-live="polite">
                      {PHASE_LABEL[phaseFromTask(taskStatus, matrix)]}
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
