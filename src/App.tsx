import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChatView, PLACEHOLDER } from "./components/ChatView";
import { ArrowUp, Moon, PanelLeft, PanelRight, Settings, SquareTerminal, Sun } from "lucide-react";
import { AgentOrb, PHASE_LABEL } from "./components/AgentOrb";
import { EditorPane } from "./components/EditorPane";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FileTree } from "./components/FileTree";
import { LinksPanel } from "./components/LinksPanel";
import { Palette, type PaletteMode } from "./components/Palette";
import { ReviewPanel } from "./components/ReviewPanel";
import { SessionsPanel } from "./components/SessionsPanel";
import { SettingsView } from "./components/SettingsView";
import { SlashMenu } from "./components/SlashMenu";
import { TabStrip } from "./components/TabStrip";
import { VoiceButton } from "./components/VoiceButton";
import { formatError, ipc, onFsChanged, type AgentCommand, type WorkspaceView } from "./ipc/client";
import { useLayout } from "./store/layout";
import { useTheme } from "./store/theme";
import { useChat } from "./store/chat";
import { useVoice } from "./store/voice";
import { useWorkspace } from "./store/workspace";

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

  const chatStatus = useChat((s) => s.status);
  const chatPhase = useChat((s) => s.phase);
  const resolvedProfile = useChat((s) => s.resolvedProfile);
  const refreshProfile = useChat((s) => s.refreshProfile);
  const sendMessage = useChat((s) => s.send);
  const newConversation = useChat((s) => s.newConversation);

  const voicePhase = useVoice((s) => s.phase);
  const voiceElapsed = useVoice((s) => s.elapsedMs);
  const voiceLevels = useVoice((s) => s.levels);
  const voiceError = useVoice((s) => s.error);
  const voiceCapability = useVoice((s) => s.capability);
  const toggleVoice = useVoice((s) => s.toggle);
  const cancelVoice = useVoice((s) => s.cancel);
  const refreshVoiceCapability = useVoice((s) => s.refreshCapability);

  const [prompt, setPrompt] = useState("");
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [recent, setRecent] = useState<WorkspaceView[]>([]);
  const [commandNote, setCommandNote] = useState<string | null>(null);

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

  // Grow the composer with the text instead of scrolling it sideways. Reset to
  // auto first so it shrinks back when lines are deleted.
  useLayoutEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [prompt]);

  // A leading "/" with no space yet means the user is picking a command.
  const slashQuery = /^\/[^\s]*$/.test(prompt) ? prompt : null;

  const runCommand = async (cmd: AgentCommand) => {
    if (cmd.kind === "skill") {
      // Skills are interpreted by the agent, so they go into the prompt.
      setPrompt(`/${cmd.name} `);
      promptRef.current?.focus();
      return;
    }
    setPrompt("");
    if (cmd.name === "new") {
      void newConversation();
      return;
    }
    const id = useChat.getState().taskId;
    if (!id) {
      setCommandNote("Start a conversation first — there's no agent running yet.");
      return;
    }
    try {
      await ipc.agentAction(id, cmd.name, null);
      setCommandNote(`/${cmd.name} ran.`);
    } catch (e) {
      setCommandNote(formatError(e));
    }
    window.setTimeout(() => setCommandNote(null), 4000);
  };

  const busy = chatStatus === "starting" || chatStatus === "streaming";
  const canRun = Boolean(workspace && resolvedProfile && prompt.trim() && !busy);

  const submit = () => {
    if (!canRun || !workspace) return;
    const p = prompt.trim();
    setPrompt("");
    focusChat(); // sending from a file tab lands you where the answer appears
    void sendMessage(workspace.id, p);
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
        <TabStrip onNewConversation={() => void newConversation()} />
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
          {commandNote && (
            <div className="composer-meta" role="status">
              <span style={{ color: "var(--ink-muted)", fontSize: "var(--text-xs)" }}>{commandNote}</span>
            </div>
          )}
          <div className="composer-row" style={{ position: "relative" }}>
            {slashQuery && (
              <SlashMenu
                query={slashQuery}
                onPick={(c) => void runCommand(c)}
                onClose={() => setPrompt("")}
              />
            )}
            <textarea
              ref={promptRef}
              className="composer-input"
              rows={1}
              placeholder={workspace ? PLACEHOLDER : "Open a workspace to run tasks"}
              value={prompt}
              disabled={!workspace || busy}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                // While the slash menu is open it owns Enter/arrows.
                if (slashQuery) return;
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
                  <AgentOrb phase={chatPhase} />
                  <div style={{ flex: 1 }}>
                    <div className="state-label" role="status" aria-live="polite">
                      {PHASE_LABEL[chatPhase]}
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
            <section className="panel" aria-labelledby="p-sessions">
              <h3 id="p-sessions">Conversations</h3>
              <SessionsPanel />
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
