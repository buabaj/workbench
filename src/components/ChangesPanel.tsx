import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { formatError, ipc, onFsChanged, type WorktreeChange } from "../ipc/client";
import { useWorkspace } from "../store/workspace";

/**
 * Uncommitted changes, live.
 *
 * A git client's changes list without the client: no stage, no commit, no
 * sync. Those belong in the terminal, and offering half of them here would
 * imply the rest works too.
 *
 * Refreshed from the same filesystem watcher the tree uses, so editing a file
 * — in Workbench, in another editor, or by the agent — updates the list
 * without asking.
 */

/** Coalesce watcher bursts: a save touches several paths in quick succession. */
const REFRESH_DEBOUNCE_MS = 250;

const STATUS_LABEL: Record<string, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  type_changed: "T",
};

function statusColor(status: string, untracked: boolean): string {
  if (untracked) return "var(--ink-faint)";
  switch (status) {
    case "added":
      return "var(--diff-add)";
    case "deleted":
      return "var(--error)";
    default:
      return "var(--clay-text)";
  }
}

/** Unified patch, coloured by origin marker. */
function Patch({ workspaceId, relPath }: { workspaceId: string; relPath: string }) {
  const [patch, setPatch] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void ipc
      .worktreePatch(workspaceId, relPath)
      .then((p) => live && setPatch(p))
      .catch((e) => live && setErr(formatError(e)));
    return () => {
      live = false;
    };
  }, [workspaceId, relPath]);

  if (err) {
    return (
      <div role="alert" style={{ color: "var(--error)", fontSize: "var(--text-xs)", padding: "4px 8px" }}>
        {err}
      </div>
    );
  }
  if (patch === null) {
    return (
      <div style={{ color: "var(--ink-faint)", fontSize: "var(--text-xs)", padding: "4px 8px" }}>
        loading…
      </div>
    );
  }
  if (!patch.trim()) {
    return (
      <div style={{ color: "var(--ink-faint)", fontSize: "var(--text-xs)", padding: "4px 8px" }}>
        No textual diff — the file may be binary.
      </div>
    );
  }

  const lines = patch.split("\n");
  return (
    <div
      style={{
        fontFamily: "var(--mono)",
        fontSize: "var(--text-xs)",
        lineHeight: 1.5,
        overflowX: "auto",
        padding: "2px 0 6px",
        userSelect: "text",
      }}
    >
      {lines.map((line, i) => {
        // Header lines carry no origin marker and are noise in a panel this
        // narrow; the file name is already the row above.
        if (
          line.startsWith("diff --git") ||
          line.startsWith("index ") ||
          line.startsWith("--- ") ||
          line.startsWith("+++ ") ||
          line.startsWith("new file") ||
          line.startsWith("deleted file")
        ) {
          return null;
        }
        const isHunk = line.startsWith("@@");
        const added = !isHunk && line.startsWith("+");
        const removed = !isHunk && line.startsWith("-");
        return (
          <div
            key={i}
            style={{
              whiteSpace: "pre",
              paddingLeft: 8,
              color: isHunk
                ? "var(--ink-faint)"
                : added
                  ? "var(--diff-add)"
                  : removed
                    ? "var(--error)"
                    : "var(--ink-muted)",
              background: added
                ? "color-mix(in srgb, var(--diff-add) 8%, transparent)"
                : removed
                  ? "color-mix(in srgb, var(--error) 8%, transparent)"
                  : undefined,
            }}
          >
            {line || " "}
          </div>
        );
      })}
    </div>
  );
}

export function ChangesPanel() {
  const workspace = useWorkspace((s) => s.workspace);
  const [changes, setChanges] = useState<WorktreeChange[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!workspace) return;
    void ipc
      .worktreeChanges(workspace.id)
      .then((c) => {
        setChanges(c);
        setErr(null);
      })
      .catch((e) => setErr(formatError(e)));
  }, [workspace?.id]);

  useEffect(reload, [reload]);

  // Live: the same watcher the file tree listens to.
  useEffect(() => {
    let timer: number | undefined;
    const un = onFsChanged(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(reload, REFRESH_DEBOUNCE_MS);
    });
    return () => {
      window.clearTimeout(timer);
      void un.then((f) => f());
    };
  }, [reload]);

  if (!workspace) return <div className="panel-empty">Open a workspace.</div>;
  if (workspace.kind !== "git") {
    return <div className="panel-empty">Not a git repository, so there is nothing to compare against.</div>;
  }
  if (err) {
    return (
      <div role="alert" style={{ color: "var(--error)", fontSize: "var(--text-sm)" }}>
        {err}
      </div>
    );
  }
  if (changes.length === 0) {
    return <div className="panel-empty">No uncommitted changes.</div>;
  }

  const totals = changes.reduce(
    (acc, c) => ({ ins: acc.ins + c.insertions, del: acc.del + c.deletions }),
    { ins: 0, del: 0 },
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--s-2)",
          fontSize: "var(--text-xs)",
          color: "var(--ink-faint)",
          padding: "0 2px 4px",
        }}
      >
        <span style={{ flex: 1 }}>
          {changes.length} file{changes.length === 1 ? "" : "s"}
        </span>
        <span style={{ color: "var(--diff-add)" }}>+{totals.ins}</span>
        <span style={{ color: "var(--error)" }}>−{totals.del}</span>
        <button
          className="btn icon"
          aria-label="Refresh changes"
          title="Refresh"
          onClick={reload}
          style={{ padding: 2, color: "var(--ink-faint)" }}
        >
          <RefreshCw size={11} strokeWidth={1.8} />
        </button>
      </div>

      {changes.map((c) => {
        const isOpen = open.has(c.relPath);
        return (
          <div key={c.relPath}>
            <div
              className="rail-item"
              role="button"
              tabIndex={0}
              aria-expanded={isOpen}
              title={c.oldPath ? `${c.oldPath} → ${c.relPath}` : c.relPath}
              onClick={() =>
                setOpen((prev) => {
                  const next = new Set(prev);
                  if (next.has(c.relPath)) next.delete(c.relPath);
                  else next.add(c.relPath);
                  return next;
                })
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  (e.currentTarget as HTMLElement).click();
                }
              }}
            >
              <span className="twisty" aria-hidden>
                {isOpen ? <ChevronDown size={12} strokeWidth={2} /> : <ChevronRight size={12} strokeWidth={2} />}
              </span>
              <span
                aria-hidden
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: "var(--text-xs)",
                  width: 12,
                  flexShrink: 0,
                  color: statusColor(c.status, c.untracked),
                }}
              >
                {c.untracked ? "?" : (STATUS_LABEL[c.status] ?? "M")}
              </span>
              <span className="label">{c.relPath}</span>
              <span className="sr-only">
                {c.untracked ? "untracked" : c.status}, +{c.insertions} −{c.deletions}
              </span>
              {c.insertions > 0 && (
                <span className="count" style={{ color: "var(--diff-add)" }} aria-hidden>
                  +{c.insertions}
                </span>
              )}
              {c.deletions > 0 && (
                <span className="count" style={{ color: "var(--error)" }} aria-hidden>
                  −{c.deletions}
                </span>
              )}
            </div>
            {isOpen && <Patch workspaceId={workspace.id} relPath={c.relPath} />}
          </div>
        );
      })}
    </div>
  );
}
