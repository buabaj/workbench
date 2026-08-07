import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, MessageSquare, Trash2 } from "lucide-react";
import { ipc, type SessionSummary } from "../ipc/client";
import { useChat } from "../store/chat";
import { useWorkspace } from "../store/workspace";

/** Recent conversations stay visible; the tail is one click away. Showing 50
 *  rows in a 300px panel buried everything else in the inspector. */
const COLLAPSED_COUNT = 3;

function Row({
  session,
  active,
  onOpen,
  onDelete,
}: {
  session: SessionSummary;
  active: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      style={{
        display: "flex",
        gap: "var(--s-2)",
        alignItems: "center",
        padding: "6px var(--s-2)",
        borderRadius: "var(--r-control)",
        background: active ? "var(--clay-wash)" : "transparent",
        cursor: "default",
        fontSize: "var(--text-sm)",
      }}
      onMouseLeave={() => setConfirming(false)}
    >
      <MessageSquare
        size={12}
        strokeWidth={1.7}
        style={{ color: "var(--ink-faint)", flexShrink: 0 }}
      />
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {session.title || "Untitled"}
      </span>
      <span style={{ color: "var(--ink-faint)", fontSize: "var(--text-xs)", flexShrink: 0 }}>
        {session.turnCount}
      </span>
      <button
        className="btn icon"
        style={{ padding: 3, color: confirming ? "var(--error)" : "var(--ink-faint)" }}
        aria-label={confirming ? `Confirm delete ${session.title}` : `Delete ${session.title}`}
        title={confirming ? "Click again to delete" : "Delete conversation"}
        onClick={(e) => {
          e.stopPropagation();
          // Two-step rather than a modal: deleting history is destructive, but
          // a dialog for every row would be heavier than the action deserves.
          if (confirming) onDelete();
          else setConfirming(true);
        }}
      >
        <Trash2 size={12} strokeWidth={1.8} />
      </button>
    </div>
  );
}

export function SessionsPanel() {
  const workspace = useWorkspace((s) => s.workspace);
  const currentTask = useChat((s) => s.taskId);
  const turnCount = useChat((s) => s.turns.length);
  const loadSession = useChat((s) => s.loadSession);
  const deleteSession = useChat((s) => s.deleteSession);

  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [expanded, setExpanded] = useState(false);

  const reload = () => {
    if (!workspace) return;
    void ipc.chatSessions(workspace.id).then(setSessions).catch(() => setSessions([]));
  };

  useEffect(reload, [workspace?.id, currentTask, turnCount]);

  if (!workspace) return <div className="panel-empty">Open a workspace.</div>;
  if (sessions.length === 0) {
    return <div className="panel-empty">Conversations you start will be listed here.</div>;
  }

  const visible = expanded ? sessions : sessions.slice(0, COLLAPSED_COUNT);
  const hidden = sessions.length - visible.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {visible.map((s) => (
        <Row
          key={s.taskId}
          session={s}
          active={s.taskId === currentTask}
          onOpen={() => void loadSession(s.taskId)}
          onDelete={async () => {
            await deleteSession(s.taskId);
            reload();
          }}
        />
      ))}
      {(hidden > 0 || expanded) && (
        <button
          className="btn quiet"
          style={{ fontSize: "var(--text-xs)", justifyContent: "flex-start", marginTop: 2 }}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <>
              <ChevronDown size={12} strokeWidth={1.8} /> Show less
            </>
          ) : (
            <>
              <ChevronRight size={12} strokeWidth={1.8} /> {hidden} more
            </>
          )}
        </button>
      )}
    </div>
  );
}
