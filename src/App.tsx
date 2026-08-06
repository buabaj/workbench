import { useEffect } from "react";
import { DotMatrix } from "./components/DotMatrix";
import { EditorPane } from "./components/EditorPane";
import { FileTree } from "./components/FileTree";
import { PreflightPanel } from "./components/Preflight";
import { onFsChanged } from "./ipc/client";
import { useWorkspace } from "./store/workspace";

export default function App() {
  const workspace = useWorkspace((s) => s.workspace);
  const mode = useWorkspace((s) => s.mode);
  const active = useWorkspace((s) => s.active);
  const setMode = useWorkspace((s) => s.setMode);
  const pickWorkspace = useWorkspace((s) => s.pickWorkspace);
  const refreshPreflight = useWorkspace((s) => s.refreshPreflight);
  const handleFsChanged = useWorkspace((s) => s.handleFsChanged);

  useEffect(() => {
    void refreshPreflight();
    const un = onFsChanged(handleFsChanged);
    return () => {
      void un.then((f) => f());
    };
  }, [refreshPreflight, handleFsChanged]);

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
              <div className="serif">Select a file from the rail.</div>
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
          <h3>CONTEXT SHELF</h3>
          <div className="panel-empty">Select text in a document or file, then add it as context.</div>
        </div>
        <div className="panel">
          <h3>AGENT ACTIVITY</h3>
          <div className="panel-empty">
            <div className="state-row">
              <DotMatrix state="awaiting-input" />
              <div>
                <div className="state-label">AWAITING INPUT</div>
                <div className="state-sub">no agent running</div>
              </div>
            </div>
          </div>
        </div>
        <div className="panel">
          <h3>LINKED EVIDENCE</h3>
          <div className="panel-empty">Links between research and code appear here.</div>
        </div>
      </aside>

      <footer className="composer">
        <div className="composer-meta">
          <span className="chip">
            <b>no profile</b> · configure in settings
          </span>
          <span className="chip origin">app default</span>
        </div>
        <div className="composer-row">
          <input className="composer-input" placeholder="Describe a task for the agent…" disabled />
          <button className="btn" disabled>
            ◉ voice
          </button>
          <button className="btn primary" disabled>
            Run task
          </button>
        </div>
      </footer>
    </div>
  );
}
