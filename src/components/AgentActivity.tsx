import { DotMatrix } from "./DotMatrix";
import { useTasks } from "../store/tasks";

const LABELS: Record<string, string> = {
  idle: "AWAITING INPUT",
  starting: "STARTING",
  running: "THINKING",
  succeeded: "COMPLETE",
  failed: "FAILED",
  cancelled: "STOPPED",
};

export function AgentActivity() {
  const status = useTasks((s) => s.status);
  const matrix = useTasks((s) => s.matrix);
  const toolFeed = useTasks((s) => s.toolFeed);
  const text = useTasks((s) => s.text);
  const error = useTasks((s) => s.error);
  const resolved = useTasks((s) => s.resolvedProfile);
  const stopTask = useTasks((s) => s.stopTask);

  const label =
    matrix === "running-tools" ? "RUNNING TOOLS" : (LABELS[status] ?? status.toUpperCase());

  return (
    <div
      style={{
        border: "1px solid var(--structure-strong)",
        borderRadius: "var(--r)",
        background: "var(--surface)",
        padding: 12,
      }}
    >
      <div className="state-row" style={{ marginBottom: toolFeed.length || text ? 12 : 0 }}>
        <DotMatrix state={matrix} />
        <div style={{ flex: 1 }}>
          {/* Agent state changes without user action, so it is announced.
              The label is always present — motion and colour never carry
              state on their own. */}
          <div
            className="state-label"
            role="status"
            aria-live="polite"
            style={status === "failed" ? { color: "var(--danger)" } : undefined}
          >
            {label}
          </div>
          <div className="state-sub">
            {resolved
              ? `${resolved.profile.label}${resolved.profile.modelId ? ` · ${resolved.profile.modelId}` : ""}`
              : "no profile"}
          </div>
        </div>
        {(status === "running" || status === "starting") && (
          <button className="btn" style={{ fontSize: 10 }} onClick={() => void stopTask(false)}>
            Stop
          </button>
        )}
      </div>

      {toolFeed.map((row, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            gap: 8,
            fontSize: 11,
            padding: "5px 0",
            borderTop: "1px solid var(--structure)",
            color: "var(--ink-muted)",
          }}
        >
          <span style={{ color: "var(--ink-faint)", flexShrink: 0 }}>{row.time}</span>
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {row.name}
          </span>
          <span
            style={{
              color:
                row.status === "ok"
                  ? "var(--accent)"
                  : row.status === "error"
                    ? "var(--danger)"
                    : "var(--ink-faint)",
            }}
          >
            <span aria-hidden>
              {row.status === "running" ? "…" : row.status === "ok" ? "✓" : "✕"}
            </span>
            <span className="sr-only">{row.status}</span>
          </span>
        </div>
      ))}

      {text && (
        <div
          style={{
            marginTop: 10,
            paddingTop: 10,
            borderTop: "1px solid var(--structure)",
            fontFamily: "var(--serif)",
            fontSize: 13.5,
            lineHeight: 1.55,
            color: "var(--ink)",
            maxHeight: 260,
            overflowY: "auto",
            whiteSpace: "pre-wrap",
            userSelect: "text",
          }}
        >
          {text}
        </div>
      )}

      {error && (
        <div
          role="alert"
          style={{
            marginTop: 10,
            fontSize: 11,
            color: "var(--danger)",
            userSelect: "text",
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
