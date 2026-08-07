import { Check, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { AgentOrb, PHASE_LABEL } from "./AgentOrb";
import { Markdown } from "./Markdown";
import { useChat, type Turn } from "../store/chat";

const PROMPTS = [
  "What are we building?",
  "What's on the workbench today?",
  "Point me at something.",
  "What should we take apart?",
  "Hand me the next problem.",
];

/** Chosen once per launch: alive, but it won't change under you mid-thought. */
export const PLACEHOLDER = PROMPTS[Math.floor(Math.random() * PROMPTS.length)];

function Tools({ tools }: { tools: Turn["tools"] }) {
  if (tools.length === 0) return null;
  return (
    <div style={{ margin: "var(--s-2) 0 var(--s-3)" }}>
      {tools.map((row, i) => (
        <div key={i} style={{ padding: "2px 0" }}>
          <div
            style={{
              display: "flex",
              gap: "var(--s-2)",
              alignItems: "baseline",
              fontSize: "var(--text-xs)",
              fontFamily: "var(--mono)",
              color: "var(--ink-muted)",
            }}
          >
            <span style={{ color: "var(--ink-faint)", flexShrink: 0 }}>{row.time}</span>
            <span style={{ flexShrink: 0 }}>{row.name}</span>
            {/* What the tool was asked to do. This used to reach the user by
                accident, as streamed JSON spliced into the reply. */}
            {row.detail && (
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: "var(--ink-faint)",
                }}
                title={row.detail}
              >
                {row.detail}
              </span>
            )}
            <span
              style={{
                display: "inline-flex",
                marginLeft: row.detail ? 0 : "auto",
                flexShrink: 0,
                color:
                  row.status === "ok"
                    ? "var(--diff-add)"
                    : row.status === "error"
                      ? "var(--error)"
                      : "var(--ink-faint)",
              }}
            >
              {row.status === "running" ? "…" : row.status === "ok" ? <Check size={12} /> : <X size={12} />}
              <span className="sr-only">{row.status}</span>
            </span>
          </div>
          {row.output && (
            <div
              style={{
                fontFamily: "var(--mono)",
                fontSize: "var(--text-xs)",
                color: "var(--ink-faint)",
                paddingLeft: "calc(var(--s-2) * 2 + 4.5em)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={row.output}
            >
              {row.output}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  if (turn.role === "user") {
    return (
      <div className="turn-user">
        {turn.text}
      </div>
    );
  }
  return (
    <div className="turn-assistant">
      <Tools tools={turn.tools} />
      {turn.text && <Markdown source={turn.text} className="md md-chat" />}
      {turn.streaming && !turn.text && turn.tools.length === 0 && (
        <div style={{ color: "var(--ink-faint)", fontSize: "var(--text-sm)" }}>Thinking…</div>
      )}
      {turn.error && (
        <div role="alert" className="card" style={{ borderColor: "var(--error)", color: "var(--error)", fontSize: "var(--text-sm)", userSelect: "text" }}>
          {turn.error}
        </div>
      )}
    </div>
  );
}

export function ChatView() {
  const turns = useChat((s) => s.turns);
  const status = useChat((s) => s.status);
  const phase = useChat((s) => s.phase);
  const resolved = useChat((s) => s.resolvedProfile);
  const stop = useChat((s) => s.stop);
  const endRef = useRef<HTMLDivElement>(null);

  // Follow the conversation as it grows, the way a chat should.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns.length, turns[turns.length - 1]?.text]);

  if (turns.length === 0) {
    return (
      <div className="chat-col">
        <div
          style={{
            fontFamily: "var(--serif)",
            fontVariationSettings: "var(--serif-settings)",
            fontSize: "var(--display-sm)",
            color: "var(--ink)",
            letterSpacing: "var(--track-snug)",
            marginBottom: "var(--s-2)",
          }}
        >
          {PLACEHOLDER}
        </div>
        <div style={{ fontSize: "var(--text-base)", color: "var(--ink-muted)" }}>
          Describe a task below, or open a file from the sidebar. Type{" "}
          <span style={{ fontFamily: "var(--mono)", color: "var(--clay-text)" }}>/</span> for commands.
        </div>
      </div>
    );
  }

  const busy = status === "starting" || status === "streaming";

  return (
    <div className="chat-col">
      {turns.map((t) => (
        <TurnView key={t.id} turn={t} />
      ))}

      <div className="state-row" style={{ marginTop: "var(--s-4)" }} role="status" aria-live="polite">
        <AgentOrb phase={phase === "complete" ? "complete" : phase} />
        <span className="state-label">{PHASE_LABEL[phase === "complete" ? "complete" : phase]}</span>
        <span className="state-sub">{resolved?.profile.modelId ?? ""}</span>
        {busy && (
          <button
            className="btn"
            style={{ marginLeft: "auto", fontSize: "var(--text-xs)", padding: "4px 10px" }}
            onClick={() => void stop(false)}
          >
            Stop
          </button>
        )}
      </div>
      <div ref={endRef} />
    </div>
  );
}
