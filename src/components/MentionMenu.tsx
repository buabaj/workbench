import { useEffect, useMemo, useState } from "react";
import { FileText } from "lucide-react";
import { fuzzyScore } from "../commands/registry";
import { ipc } from "../ipc/client";
import { useWorkspace } from "../store/workspace";

/**
 * File autocomplete for `@` in the composer.
 *
 * Backed by the same `workspace_index` the ⌘P palette uses, so a file is found
 * the same way in both places and there is one index to keep warm.
 */
export function MentionMenu({
  query,
  onPick,
  onClose,
}: {
  query: string;
  onPick: (relPath: string) => void;
  onClose: () => void;
}) {
  const workspace = useWorkspace((s) => s.workspace);
  const [files, setFiles] = useState<string[]>([]);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!workspace) return;
    void ipc
      .workspaceIndex(workspace.id, false)
      .then(setFiles)
      .catch(() => setFiles([]));
  }, [workspace?.id]);

  const rows = useMemo(() => {
    if (!query) return files.slice(0, 8);
    return files
      .map((f) => ({ f, s: fuzzyScore(f, query) }))
      .filter((x): x is { f: string; s: number } => x.s !== null)
      // Prefer the shorter path when scores tie: `DESIGN.md` should beat
      // `vendor/some/deep/DESIGN.md` for the query "design".
      .sort((a, b) => b.s - a.s || a.f.length - b.f.length)
      .slice(0, 8)
      .map((x) => x.f);
  }, [files, query]);

  useEffect(() => setIndex(0), [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (rows.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setIndex((i) => Math.min(i + 1, rows.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        onPick(rows[index]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [rows, index, onPick, onClose]);

  if (rows.length === 0) return null;

  return (
    <div
      role="listbox"
      aria-label="Files"
      style={{
        position: "absolute",
        bottom: "calc(100% + 6px)",
        left: 0,
        right: 0,
        maxWidth: 520,
        background: "var(--canvas)",
        border: "1px solid var(--border)",
        borderRadius: "var(--r-panel)",
        boxShadow: "var(--lift-strong)",
        padding: 4,
        zIndex: 30,
        maxHeight: 280,
        overflowY: "auto",
      }}
    >
      {rows.map((f, i) => {
        const slash = f.lastIndexOf("/");
        const dir = slash === -1 ? "" : f.slice(0, slash + 1);
        const base = slash === -1 ? f : f.slice(slash + 1);
        return (
          <div
            key={f}
            role="option"
            aria-selected={i === index}
            onMouseEnter={() => setIndex(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(f);
            }}
            style={{
              display: "flex",
              gap: "var(--s-2)",
              alignItems: "baseline",
              padding: "6px 10px",
              borderRadius: "var(--r-control)",
              background: i === index ? "var(--clay-wash)" : "transparent",
              cursor: "default",
            }}
          >
            <span style={{ color: "var(--ink-faint)", display: "inline-flex", marginTop: 2 }}>
              <FileText size={12} strokeWidth={1.8} />
            </span>
            {/* Filename first: it is what you searched for. The directory
                trails behind, dimmed, to disambiguate same-named files. */}
            <span
              style={{
                fontFamily: "var(--mono)",
                fontSize: "var(--text-sm)",
                color: "var(--ink)",
                flexShrink: 0,
              }}
            >
              {base}
            </span>
            <span
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--ink-faint)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                direction: "rtl",
              }}
              title={f}
            >
              {dir}
            </span>
          </div>
        );
      })}
    </div>
  );
}
