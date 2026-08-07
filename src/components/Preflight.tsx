import { AlertCircle, CheckCircle2, Copy, RefreshCw, XCircle } from "lucide-react";
import { useState } from "react";
import { useWorkspace } from "../store/workspace";
import type { PreflightCheck } from "../ipc/client";

/**
 * What each check means, in plain language.
 *
 * The raw titles came from the Rust preflight and assumed you already knew what
 * prime-agent is — exactly the wrong assumption for a diagnostics screen. Each
 * row now says what the thing is and what breaks without it.
 */
const EXPLAIN: Record<string, string> = {
  executable:
    "The prime-agent command-line tool. Workbench doesn't talk to model providers itself — it drives this tool, which makes the file edits and runs the commands. Without it, tasks can't run at all.",
  version:
    "Which version of that tool is installed. Workbench speaks a specific version of its protocol; too old and conversations break confusingly instead of failing cleanly.",
  kernel:
    "A small Python environment the tool creates for itself the first time it runs. If it's missing, tasks start fine and then fail the moment the agent tries to do anything.",
  auth:
    "Provider credentials already on this Mac, set up outside Workbench. They can be reused as-is — Workbench never copies or stores them.",
};

function levelIcon(level: PreflightCheck["level"]) {
  if (level === "ok")
    return <CheckCircle2 size={14} strokeWidth={1.8} style={{ color: "var(--diff-add)" }} />;
  if (level === "warn")
    return <AlertCircle size={14} strokeWidth={1.8} style={{ color: "var(--clay-text)" }} />;
  return <XCircle size={14} strokeWidth={1.8} style={{ color: "var(--error)" }} />;
}

function CheckRow({ check }: { check: PreflightCheck }) {
  const [copied, setCopied] = useState(false);
  const explain = EXPLAIN[check.id];

  return (
    <div
      style={{
        display: "flex",
        gap: "var(--s-3)",
        padding: "var(--s-3) 0",
        borderTop: "1px solid var(--border)",
      }}
    >
      <span style={{ marginTop: 2, flexShrink: 0, display: "inline-flex" }}>
        {levelIcon(check.level)}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "var(--text-sm)", color: "var(--ink)" }}>{check.title}</div>
        {explain && (
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-muted)",
              marginTop: 3,
              lineHeight: 1.5,
            }}
          >
            {explain}
          </div>
        )}
        {check.detail && (
          <div
            style={{
              fontSize: 11,
              fontFamily: "var(--mono)",
              color: "var(--ink-faint)",
              marginTop: 4,
              overflowWrap: "anywhere",
              userSelect: "text",
            }}
          >
            {check.detail}
          </div>
        )}
        {check.fix?.kind === "copyCommand" && (
          <button
            className="btn"
            style={{ fontSize: "var(--text-xs)", marginTop: "var(--s-2)", padding: "4px 10px" }}
            onClick={() => {
              if (check.fix?.kind === "copyCommand") {
                void navigator.clipboard.writeText(check.fix.command);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1600);
              }
            }}
          >
            <Copy size={12} strokeWidth={1.8} />
            {copied ? "Copied — paste it in Terminal" : check.fix.label}
          </button>
        )}
      </div>
    </div>
  );
}

export function PreflightPanel() {
  const preflight = useWorkspace((s) => s.preflight);
  const refresh = useWorkspace((s) => s.refreshPreflight);

  if (!preflight) {
    return <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-faint)" }}>Checking…</div>;
  }

  const failing = preflight.checks.filter((c) => c.level === "fail").length;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--s-3)",
          fontSize: "var(--text-sm)",
          color: "var(--ink-muted)",
          marginBottom: "var(--s-2)",
        }}
      >
        <span style={{ flex: 1 }}>
          {failing === 0
            ? "Everything Workbench needs to run agent tasks is in place."
            : `${failing} thing${failing === 1 ? "" : "s"} need attention before tasks can run.`}
        </span>
        <button
          className="btn"
          style={{ fontSize: "var(--text-xs)", padding: "4px 10px" }}
          onClick={() => void refresh()}
        >
          <RefreshCw size={12} strokeWidth={1.8} />
          Re-check
        </button>
      </div>
      {preflight.checks.map((c) => (
        <CheckRow key={c.id} check={c} />
      ))}
    </div>
  );
}
