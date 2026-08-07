import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  formatError,
  ipc,
  onFsChanged,
  type BranchState,
  type WorktreeChange,
} from "../ipc/client";
import { useLayout } from "../store/layout";
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

/**
 * Branch and upstream position.
 *
 * Shown even when there is nothing uncommitted, because that is precisely when
 * it is needed: a clean tree that is "ahead of origin/main by 32 commits" made
 * an empty change list look broken to anyone who had just run `git status`.
 */
function BranchLine({ branch }: { branch: BranchState | null }) {
  if (!branch?.branch) return null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: "var(--s-2)",
        fontSize: "var(--text-xs)",
        color: "var(--ink-faint)",
        fontFamily: "var(--mono)",
        padding: "0 2px 6px",
      }}
    >
      <span style={{ color: "var(--clay-text)" }}>{branch.branch}</span>
      {branch.upstream ? (
        branch.ahead === 0 && branch.behind === 0 ? (
          <span>up to date with {branch.upstream}</span>
        ) : (
          <span>
            {branch.ahead > 0 && `${branch.ahead} ahead`}
            {branch.ahead > 0 && branch.behind > 0 && ", "}
            {branch.behind > 0 && `${branch.behind} behind`} {branch.upstream}
          </span>
        )
      ) : (
        <span>no upstream</span>
      )}
    </div>
  );
}

export function ChangesPanel() {
  const workspace = useWorkspace((s) => s.workspace);
  const [changes, setChanges] = useState<WorktreeChange[]>([]);
  const [branch, setBranch] = useState<BranchState | null>(null);
  const openDiffTab = useLayout((s) => s.openDiffTab);
  const [err, setErr] = useState<string | null>(null);
  const focus = useLayout((s) => s.changesFocus);
  const clearFocus = useLayout((s) => s.clearChangesFocus);

  const reload = useCallback(() => {
    if (!workspace) return;
    void ipc
      .worktreeChanges(workspace.id)
      .then((c) => {
        setChanges(c);
        setErr(null);
      })
      .catch((e) => setErr(formatError(e)));
    void ipc
      .worktreeBranch(workspace.id)
      .then(setBranch)
      .catch(() => setBranch(null));
  }, [workspace?.id]);

  // Task review sends you here with one file in mind; open its diff.
  useEffect(() => {
    if (!focus) return;
    openDiffTab(focus);
    clearFocus();
  }, [focus, clearFocus, openDiffTab]);

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
    return (
      <div>
        <BranchLine branch={branch} />
        <div className="panel-empty">No uncommitted changes.</div>
      </div>
    );
  }

  const totals = changes.reduce(
    (acc, c) => ({ ins: acc.ins + c.insertions, del: acc.del + c.deletions }),
    { ins: 0, del: 0 },
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <BranchLine branch={branch} />
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
        return (
          <div key={c.relPath}>
            <div
              className="rail-item"
              role="button"
              tabIndex={0}
              title={`Open the diff for ${c.relPath}`}
              // Opens in the centre. The diff used to expand here, in 300px of
              // rail — wide enough to see that a line changed and not to read
              // it.
              onClick={() => openDiffTab(c.relPath)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openDiffTab(c.relPath);
                }
              }}
            >
              <span className="twisty" aria-hidden />
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
          </div>
        );
      })}
    </div>
  );
}
