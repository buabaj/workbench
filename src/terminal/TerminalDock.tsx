import { Channel, invoke } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Columns2, Plus, Rows2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { useWorkspace } from "../store/workspace";

/**
 * A real shell, docked under the conversation.
 *
 * Deliberately the user's own: a login shell in the workspace root with the
 * inherited environment, so it matches the terminal they already use. The
 * agent's `bash` tool stays in the conversation and never appears here — a
 * dock that mixed the two would make it impossible to tell, later, who ran
 * what.
 *
 * Output arrives as ArrayBuffer batches and is written as bytes. Decoding to
 * String first would corrupt any multi-byte character that happened to straddle
 * a read boundary, which is routine rather than rare.
 */

/** Matches the app's tokens; read at open time so the theme is applied once. */
function themeFromTokens(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: v("--canvas", "#faf9f5"),
    foreground: v("--ink", "#141413"),
    cursor: v("--clay", "#d97757"),
    cursorAccent: v("--canvas", "#faf9f5"),
    selectionBackground: v("--clay-wash", "#d9775733"),
  };
}

export function TerminalPane({
  hidden = false,
}: {
  /** Toggled out of view. The shell keeps running; only the pixels go away. */
  hidden?: boolean;
}) {
  const workspace = useWorkspace((s) => s.workspace);
  const hostRef = useRef<HTMLDivElement>(null);
  // Kept in refs, not state: none of this should trigger a React render, and
  // the cleanup path must see the live values rather than a stale closure.
  const termRef = useRef<Terminal | null>(null);
  const ptyRef = useRef<string | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !workspace) return;

    const term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() ||
        "monospace",
      fontSize: 12,
      lineHeight: 1.35,
      cursorBlink: true,
      allowProposedApi: true,
      theme: themeFromTokens(),
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    let disposed = false;
    const channel = new Channel<ArrayBuffer | number[]>();
    channel.onmessage = (payload) => {
      const bytes =
        payload instanceof ArrayBuffer
          ? new Uint8Array(payload)
          : new Uint8Array(payload as number[]);
      // A zero-length frame is the shell exiting — a real read of 0 bytes
      // cannot occur otherwise, so this is unambiguous.
      if (bytes.length === 0) {
        term.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n");
        return;
      }
      term.write(bytes);
    };

    void invoke<string>("pty_open", {
      workspaceId: workspace.id,
      cols: term.cols,
      rows: term.rows,
      channel,
    })
      .then((id) => {
        if (disposed) {
          // Opened after unmount: close it rather than leak a shell.
          void invoke("pty_close", { ptyId: id }).catch(() => {});
          return;
        }
        ptyRef.current = id;
        term.focus();
      })
      .catch((e) => {
        term.write(`\r\n\x1b[31m${String(e)}\x1b[0m\r\n`);
      });

    const typed = term.onData((data) => {
      const id = ptyRef.current;
      if (id) void invoke("pty_write", { ptyId: id, data }).catch(() => {});
    });

    // Keep the pty's idea of the window matching the rendered one, or
    // full-screen programs (vim, htop, less) draw at the wrong size.
    const ro = new ResizeObserver(() => {
      // While hidden the host measures 0×0. Fitting to that would resize the
      // pty to nothing and reflow the running program's output — so a hidden
      // terminal is left exactly as the user left it.
      if (!host.clientWidth || !host.clientHeight) return;
      try {
        fit.fit();
      } catch {
        return; // host detached mid-measure
      }
      const id = ptyRef.current;
      if (id) {
        void invoke("pty_resize", { ptyId: id, cols: term.cols, rows: term.rows }).catch(() => {});
      }
    });
    ro.observe(host);

    return () => {
      disposed = true;
      ro.disconnect();
      typed.dispose();
      const id = ptyRef.current;
      if (id) void invoke("pty_close", { ptyId: id }).catch(() => {});
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      ptyRef.current = null;
    };
  }, [workspace?.id]);

  // Re-measure on reveal. The dimensions xterm cached while hidden are stale,
  // and the window may well have been resized in between.
  useEffect(() => {
    if (hidden) return;
    const term = termRef.current;
    const fit = fitRef.current;
    const host = hostRef.current;
    if (!term || !fit || !host) return;
    // After layout, or the host still measures its hidden size.
    const raf = requestAnimationFrame(() => {
      if (!host.clientWidth || !host.clientHeight) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      const id = ptyRef.current;
      if (id) {
        void invoke("pty_resize", { ptyId: id, cols: term.cols, rows: term.rows }).catch(() => {});
      }
      term.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [hidden]);

  return <div ref={hostRef} style={{ flex: 1, minHeight: 0, padding: "var(--s-2)" }} />;
}


/**
 * The dock: several shells, as tabs or side by side.
 *
 * Panes are keyed by a client-side id and stay mounted whichever view is
 * chosen, so switching tabs or splitting never restarts a shell — the same
 * reason toggling the dock hides rather than unmounts.
 */
let paneSeq = 0;
const nextPaneId = () => `pane-${++paneSeq}`;

export function TerminalDock({
  hidden = false,
  onClose,
}: {
  hidden?: boolean;
  onClose: () => void;
}) {
  const workspace = useWorkspace((s) => s.workspace);
  const [panes, setPanes] = useState<string[]>(() => [nextPaneId()]);
  const [activeId, setActiveId] = useState<string>(() => panes[0]);
  const [split, setSplit] = useState(false);

  const addPane = () => {
    const id = nextPaneId();
    setPanes((p) => [...p, id]);
    setActiveId(id);
  };

  const closePane = (id: string) => {
    setPanes((prev) => {
      const next = prev.filter((p) => p !== id);
      // Closing the last shell closes the dock: an empty dock is just a
      // rectangle of nothing taking up a third of the window.
      if (next.length === 0) {
        onClose();
        return prev;
      }
      if (activeId === id) setActiveId(next[Math.max(0, prev.indexOf(id) - 1)]);
      return next;
    });
  };

  return (
    <section
      aria-label="Terminal"
      style={{
        borderTop: "1px solid var(--border)",
        background: "var(--canvas)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        height: "100%",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          padding: "3px var(--s-3)",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        {panes.map((id, i) => (
          <span key={id} style={{ display: "inline-flex", alignItems: "center" }}>
            <button
              className={`term-tab ${!split && activeId === id ? "on" : ""}`}
              aria-pressed={!split && activeId === id}
              onClick={() => {
                setActiveId(id);
                setSplit(false);
              }}
              title={`Terminal ${i + 1}`}
            >
              {i + 1}
              {/* Only the active tab offers its close control, so a row of
                  tabs is not a row of X's. */}
              {(split || activeId === id) && (
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={`Close terminal ${i + 1}`}
                  title="Close this shell"
                  onClick={(e) => {
                    e.stopPropagation();
                    closePane(id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      closePane(id);
                    }
                  }}
                  style={{ display: "inline-flex", marginLeft: 4, opacity: 0.7 }}
                >
                  <X size={10} strokeWidth={2} />
                </span>
              )}
            </button>
          </span>
        ))}

        <button
          className="btn icon"
          aria-label="New terminal"
          title="New terminal"
          onClick={addPane}
          style={{ padding: 3, color: "var(--ink-faint)" }}
        >
          <Plus size={13} strokeWidth={1.8} />
        </button>

        {panes.length > 1 && (
          <button
            className="btn icon"
            aria-label={split ? "Show one at a time" : "Show side by side"}
            aria-pressed={split}
            title={split ? "Tabs" : "Split side by side"}
            onClick={() => setSplit((v) => !v)}
            style={{ padding: 3, color: split ? "var(--clay-text)" : "var(--ink-faint)" }}
          >
            {split ? <Rows2 size={13} strokeWidth={1.8} /> : <Columns2 size={13} strokeWidth={1.8} />}
          </button>
        )}

        {/* The workspace, in the accent — so which project these shells are
            rooted in is readable at a glance rather than another grey word. */}
        <span
          style={{
            marginLeft: "auto",
            fontSize: "var(--text-xs)",
            color: "var(--clay-text)",
            fontFamily: "var(--mono)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: "40%",
          }}
          title={workspace?.rootPath ?? ""}
        >
          {workspace?.name ?? ""}
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 0 }}>
        {panes.map((id) => (
          <div
            key={id}
            style={{
              // Split shows every pane at once; tabs show the active one. Both
              // keep the others mounted, so no shell is ever restarted.
              display: split || activeId === id ? "flex" : "none",
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              borderLeft: split && panes[0] !== id ? "1px solid var(--border)" : undefined,
            }}
          >
            <TerminalPane hidden={hidden || (!split && activeId !== id)} />
          </div>
        ))}
      </div>
    </section>
  );
}
