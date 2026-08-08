import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Markdown } from "../components/Markdown";
import { formatError, ipc } from "../ipc/client";
import { useLayout } from "../store/layout";
import { useWorkspace } from "../store/workspace";
import { editNote, readNote } from "./noteEdits";
import { withSection } from "./sections";

/**
 * A summary of the open note, on request.
 *
 * Shown here rather than written in: reading it is usually the whole point,
 * and a note gains a `## Summary` section only if you say so.
 */
export function NoteSummary() {
  const workspace = useWorkspace((s) => s.workspace);
  const active = useLayout((s) => s.activeFile());

  const [text, setText] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setText(null);
    setErr(null);
    setSaved(false);
  }, [active]);

  if (!workspace || !active || !active.endsWith(".md")) return null;

  const run = async () => {
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      const source = await readNote(workspace.id, active);
      const out = await ipc.researchSummarize(source);
      setText(out.text);
      setModel(out.modelServed);
    } catch (e) {
      setErr(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  const insert = async () => {
    if (!text) return;
    try {
      await editNote(workspace.id, active, (doc) => withSection(doc, "Summary", text));
      setSaved(true);
    } catch (e) {
      setErr(formatError(e));
    }
  };

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--s-2)",
          fontSize: "var(--text-xs)",
          color: "var(--ink-faint)",
          padding: "0 var(--s-2) 4px",
        }}
      >
        <span style={{ flex: 1 }}>Summary</span>
        <button className="btn small" disabled={busy} onClick={() => void run()}>
          <Sparkles size={11} strokeWidth={2} />
          {busy ? "Reading…" : text ? "Again" : "Summarize"}
        </button>
      </div>

      {err && (
        <div
          role="alert"
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--error)",
            padding: "0 var(--s-2) var(--s-2)",
          }}
        >
          {err}
        </div>
      )}

      {text && (
        <div className="card" style={{ margin: "0 var(--s-2)" }}>
          <div style={{ fontSize: "var(--text-xs)", lineHeight: 1.6 }}>
            <Markdown source={text} />
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--s-2)",
              marginTop: "var(--s-2)",
            }}
          >
            <span
              style={{ flex: 1, fontSize: "var(--text-xs)", color: "var(--ink-faint)" }}
              title={model}
            >
              {model}
            </span>
            <button className="btn small" disabled={saved} onClick={() => void insert()}>
              {saved ? "In the note" : "Insert"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
