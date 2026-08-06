import { useWorkspace } from "../store/workspace";
import type { PreflightCheck } from "../ipc/client";

function levelColor(level: PreflightCheck["level"]): string {
  switch (level) {
    case "ok":
      return "var(--clay)";
    case "warn":
      return "var(--ink-muted)";
    case "fail":
      return "var(--error)";
  }
}

function CheckRow({ check }: { check: PreflightCheck }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        alignItems: "baseline",
        padding: "7px 0",
        borderTop: "1px solid var(--border)",
        fontSize: 11.5,
        maxWidth: 520,
        textAlign: "left",
      }}
    >
      <span style={{ color: levelColor(check.level), fontSize: 10 }}>
        {check.level === "ok" ? "●" : check.level === "warn" ? "◐" : "○"}
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ color: "var(--ink)" }}>{check.title}</div>
        {check.detail && (
          <div style={{ color: "var(--ink-faint)", fontSize: 10.5, marginTop: 2 }}>
            {check.detail}
          </div>
        )}
      </div>
      {check.fix?.kind === "copyCommand" && (
        <button
          className="btn"
          style={{ fontSize: 10 }}
          onClick={() => {
            if (check.fix?.kind === "copyCommand") {
              void navigator.clipboard.writeText(check.fix.command);
            }
          }}
        >
          {check.fix.label}
        </button>
      )}
    </div>
  );
}

export function PreflightPanel() {
  const preflight = useWorkspace((s) => s.preflight);
  const refresh = useWorkspace((s) => s.refreshPreflight);

  if (!preflight) {
    return <div style={{ fontSize: 11, color: "var(--ink-faint)" }}>checking agent runtime…</div>;
  }
  return (
    <div style={{ width: 520 }}>
      <div
        style={{
          fontSize: 10,
          letterSpacing: "0.14em",
          color: "var(--ink-faint)",
          marginBottom: 6,
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>AGENT RUNTIME</span>
        <button
          className="btn"
          style={{ fontSize: 9, padding: "2px 8px" }}
          onClick={() => void refresh()}
        >
          rescan
        </button>
      </div>
      {preflight.checks.map((c) => (
        <CheckRow key={c.id} check={c} />
      ))}
    </div>
  );
}
