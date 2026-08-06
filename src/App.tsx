import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DotMatrix } from "./components/DotMatrix";

type Mode = "code" | "research";

interface DbHealth {
  schemaVersion: number;
  path: string;
}

export default function App() {
  const [mode, setMode] = useState<Mode>("research");
  const [db, setDb] = useState<DbHealth | null>(null);

  useEffect(() => {
    invoke<DbHealth>("db_health").then(setDb).catch(console.error);
  }, []);

  return (
    <div className="app">
      <header className="bar" data-tauri-drag-region>
        <span className="bar-ws" data-tauri-drag-region>
          workbench
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
        <div className="rail-section">
          <h3>RESEARCH</h3>
          <div className="rail-item">No documents yet</div>
        </div>
        <div className="rail-section">
          <h3>CODE</h3>
          <div className="rail-item">No workspace open</div>
        </div>
        <div className="rail-section">
          <h3>TASKS</h3>
          <div className="rail-item">No tasks yet</div>
        </div>
      </nav>

      <main className="canvas">
        <div className="canvas-empty">
          <DotMatrix state="awaiting-input" />
          <div className="serif">Open a workspace to begin.</div>
          <div style={{ fontSize: 11 }}>
            {db ? `db schema v${db.schemaVersion}` : "connecting…"} · {mode} mode
          </div>
        </div>
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
