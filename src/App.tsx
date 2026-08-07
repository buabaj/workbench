import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChatView, PLACEHOLDER } from "./components/ChatView";
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  Files,
  FilePlus,
  Library,
  Link2,
  NotebookPen,
  FolderPlus,
  GitBranch,
  Moon,
  PanelLeft,
  PanelRight,
  Search,
  Settings,
  SquareTerminal,
  Sun,
  X,
} from "lucide-react";
import { AgentOrb, PHASE_LABEL } from "./components/AgentOrb";
import { EditorPane } from "./components/EditorPane";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FileTree } from "./components/FileTree";
import { Palette, type PaletteMode } from "./components/Palette";
import { ReviewPanel } from "./components/ReviewPanel";
import { SessionsPanel } from "./components/SessionsPanel";
import { SettingsView } from "./components/SettingsView";
import { applyMention, mentionQueryAt } from "./chat/mentions";
import { MentionMenu } from "./components/MentionMenu";
import { ChangesPanel } from "./components/ChangesPanel";
import { BacklinksPanel } from "./research/BacklinksPanel";
import { LibraryPanel } from "./research/LibraryPanel";
import { NotesPanel } from "./research/NotesPanel";
import { SearchPanel } from "./components/SearchPanel";
import { SlashMenu } from "./components/SlashMenu";
import { TerminalDock } from "./terminal/TerminalDock";
import { TabStrip } from "./components/TabStrip";
import { VoiceButton } from "./components/VoiceButton";
import { formatError, ipc, onFsChanged, type AgentCommand, type WorkspaceView } from "./ipc/client";
import { findTemplate } from "./commands/prompts";
import { useLayout } from "./store/layout";
import { useTheme } from "./store/theme";
import { useChat } from "./store/chat";
import { useComposer } from "./store/composer";
import { useVoice } from "./store/voice";
import { useWorkspace } from "./store/workspace";

/** The rail's views. Icons only: a label per view costs width the tree needs. */
const RAIL_TABS = [
  { key: "files" as const, label: "Files", Icon: Files },
  { key: "search" as const, label: "Search (⇧⌘F)", Icon: Search },
  { key: "changes" as const, label: "Changes", Icon: GitBranch },
];

/** Research swaps the rail wholesale: a vault wants notes and links, not
 *  diffs. Search stays, because finding a passage matters more here, not less. */
const RESEARCH_TABS = [
  { key: "notes" as const, label: "Notes", Icon: NotebookPen },
  { key: "library" as const, label: "Find papers", Icon: Library },
  { key: "search" as const, label: "Search (⇧⌘F)", Icon: Search },
  { key: "links" as const, label: "Backlinks", Icon: Link2 },
];

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

  // Lives in a store, not local state: the editor's selection actions and the
  // voice transcript both put text here, and neither is a child of the composer.
  const prompt = useComposer((s) => s.text);
  const setPrompt = useComposer((s) => s.setText);
  const composerFocusTick = useComposer((s) => s.focusTick);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [recent, setRecent] = useState<WorkspaceView[]>([]);
  const [commandNote, setCommandNote] = useState<string | null>(null);
  const mode = useLayout((s) => s.mode);
  const setMode = useLayout((s) => s.setMode);
  const railTab = useLayout((s) => s.railTab);
  const setRailTab = useLayout((s) => s.setRailTab);
  const [creating, setCreating] = useState<"file" | "dir" | null>(null);
  const [sectionOpen, setSectionOpen] = useState(true);
  const [terminalOpen, setTerminalOpen] = useState(false);
  /** Mounted — and so still running — independently of being visible. */
  const [terminalAlive, setTerminalAlive] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(260);
  const activeMode = useChat((s) => s.mode);
  const activeOneShot = useChat((s) => s.oneShot);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  /** Keep the dock usable: never taller than most of the window, never a sliver. */
  const clampTerminal = (h: number) =>
    Math.max(120, Math.min(h, Math.round(window.innerHeight * 0.75)));

  // Pointer capture rather than window listeners: the drag keeps working when
  // the pointer crosses the terminal, which swallows events of its own.
  const startTerminalDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = terminalHeight;
    const onMove = (ev: PointerEvent) =>
      setTerminalHeight(clampTerminal(startH + (startY - ev.clientY)));
    const onUp = (ev: PointerEvent) => {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  };

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
  const insertTranscript = useCallback((text: string) => {
    const current = useComposer.getState().text;
    useComposer.getState().setText(current ? `${current.trimEnd()} ${text}` : text);
  }, []);

  // Something asked for the caret — the selection bubble, or a voice insert.
  useEffect(() => {
    if (composerFocusTick === 0) return;
    const el = promptRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [composerFocusTick]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && e.key === "`") {
        e.preventDefault();
        setTerminalAlive(true);
        setTerminalOpen((v) => !v);
        return;
      }
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
      } else if (e.shiftKey && k === "t") {
        // ⌘⇧T alongside ⌃`, because that is the muscle memory people arrive
        // with. Both hide rather than close, so a running command survives.
        e.preventDefault();
        setTerminalAlive(true);
        setTerminalOpen((v) => !v);
      } else if (e.shiftKey && k === "f") {
        e.preventDefault();
        useLayout.getState().setRailTab("search");
        if (!useLayout.getState().railOpen) toggleRail();
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

  // An "@" token under the caret means the user is referencing a file.
  const [caret, setCaret] = useState(0);
  const mention = slashQuery ? null : mentionQueryAt(prompt, caret);

  const pickMention = useCallback(
    (relPath: string) => {
      const q = mentionQueryAt(prompt, caret);
      if (!q) return;
      const next = applyMention(prompt, q, relPath);
      setPrompt(next.text);
      // Restore the caret after React has written the new value, or it jumps
      // to the end and the next @ lands in the wrong place.
      requestAnimationFrame(() => {
        const el = promptRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(next.caret, next.caret);
        setCaret(next.caret);
      });
    },
    [prompt, caret],
  );

  const runCommand = async (cmd: AgentCommand) => {
    // Our own templates: a mode sticks, a command applies to the next message.
    if (cmd.kind === "mode" || cmd.kind === "command") {
      const t = findTemplate(cmd.name);
      if (t) {
        if (t.kind === "mode") useChat.getState().setMode(t);
        else useChat.getState().setOneShot(t);
      }
      setPrompt("");
      promptRef.current?.focus();
      return;
    }
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
    void sendMessage(workspace.id, p, workspace.rootPath);
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
        {/* A stance, not a filter: it changes what the rail and inspector are
            for. Kept in the header because it is the highest-level choice
            there is — everything below reads differently under it. */}
        {workspace && (
          <div className="mode-switch" role="group" aria-label="Mode">
            {(["code", "research"] as const).map((m) => (
              <button
                key={m}
                className={`mode-opt ${mode === m ? "on" : ""}`}
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                title={
                  m === "code"
                    ? "Code — files, search, changes"
                    : "Research — notes, backlinks"
                }
              >
                {m}
              </button>
            ))}
          </div>
        )}
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
          className={`btn icon ${terminalOpen ? "on" : ""}`}
          onClick={() => {
            setTerminalAlive(true);
            setTerminalOpen((v) => !v);
          }}
          aria-label="Toggle terminal"
          aria-pressed={terminalOpen}
          title="Terminal (⌘⇧T or ⌃`)"
          disabled={!workspace}
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
                {/* Icon strip, then a section header carrying the actions
                    that apply to the current view — the shape a sidebar has in
                    every editor, because a text label per view eats the width
                    the tree actually needs. */}
                <div className="rail-tabs" role="tablist" aria-label="Rail views">
                  {(mode === "research" ? RESEARCH_TABS : RAIL_TABS).map(({ key, label, Icon }) => (
                    <button
                      key={key}
                      role="tab"
                      className={`rail-tab ${railTab === key ? "on" : ""}`}
                      aria-selected={railTab === key}
                      aria-label={label}
                      title={label}
                      onClick={() => setRailTab(key)}
                    >
                      <Icon size={15} strokeWidth={1.7} />
                    </button>
                  ))}
                </div>

                <div className="rail-head">
                  <button
                    className="rail-head-twisty"
                    aria-label={sectionOpen ? "Collapse section" : "Expand section"}
                    aria-expanded={sectionOpen}
                    onClick={() => setSectionOpen((v) => !v)}
                  >
                    {sectionOpen ? (
                      <ChevronDown size={12} strokeWidth={2} />
                    ) : (
                      <ChevronRight size={12} strokeWidth={2} />
                    )}
                  </button>
                  <span className="rail-head-label">
                    {railTab === "files" || railTab === "notes" ? workspace.name : railTab}
                  </span>
                  <span className="rail-head-actions">
                    {railTab === "files" && (
                      <>
                        <button
                          className="btn icon"
                          aria-label="New file"
                          title="New file"
                          onClick={() => setCreating("file")}
                          style={{ padding: 3, color: "var(--ink-faint)" }}
                        >
                          <FilePlus size={13} strokeWidth={1.7} />
                        </button>
                        <button
                          className="btn icon"
                          aria-label="New folder"
                          title="New folder"
                          onClick={() => setCreating("dir")}
                          style={{ padding: 3, color: "var(--ink-faint)" }}
                        >
                          <FolderPlus size={13} strokeWidth={1.7} />
                        </button>
                        <button
                          className="btn icon"
                          aria-label="Collapse all folders"
                          title="Collapse all"
                          onClick={() => useWorkspace.getState().collapseAll()}
                          style={{ padding: 3, color: "var(--ink-faint)" }}
                        >
                          <ChevronsDownUp size={13} strokeWidth={1.7} />
                        </button>
                      </>
                    )}
                  </span>
                </div>

                {sectionOpen &&
                  (railTab === "library" ? (
                    <div style={{ padding: "0 var(--s-2)" }}>
                      <LibraryPanel />
                    </div>
                  ) : railTab === "notes" ? (
                    <div style={{ padding: "0 var(--s-2)" }}>
                      <NotesPanel />
                    </div>
                  ) : railTab === "links" ? (
                    <div style={{ padding: "0 var(--s-2)" }}>
                      <BacklinksPanel />
                    </div>
                  ) : railTab === "files" ? (
                    <FileTree creating={creating} onCreateDone={() => setCreating(null)} />
                  ) : (
                    /* The tree indents itself; these panels need the gutter. */
                    <div style={{ padding: "0 var(--s-3)" }}>
                      {railTab === "search" ? <SearchPanel /> : <ChangesPanel />}
                    </div>
                  ))}
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
          {(activeMode || activeOneShot) && (
            <div className="composer-meta">
              {activeMode && (
                <span className="chip mode">
                  <b>{activeMode.name}</b> mode
                  <button
                    className="chip-x"
                    aria-label="Clear mode"
                    onClick={() => useChat.getState().setMode(null)}
                  >
                    <X size={10} strokeWidth={2.2} />
                  </button>
                </span>
              )}
              {activeOneShot && (
                <span className="chip mode">
                  <b>/{activeOneShot.name}</b> next message
                  <button
                    className="chip-x"
                    aria-label="Clear command"
                    onClick={() => useChat.getState().setOneShot(null)}
                  >
                    <X size={10} strokeWidth={2.2} />
                  </button>
                </span>
              )}
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
            {mention && (
              <MentionMenu
                query={mention.query}
                onPick={pickMention}
                onClose={() => setCaret(-1)}
              />
            )}
            <textarea
              ref={promptRef}
              className="composer-input"
              rows={1}
              placeholder={workspace ? PLACEHOLDER : "Open a workspace to run tasks"}
              value={prompt}
              disabled={!workspace || busy}
              onChange={(e) => {
                setPrompt(e.target.value);
                setCaret(e.target.selectionStart ?? e.target.value.length);
              }}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
              onKeyDown={(e) => {
                // While a menu is open it owns Enter/arrows.
                if (slashQuery || mention) return;
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

        {/* Below the composer, so the input and its controls always sit
            directly under the conversation they belong to. Mounted while
            `terminalAlive`, merely hidden while toggled off: unmounting kills
            the shell, and a toggle that discards a running command is not a
            toggle. The X button is the one that closes for real. */}
        {terminalAlive && workspace && (
          <>
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize terminal"
              tabIndex={0}
              hidden={!terminalOpen}
              onPointerDown={startTerminalDrag}
              onKeyDown={(e) => {
                // Keyboard-resizable too: a drag-only handle is unreachable.
                if (e.key === "ArrowUp") setTerminalHeight((h) => clampTerminal(h + 24));
                else if (e.key === "ArrowDown") setTerminalHeight((h) => clampTerminal(h - 24));
                else return;
                e.preventDefault();
              }}
              className="rule-drag"
              style={{
                height: 5,
                flexShrink: 0,
                cursor: "row-resize",
                display: terminalOpen ? undefined : "none",
              }}
            />
            <div
              style={{
                height: terminalOpen ? terminalHeight : 0,
                flexShrink: 0,
                minHeight: 0,
                overflow: "hidden",
                display: terminalOpen ? undefined : "none",
              }}
            >
              <ErrorBoundary>
                <TerminalDock
                  hidden={!terminalOpen}
                  onClose={() => {
                    setTerminalOpen(false);
                    setTerminalAlive(false);
                  }}
                />
              </ErrorBoundary>
            </div>
          </>
        )}
      </div>

      {inspectorOpen && (
        <aside className="inspector" aria-label="Inspector">
          <ErrorBoundary>
            <section className="panel" aria-labelledby="p-agent">
              <h3 id="p-agent">Agent</h3>
              <div className="card">
                {/* The model leads, because that is what the panel is
                    identifying. Stacking the phase over a credential label
                    read as "Done / openai key" — two unrelated facts with no
                    relationship shown between them. */}
                <div className="state-row">
                  <AgentOrb phase={chatPhase} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      className="state-label"
                      style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      title={resolvedProfile?.profile.modelId ?? undefined}
                    >
                      {resolvedProfile?.profile.modelId ?? "No model configured"}
                    </div>
                    <div className="state-sub" role="status" aria-live="polite">
                      {PHASE_LABEL[chatPhase]}
                      {resolvedProfile ? ` · via ${resolvedProfile.profile.label}` : ""}
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
          </ErrorBoundary>
        </aside>
      )}

      {palette && <Palette mode={palette} onClose={() => setPalette(null)} />}
    </div>
  );
}
