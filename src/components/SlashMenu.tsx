import { useEffect, useMemo, useState } from "react";
import { Sparkles, Zap } from "lucide-react";
import { fuzzyScore } from "../commands/registry";
import { ipc, type AgentCommand } from "../ipc/client";
import { useChat } from "../store/chat";

/**
 * Slash-command autocomplete for the composer.
 *
 * Built-in actions map to real RPC commands Workbench can drive. Skills come
 * from the running agent's own `get_commands` — discovered rather than
 * hardcoded, so a newly installed skill shows up without a release.
 */
export function SlashMenu({
  query,
  onPick,
  onClose,
}: {
  query: string;
  onPick: (cmd: AgentCommand) => void;
  onClose: () => void;
}) {
  const taskId = useChat((s) => s.taskId);
  const [commands, setCommands] = useState<AgentCommand[]>([]);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    void ipc.agentCommands(taskId).then(setCommands).catch(() => setCommands([]));
  }, [taskId]);

  const rows = useMemo(() => {
    const q = query.replace(/^\//, "");
    return commands
      .map((c) => ({ c, s: fuzzyScore(c.name, q) }))
      .filter((x): x is { c: AgentCommand; s: number } => x.s !== null)
      .sort((a, b) => b.s - a.s)
      .slice(0, 8)
      .map((x) => x.c);
  }, [commands, query]);

  useEffect(() => setIndex(0), [query]);

  // Arrow/enter/escape are handled by the composer and routed here.
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
      aria-label="Commands"
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
      {rows.map((c, i) => (
        <div
          key={`${c.kind}:${c.name}`}
          role="option"
          aria-selected={i === index}
          onMouseEnter={() => setIndex(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(c);
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
            {c.kind === "action" ? <Zap size={12} strokeWidth={1.8} /> : <Sparkles size={12} strokeWidth={1.8} />}
          </span>
          <span style={{ fontFamily: "var(--mono)", fontSize: "var(--text-sm)", color: "var(--ink)", flexShrink: 0 }}>
            /{c.name}
          </span>
          <span
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {c.description}
          </span>
        </div>
      ))}
    </div>
  );
}
