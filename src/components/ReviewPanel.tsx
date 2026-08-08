import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import {
  ipc,
  type FileDiffSummary,
  type RestoreResult,
  type TaskDiff,
} from "../ipc/client";
import { useChat } from "../store/chat";
import { useLayout } from "../store/layout";
import { useWorkspace } from "../store/workspace";

const STATUS_LABEL: Record<string, string> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
  type_changed: "type",
};

function PatchView({ taskId, relPath }: { taskId: string; relPath: string }) {
  const [patch, setPatch] = useState<string | null>(null);
  useEffect(() => {
    void ipc.reviewFilePatch(taskId, relPath).then(setPatch).catch(() => setPatch(null));
  }, [taskId, relPath]);

  if (patch === null) return <div style={{ fontSize: 10, color: "var(--ink-faint)" }}>loading…</div>;
  return (
    <pre
      style={{
        fontSize: 10.5,
        lineHeight: 1.5,
        background: "var(--canvas)",
        border: "1px solid var(--border)",
        borderRadius: "var(--r-card)",
        padding: "8px 10px",
        margin: "6px 0 0",
        maxHeight: 220,
        overflow: "auto",
        userSelect: "text",
      }}
    >
      {patch.split("\n").map((line, i) => (
        <div
          key={i}
          style={{
            color: line.startsWith("+")
              ? "var(--clay)"
              : line.startsWith("-")
                ? "var(--error)"
                : "var(--ink-muted)",
            whiteSpace: "pre-wrap",
          }}
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

function FileRow({
  file,
  taskId,
  checked,
  onToggle,
}: {
  file: FileDiffSummary;
  taskId: string;
  checked: boolean;
  onToggle: () => void;
}) {
  const [open, setOpen] = useState(false);
  const overlapping = file.attribution === "both";

  return (
    <div style={{ borderTop: "1px solid var(--border)", padding: "7px 0" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 11 }}>
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          style={{ accentColor: "var(--clay)" }}
          title="Select for restore"
        />
        {/* The name opens the file in Changes, where diffs live and stay
            live; the twisty is for a quick look without leaving the panel.
            Two targets, because "expand here" and "go read it properly" are
            different intentions. */}
        <button
          className="btn quiet"
          style={{
            flex: 1,
            minWidth: 0,
            justifyContent: "flex-start",
            color: "var(--ink)",
            fontSize: 11,
            padding: "0 2px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          onClick={() => useLayout.getState().showInChanges(file.relPath)}
          title={`Open ${file.relPath} in Changes`}
        >
          {file.oldPath ? `${file.oldPath} → ${file.relPath}` : file.relPath}
        </button>
        <button
          className="btn icon"
          aria-label={open ? "Hide diff" : "Show diff here"}
          aria-expanded={open}
          title={open ? "Hide diff" : "Show diff here"}
          onClick={() => setOpen((o) => !o)}
          style={{ padding: 2, color: "var(--ink-faint)" }}
        >
          {open ? <ChevronDown size={12} strokeWidth={2} /> : <ChevronRight size={12} strokeWidth={2} />}
        </button>
        <span style={{ color: "var(--ink-faint)", fontSize: 10 }}>
          {STATUS_LABEL[file.status] ?? file.status}
        </span>
        {!file.isBinary && (
          <span style={{ fontSize: 10 }}>
            <span style={{ color: "var(--clay-text)" }}>+{file.insertions}</span>{" "}
            <span style={{ color: "var(--error)" }}>−{file.deletions}</span>
          </span>
        )}
      </div>
      {overlapping && (
        <div style={{ fontSize: 10, color: "var(--ink-muted)", paddingLeft: 22, marginTop: 3 }}>
          ⚠ you also edited this file during the task
        </div>
      )}
      {open && !file.isBinary && (
        <div style={{ paddingLeft: 22 }}>
          <PatchView taskId={taskId} relPath={file.relPath} />
        </div>
      )}
    </div>
  );
}

export function ReviewPanel() {
  const taskId = useChat((s) => s.taskId);
  const status = useChat((s) => s.status);
  const workspace = useWorkspace((s) => s.workspace);
  const loadChildren = useWorkspace((s) => s.loadChildren);

  const [diff, setDiff] = useState<TaskDiff | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [done, setDone] = useState<"kept" | "restored" | null>(null);
  const [busy, setBusy] = useState(false);

  // "awaiting-input" is the settled state now: the agent finished a turn and
  // is waiting, which is exactly when changes are worth reviewing.
  const terminal = status === "awaiting-input" || status === "failed";

  useEffect(() => {
    if (!taskId || !terminal) return;
    setDone(null);
    setResult(null);
    void ipc
      .reviewTaskDiff(taskId)
      .then((d) => {
        setDiff(d);
        // Default selection: agent-only changes. Files the user also touched
        // stay unchecked — restoring those would discard their work too.
        setSelected(
          new Set(d.files.filter((f) => f.attribution === "agent_only").map((f) => f.relPath)),
        );
      })
      .catch(() => setDiff(null));
  }, [taskId, terminal]);

  if (!taskId || !terminal || !diff) return null;

  if (done) {
    return (
      <div className="panel-empty">
        {done === "kept" ? "Changes kept." : "Restored to the pre-task checkpoint."}
        {result && result.trashed.length > 0 && (
          <div style={{ marginTop: 4, color: "var(--ink-faint)" }}>
            {result.trashed.length} created file(s) moved to Trash.
          </div>
        )}
      </div>
    );
  }

  if (diff.files.length === 0) {
    return <div className="panel-empty">No file changes in this task.</div>;
  }

  const toggle = (p: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  const keep = async () => {
    setBusy(true);
    await ipc.reviewKeep(taskId).catch(() => {});
    setDone("kept");
    setBusy(false);
  };

  const restore = async () => {
    setBusy(true);
    try {
      const r = await ipc.reviewRestore(taskId, [...selected]);
      setResult(r);
      setDone("restored");
      if (workspace) void loadChildren("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--ink-muted)", marginBottom: 4 }}>
        {diff.files.length} file{diff.files.length === 1 ? "" : "s"} changed
      </div>
      {diff.files.map((f) => (
        <FileRow
          key={f.relPath}
          file={f}
          taskId={taskId}
          checked={selected.has(f.relPath)}
          onToggle={() => toggle(f.relPath)}
        />
      ))}
      {diff.skipped.length > 0 && (
        <div style={{ fontSize: 10, color: "var(--ink-faint)", marginTop: 6 }}>
          {diff.skipped.length} file(s) too large to checkpoint — not restorable.
        </div>
      )}
      {/* Small, like everything else in an inspector panel. At full size these
          two read as a dialog that had wandered into a sidebar. */}
      <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
        <button className="btn primary small" disabled={busy} onClick={() => void keep()}>
          Keep
        </button>
        <button
          className="btn small"
          disabled={busy || selected.size === 0}
          onClick={() => void restore()}
          title="Restore selected files to their pre-task state (undoable)"
        >
          Restore {selected.size > 0 ? `(${selected.size})` : ""}
        </button>
      </div>
    </div>
  );
}
