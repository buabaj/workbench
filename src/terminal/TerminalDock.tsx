import { Channel, invoke } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { X } from "lucide-react";
import { useEffect, useRef } from "react";
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

export function TerminalDock({ onClose }: { onClose: () => void }) {
  const workspace = useWorkspace((s) => s.workspace);
  const hostRef = useRef<HTMLDivElement>(null);
  // Kept in refs, not state: none of this should trigger a React render, and
  // the cleanup path must see the live values rather than a stale closure.
  const termRef = useRef<Terminal | null>(null);
  const ptyRef = useRef<string | null>(null);

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
      ptyRef.current = null;
    };
  }, [workspace?.id]);

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
          gap: "var(--s-2)",
          padding: "4px var(--s-3)",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: "var(--text-xs)", color: "var(--ink-muted)" }}>Terminal</span>
        <span style={{ fontSize: "var(--text-xs)", color: "var(--ink-faint)", flex: 1 }}>
          {workspace?.name ?? ""}
        </span>
        <button
          className="btn icon"
          aria-label="Close terminal"
          title="Close terminal (⌃`)"
          onClick={onClose}
          style={{ padding: 3, color: "var(--ink-faint)" }}
        >
          <X size={12} strokeWidth={1.8} />
        </button>
      </div>
      <div ref={hostRef} style={{ flex: 1, minHeight: 0, padding: "var(--s-2)" }} />
    </section>
  );
}
