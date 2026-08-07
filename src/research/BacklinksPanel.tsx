import { CornerDownRight } from "lucide-react";
import { useMemo } from "react";
import { useLayout } from "../store/layout";
import { useWorkspace } from "../store/workspace";
import { useVault } from "./NotesPanel";
import { backlinksTo, noteName, parseWikiLinks, resolveLink } from "./wikilinks";

/**
 * What points here, and what this points at.
 *
 * Backlinks are the half a plain file tree cannot give you: a note's place in
 * the vault is defined by what refers to it, and that is invisible from inside
 * the note itself. Each is shown with the line it sits on, because a filename
 * alone does not tell you why the link was made.
 */
export function BacklinksPanel() {
  const workspace = useWorkspace((s) => s.workspace);
  const active = useLayout((s) => s.activeFile());
  const openFileTab = useLayout((s) => s.openFileTab);
  const revealLine = useWorkspace((s) => s.revealLine);
  const { docs } = useVault();

  const paths = useMemo(() => docs.map((d) => d.relPath), [docs]);
  const incoming = useMemo(
    () => (active ? backlinksTo(active, docs, paths) : []),
    [active, docs, paths],
  );
  const outgoing = useMemo(() => {
    if (!active) return [];
    const self = docs.find((d) => d.relPath === active);
    if (!self) return [];
    const seen = new Set<string>();
    return parseWikiLinks(self.text)
      .map((l) => ({ target: l.target, path: resolveLink(l.target, paths) }))
      .filter((l) => l.target && !seen.has(l.target) && seen.add(l.target));
  }, [active, docs, paths]);

  if (!workspace) return <div className="panel-empty">Open a workspace.</div>;
  if (!active) return <div className="panel-empty">Open a note to see what links to it.</div>;

  const empty = incoming.length === 0 && outgoing.length === 0;
  if (empty) {
    return <div className="panel-empty">Nothing links here yet, and this note links nowhere.</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
      {incoming.length > 0 && (
        <div>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-faint)",
              padding: "0 var(--s-2) 4px",
            }}
          >
            {incoming.length} linked mention{incoming.length === 1 ? "" : "s"}
          </div>
          {incoming.map((b, i) => (
            <div
              key={`${b.from}:${b.line}:${i}`}
              className="rail-item"
              role="button"
              tabIndex={0}
              title={`${b.from}:${b.line}`}
              style={{ alignItems: "flex-start" }}
              onClick={() => {
                // Land on the sentence that made the link, not the top of a
                // file you then have to search.
                revealLine(b.from, b.line, 0, 0);
                openFileTab(b.from);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  (e.currentTarget as HTMLElement).click();
                }
              }}
            >
              <span className="twisty" aria-hidden />
              <span style={{ minWidth: 0 }}>
                <span
                  className="label"
                  style={{ display: "block", color: "var(--ink)", fontSize: "var(--text-sm)" }}
                >
                  {noteName(b.from)}
                </span>
                <span
                  style={{
                    display: "block",
                    fontSize: "var(--text-xs)",
                    color: "var(--ink-faint)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {b.context}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}

      {outgoing.length > 0 && (
        <div>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-faint)",
              padding: "0 var(--s-2) 4px",
            }}
          >
            Links from this note
          </div>
          {outgoing.map((l) => (
            <div
              key={l.target}
              className="rail-item"
              role="button"
              tabIndex={0}
              // An unwritten target is shown, dimmed, rather than hidden: it is
              // a note the vault is asking for.
              title={l.path ?? `${l.target} — not written yet`}
              onClick={() => l.path && openFileTab(l.path)}
              onKeyDown={(e) => {
                if ((e.key === "Enter" || e.key === " ") && l.path) {
                  e.preventDefault();
                  openFileTab(l.path);
                }
              }}
            >
              <span className="twisty" aria-hidden>
                <CornerDownRight size={11} strokeWidth={1.7} />
              </span>
              <span
                className="label"
                style={{ color: l.path ? "var(--ink-secondary)" : "var(--ink-faint)" }}
              >
                {l.target}
                {!l.path && " ·"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
