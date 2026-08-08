import { Check, ChevronDown, Cloud, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  formatError,
  ipc,
  onFsChanged,
  type BranchRef,
  type BranchState,
  type WorktreeChange,
} from "../ipc/client";
import { editorRegistry } from "../editor/editorRegistry";
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
 * Switch branches from the branch line.
 *
 * The one thing in this panel that changes the repository, and it stops at
 * exactly the line git draws: a switch that would overwrite uncommitted work
 * is refused, with git's own reason. Commit, stage and push stay in the
 * terminal — moving between branches is navigation, not publishing.
 */
function BranchPicker({
  workspaceId,
  current,
  onSwitched,
}: {
  workspaceId: string;
  current: string;
  onSwitched: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<BranchRef[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    void ipc
      .worktreeBranches(workspaceId)
      .then(setBranches)
      .catch((e) => setErr(formatError(e)));
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, workspaceId]);

  const go = async (name: string) => {
    setBusy(name);
    setErr(null);
    try {
      await ipc.worktreeSwitchBranch(workspaceId, name);
      // A checkout rewrites many files at once. The mounted editor reloads
      // itself from the watcher; background tabs hold stashed state nobody is
      // watching, and would go on showing the branch you just left.
      const buffers = useWorkspace.getState().buffers;
      editorRegistry.dropUnmounted(
        Object.values(buffers)
          .filter((b) => b.phase === "clean")
          .map((b) => b.relPath),
      );
      // HEAD moved, so the tree's git markings are stale even when no file
      // on disk changed — switching between two identical branches fires no
      // watcher event at all.
      void useWorkspace.getState().refreshGitStatus();
      setOpen(false);
      onSwitched();
    } catch (e) {
      // Kept open and shown in place: this is usually "your changes would be
      // overwritten", which is a thing to act on, not a dead end.
      setErr(formatError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Branch: ${current}. Switch branch`}
        title="Switch branch"
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 3,
          background: "none",
          border: 0,
          padding: 0,
          font: "inherit",
          fontFamily: "var(--mono)",
          color: "var(--clay-text)",
          cursor: "default",
        }}
      >
        {current}
        <ChevronDown size={11} strokeWidth={2} />
      </button>

      {err && (
        <div
          role="alert"
          style={{
            marginTop: 3,
            fontSize: "var(--text-xs)",
            color: "var(--error)",
            fontFamily: "var(--sans)",
            lineHeight: 1.5,
            whiteSpace: "normal",
          }}
        >
          {err}
        </div>
      )}

      {open && (
        <div
          role="listbox"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 40,
            minWidth: 220,
            maxHeight: 280,
            overflowY: "auto",
            background: "var(--canvas)",
            border: "1px solid var(--border)",
            borderRadius: "var(--r-panel)",
            boxShadow: "var(--lift-strong)",
            padding: 3,
          }}
        >
          {!branches && (
            <div style={{ padding: "4px 8px", color: "var(--ink-faint)" }}>Reading refs…</div>
          )}
          {branches?.map((b) => (
            <button
              key={b.name}
              role="option"
              aria-selected={b.isHead}
              disabled={busy !== null}
              onClick={() => void go(b.name)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                width: "100%",
                textAlign: "left",
                background: "none",
                border: 0,
                borderRadius: "var(--r-control)",
                padding: "3px 8px",
                font: "inherit",
                fontFamily: "var(--mono)",
                color: b.isHead ? "var(--clay-text)" : "var(--ink-secondary)",
                cursor: "default",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--raised)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
            >
              {b.isHead ? (
                <Check size={11} strokeWidth={2.4} />
              ) : b.isRemote ? (
                /* Remote-only: choosing it creates a local branch tracking it,
                   so the difference is worth showing before the click. */
                <Cloud size={11} strokeWidth={1.8} style={{ color: "var(--ink-faint)" }} />
              ) : (
                <span style={{ width: 11 }} />
              )}
              <span style={{ flex: 1, minWidth: 0 }}>{b.name}</span>
              {busy === b.name && <span style={{ color: "var(--ink-faint)" }}>…</span>}
            </button>
          ))}
          {branches?.length === 0 && (
            <div style={{ padding: "4px 8px", color: "var(--ink-faint)" }}>No branches.</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Branch and upstream position.
 *
 * Shown even when there is nothing uncommitted, because that is precisely when
 * it is needed: a clean tree that is "ahead of origin/main by 32 commits" made
 * an empty change list look broken to anyone who had just run `git status`.
 */
function BranchLine({
  branch,
  workspaceId,
  onSwitched,
}: {
  branch: BranchState | null;
  workspaceId: string;
  onSwitched: () => void;
}) {
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
      <BranchPicker workspaceId={workspaceId} current={branch.branch} onSwitched={onSwitched} />
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
        <BranchLine branch={branch} workspaceId={workspace.id} onSwitched={reload} />
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
      <BranchLine branch={branch} workspaceId={workspace.id} onSwitched={reload} />
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
