import { useEffect, useMemo, useState } from "react";
import { formatError, ipc } from "../ipc/client";
import { countChanges, toSideBySide, type Row } from "../diff/sideBySide";
import { useWorkspace } from "../store/workspace";

/**
 * A file's uncommitted change, side by side, in the centre.
 *
 * It used to expand inside the rail, which is 300px wide — enough to see that
 * a line changed and not enough to read it. A diff is the thing you are
 * looking at when you look at it, so it takes the main area like a file does.
 *
 * Two columns rather than unified because a replacement should face what it
 * replaced; scanning a unified diff means holding the removed line in your
 * head until the added one arrives.
 */

function bg(kind: Row["kind"], side: "left" | "right"): string | undefined {
  if (kind === "context" || kind === "hunk" || kind === "meta") return undefined;
  // The left column only ever loses lines and the right only gains them, so
  // the colour follows the column, not the row.
  return side === "left"
    ? "color-mix(in srgb, var(--error) 12%, transparent)"
    : "color-mix(in srgb, var(--diff-add) 12%, transparent)";
}

function Cell({ row, side }: { row: Row; side: "left" | "right" }) {
  const cell = side === "left" ? row.left : row.right;
  const changed = row.kind !== "context" && row.kind !== "hunk" && row.kind !== "meta";

  return (
    <div
      style={{
        display: "flex",
        minWidth: 0,
        // An absent side is not an empty line: it is a gap where nothing
        // exists, and shading it keeps the two columns readable as a pair.
        background: cell ? bg(row.kind, side) : "var(--raised)",
      }}
    >
      <span
        style={{
          width: 44,
          flexShrink: 0,
          textAlign: "right",
          paddingRight: 8,
          color: "var(--ink-faint)",
          userSelect: "none",
        }}
      >
        {cell?.num ?? ""}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          whiteSpace: "pre",
          overflow: "hidden",
          color: changed ? "var(--ink)" : "var(--ink-secondary)",
        }}
      >
        {cell ? (changed && side === "left" ? "-" : changed ? "+" : " ") + cell.text : ""}
      </span>
    </div>
  );
}

export function DiffView({ relPath }: { relPath: string }) {
  const workspace = useWorkspace((s) => s.workspace);
  const [patch, setPatch] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!workspace) return;
    let live = true;
    setPatch(null);
    setErr(null);
    void ipc
      .worktreePatch(workspace.id, relPath)
      .then((p) => live && setPatch(p))
      .catch((e) => live && setErr(formatError(e)));
    return () => {
      live = false;
    };
  }, [workspace?.id, relPath]);

  const rows = useMemo(() => (patch ? toSideBySide(patch) : []), [patch]);
  const counts = useMemo(() => countChanges(rows), [rows]);

  if (!workspace) return null;
  if (err) {
    return (
      <div role="alert" style={{ padding: "var(--s-4)", color: "var(--error)", fontSize: "var(--text-sm)" }}>
        {err}
      </div>
    );
  }
  if (patch === null) {
    return (
      <div style={{ padding: "var(--s-4)", color: "var(--ink-faint)", fontSize: "var(--text-sm)" }}>
        Loading diff…
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div style={{ padding: "var(--s-4)", color: "var(--ink-faint)", fontSize: "var(--text-sm)" }}>
        No textual changes — this file may be binary, or already committed.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: "var(--s-3)",
          padding: "6px var(--s-4)",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
          fontSize: "var(--text-xs)",
        }}
      >
        <span style={{ fontFamily: "var(--mono)", color: "var(--ink)" }}>{relPath}</span>
        <span style={{ color: "var(--diff-add)" }}>+{counts.added}</span>
        <span style={{ color: "var(--error)" }}>−{counts.removed}</span>
        <span style={{ marginLeft: "auto", color: "var(--ink-faint)" }}>working tree vs HEAD</span>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          fontFamily: "var(--mono)",
          fontSize: "var(--text-xs)",
          lineHeight: 1.6,
          userSelect: "text",
        }}
      >
        {rows.map((row, i) =>
          row.kind === "hunk" || row.kind === "meta" ? (
            <div
              key={i}
              style={{
                padding: "4px var(--s-3)",
                color: "var(--ink-faint)",
                background: "var(--surface)",
                borderTop: i === 0 ? undefined : "1px solid var(--border)",
                whiteSpace: "pre",
              }}
            >
              {row.left?.text}
            </div>
          ) : (
            <div
              key={i}
              // A fixed two-column grid, so the halves stay aligned however
              // long the lines are; each side scrolls its own overflow.
              style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1 }}
            >
              <Cell row={row} side="left" />
              <Cell row={row} side="right" />
            </div>
          ),
        )}
      </div>
    </div>
  );
}
