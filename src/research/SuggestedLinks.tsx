import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { formatError, ipc, type LinkSuggestion } from "../ipc/client";
import { useLayout } from "../store/layout";
import { useWorkspace } from "../store/workspace";
import { editNote, readNote } from "./noteEdits";
import { useVault } from "./NotesPanel";
import { withListItem } from "./sections";
import { noteName, parseWikiLinks, resolveLink } from "./wikilinks";

/**
 * Notes this one might belong with.
 *
 * A vault only pays off once it is linked, and the linking is the part nobody
 * keeps up with — you write a note, mean to connect it, and do not. This asks
 * a model to read what you wrote and name the notes it actually belongs with.
 *
 * It suggests; it does not link. Every result needs a click to become a link,
 * because a tool that edits your notes on its own is the thing that got the
 * last one removed.
 */
export function SuggestedLinks() {
  const workspace = useWorkspace((s) => s.workspace);
  const active = useLayout((s) => s.activeFile());
  const openFileTab = useLayout((s) => s.openFileTab);
  const { docs } = useVault();

  const [items, setItems] = useState<LinkSuggestion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());

  // Suggestions belong to the note they were made for. Carrying them to the
  // next tab would show one note's connections under another's name.
  useEffect(() => {
    setItems(null);
    setErr(null);
    setAdded(new Set());
  }, [active]);

  if (!workspace || !active || !active.endsWith(".md")) return null;

  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      // The open editor's text, not the file's — asking about a stale copy
      // would answer for a note you have already moved on from.
      const text = await readNote(workspace.id, active);
      const paths = docs.map((d) => d.relPath);
      const linked = new Set(
        parseWikiLinks(text)
          .map((l) => resolveLink(l.target, paths))
          .filter(Boolean)
          .map((p) => (p as string).toLowerCase()),
      );
      // Neither itself nor anything it already links to: both would be
      // suggestions to do what has been done.
      const candidates = docs
        .filter((d) => d.relPath !== active && !linked.has(d.relPath.toLowerCase()))
        .map((d) => noteName(d.relPath));

      if (candidates.length === 0) {
        setItems([]);
        return;
      }
      const out = await ipc.linksSuggest(text, candidates);
      setItems(out.suggestions);
    } catch (e) {
      setErr(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  const add = async (name: string) => {
    try {
      await editNote(workspace.id, active, (text) => withListItem(text, "Related", name));
      setAdded((prev) => new Set(prev).add(name));
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
        <span style={{ flex: 1 }}>Suggested</span>
        <button className="btn small" disabled={busy} onClick={() => void run()}>
          <Sparkles size={11} strokeWidth={2} />
          {busy ? "Reading…" : items ? "Again" : "Suggest links"}
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

      {items?.length === 0 && !busy && (
        <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-faint)", padding: "0 var(--s-2) var(--s-2)" }}>
          Nothing in the vault reads as related to this one.
        </div>
      )}

      {items?.map((s) => {
        const done = added.has(s.name);
        return (
          <div key={s.name} className="rail-item" style={{ alignItems: "flex-start" }}>
            <span className="twisty" aria-hidden />
            <span style={{ minWidth: 0, flex: 1 }}>
              <button
                className="label"
                title="Open this note"
                onClick={() => {
                  const path = docs.find((d) => noteName(d.relPath) === s.name)?.relPath;
                  if (path) openFileTab(path);
                }}
                style={{
                  display: "block",
                  color: "var(--ink)",
                  fontSize: "var(--text-sm)",
                  background: "none",
                  border: 0,
                  padding: 0,
                  textAlign: "left",
                  cursor: "default",
                }}
              >
                {s.name}
              </button>
              <span
                style={{
                  display: "block",
                  fontSize: "var(--text-xs)",
                  color: "var(--ink-faint)",
                  lineHeight: 1.5,
                }}
              >
                {s.why}
              </span>
            </span>
            <button
              className="btn small"
              disabled={done}
              title={done ? "Added under Related" : "Add [[link]] under Related"}
              onClick={() => void add(s.name)}
              style={{ flexShrink: 0, marginTop: 2 }}
            >
              {done ? "Added" : "Link"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
