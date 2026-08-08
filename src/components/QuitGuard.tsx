import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { formatError, ipc } from "../ipc/client";
import { saveBuffer, useWorkspace } from "../store/workspace";
import { editorRegistry } from "../editor/editorRegistry";

/**
 * Ask before quitting with unsaved work.
 *
 * The exit handler holds the first ⌘Q and emits `app://quit-requested`,
 * because only this side knows which buffers are dirty. If none are, quitting
 * continues immediately and you never see this — the guard costs nothing when
 * there is nothing to lose.
 */
export function QuitGuard() {
  const [dirty, setDirty] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const un = listen("app://quit-requested", () => {
      const buffers = useWorkspace.getState().buffers;
      const unsaved = Object.entries(buffers)
        .filter(([, b]) => b.phase === "dirty" || b.phase === "conflict")
        .map(([path]) => path);

      if (unsaved.length === 0) {
        void ipc.confirmQuit().catch(() => {});
        return;
      }
      // Tell the backend a dialog is up. It quits on its own if nothing
      // answers, so that it can never be held open by a window that failed to
      // register this listener at all.
      void ipc.quitAck().catch(() => {});
      setDirty(unsaved);
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  if (!dirty) return null;

  const saveAllAndQuit = async () => {
    setBusy(true);
    setErr(null);
    try {
      for (const path of dirty) {
        // Text comes from the live editor, as ⌘S does — the registry holds the
        // authoritative document, and saving from anywhere else would write
        // something older than what is on screen.
        const view = editorRegistry.liveView(path);
        const state = editorRegistry.get(path)?.state;
        const text = view?.state.doc.toString() ?? state?.doc.toString();
        if (text === undefined) continue;
        const result = await saveBuffer(path, () => text);
        if (result === "conflict") {
          setErr(`${path} changed on disk. Resolve it, or quit without saving.`);
          setBusy(false);
          return;
        }
      }
      await ipc.confirmQuit();
    } catch (e) {
      setErr(formatError(e));
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Unsaved changes"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        display: "grid",
        placeItems: "center",
        background: "color-mix(in srgb, var(--ink) 40%, transparent)",
      }}
    >
      <div
        style={{
          width: 420,
          maxWidth: "90vw",
          padding: "var(--s-5)",
          background: "var(--canvas)",
          border: "1px solid var(--border)",
          borderRadius: "var(--r-panel)",
          boxShadow: "var(--lift-strong)",
        }}
      >
        <div style={{ fontSize: "var(--text-base)", color: "var(--ink)", marginBottom: "var(--s-2)" }}>
          {dirty.length === 1 ? "One file has" : `${dirty.length} files have`} unsaved changes
        </div>
        <ul
          style={{
            margin: "0 0 var(--s-4)",
            padding: 0,
            listStyle: "none",
            fontFamily: "var(--mono)",
            fontSize: "var(--text-xs)",
            color: "var(--ink-muted)",
            maxHeight: 140,
            overflowY: "auto",
          }}
        >
          {dirty.map((p) => (
            <li key={p} style={{ padding: "1px 0" }}>
              {p}
            </li>
          ))}
        </ul>

        {err && (
          <div role="alert" style={{ color: "var(--error)", fontSize: "var(--text-xs)", marginBottom: "var(--s-2)" }}>
            {err}
          </div>
        )}

        <div style={{ display: "flex", gap: "var(--s-2)", justifyContent: "flex-end" }}>
          {/* Cancel first and focused: the safe choice should be the easy one,
              and it is the only one that loses nothing. */}
          <button
            className="btn"
            autoFocus
            disabled={busy}
            onClick={() => {
              setDirty(null);
              setErr(null);
            }}
          >
            Keep working
          </button>
          <button
            className="btn"
            disabled={busy}
            style={{ color: "var(--error)", borderColor: "var(--error)" }}
            onClick={() => void ipc.confirmQuit().catch(() => {})}
          >
            Quit without saving
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void saveAllAndQuit()}>
            {busy ? "Saving…" : "Save all and quit"}
          </button>
        </div>
      </div>
    </div>
  );
}
