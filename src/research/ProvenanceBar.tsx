import { Check, Trash2, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { formatError, ipc } from "../ipc/client";
import { acceptAll, findAgentSpans, unverifiedSummary } from "./provenance";

/**
 * How much of this note a model wrote, and the act of taking it on.
 *
 * Accepting is deliberate and never automatic. The distinction the file
 * records is "verified by me" against "asserted by a model" — a default that
 * accepted on your behalf would erase exactly the thing being tracked.
 */
export function ProvenanceBar({
  workspaceId,
  relPath,
  version,
  onChanged,
}: {
  workspaceId: string;
  relPath: string;
  /** Bumped by the host when the file changes, to re-read. */
  version: number;
  onChanged: () => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void ipc
      .fileRead(workspaceId, relPath)
      .then((c) => live && setNote(c.text))
      .catch(() => live && setNote(null));
    return () => {
      live = false;
    };
  }, [workspaceId, relPath, version]);

  if (!note) return null;
  const summary = unverifiedSummary(note);
  if (summary.spans === 0) return null;

  const write = async (next: string) => {
    setBusy(true);
    try {
      const current = await ipc.fileRead(workspaceId, relPath);
      await ipc.fileWrite(workspaceId, relPath, next, current.contentHash);
      onChanged();
    } catch (e) {
      setErr(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--s-2)",
        padding: "5px var(--s-4)",
        borderBottom: "1px solid var(--border)",
        background: "color-mix(in srgb, var(--clay) 6%, transparent)",
        fontSize: "var(--text-xs)",
        flexShrink: 0,
      }}
    >
      <ShieldAlert size={13} strokeWidth={1.8} style={{ color: "var(--clay-text)", flexShrink: 0 }} />
      <span style={{ color: "var(--ink-secondary)" }}>
        {summary.spans} passage{summary.spans === 1 ? "" : "s"} written by a model
        {" — "}
        {summary.chars.toLocaleString()} characters you have not verified
      </span>
      {err && <span style={{ color: "var(--error)" }}>{err}</span>}
      <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
        <button
          className="btn"
          style={{ fontSize: "var(--text-xs)", padding: "2px 8px", gap: 4 }}
          disabled={busy}
          title="You have read these and stand behind them; the markers come off"
          onClick={() => void write(acceptAll(note))}
        >
          <Check size={11} strokeWidth={2.2} />
          Accept all
        </button>
        <button
          className="btn"
          style={{ fontSize: "var(--text-xs)", padding: "2px 8px", gap: 4 }}
          disabled={busy}
          title="Remove the generated passages entirely"
          onClick={() => {
            let next = note;
            // Last first, so earlier offsets stay valid as the string shortens.
            for (const span of findAgentSpans(next).reverse()) {
              next = next.slice(0, span.start) + next.slice(span.end);
            }
            void write(next.replace(/\n{3,}/g, "\n\n"));
          }}
        >
          <Trash2 size={11} strokeWidth={2} />
          Discard all
        </button>
      </span>
    </div>
  );
}
