import { ArrowDown, Check, FileText, Image as ImageIcon, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Attachment } from "../chat/attachments";
import { isAtBottom } from "../chat/follow";
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

/** Renders `@path` references in the accent colour, as typed. */
function UserText({ text }: { text: string }) {
  // Split on the same shape `extractMentions` recognises, keeping the
  // separators so the message reads exactly as it was written.
  const parts = text.split(/((?:^|\s)@[^\s]+)/g);
  return (
    <>
      {parts.map((part, i) => {
        const m = /^(\s*)@([^\s]+)$/.exec(part);
        if (!m) return <span key={i}>{part}</span>;
        return (
          <span key={i}>
            {m[1]}
            <span
              style={{
                color: "var(--clay-text)",
                fontFamily: "var(--mono)",
                fontSize: "0.95em",
              }}
            >
              @{m[2]}
            </span>
          </span>
        );
      })}
    </>
  );
}

/**
 * What was attached, on the turn it was attached to.
 *
 * The record should say what the agent was given, not only what was typed —
 * scrolling back to "why did it think that?" is a different question if the
 * message came with a screenshot.
 */
function TurnAttachments({ attachments }: { attachments: Attachment[] }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
      {attachments.map((a) => (
        <span
          key={a.path}
          className="chip"
          title={a.path}
          style={{ fontSize: "var(--text-xs)", maxWidth: 220 }}
        >
          {a.kind === "image" ? (
            <ImageIcon size={10} strokeWidth={1.8} style={{ flexShrink: 0 }} />
          ) : (
            <FileText size={10} strokeWidth={1.8} style={{ flexShrink: 0 }} />
          )}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {a.name}
          </span>
        </span>
      ))}
    </div>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  if (turn.role === "user") {
    return (
      <div className="turn-user">
        {turn.attachments?.length ? <TurnAttachments attachments={turn.attachments} /> : null}
        <UserText text={turn.text} />
        {/* A user turn can carry a notice too: an image that would not load is
            said here rather than leaving you to infer it from an answer that
            never mentions the picture. */}
        {turn.notice && (
          <div
            role="status"
            style={{ color: "var(--error)", fontSize: "var(--text-xs)", marginTop: 6 }}
          >
            {turn.notice}
          </div>
        )}
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
      {turn.notice && !turn.error && (
        <div
          role="status"
          className="card"
          style={{
            borderColor: "var(--border-strong)",
            color: "var(--ink-muted)",
            fontSize: "var(--text-sm)",
          }}
        >
          {turn.notice}
        </div>
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
  const colRef = useRef<HTMLDivElement>(null);
  // A ref, not state: the streaming effect reads it on every delta and must
  // see the current value without re-subscribing.
  const pinnedRef = useRef(true);
  const [adrift, setAdrift] = useState(false);

  // Whether the view is sitting at the bottom.
  //
  // This is the whole fix. Following the stream unconditionally means that
  // scrolling up to re-read something is a fight: every token yanks you back
  // down, and the harder you scroll the more it pulls. Reading is a deliberate
  // act, so it wins — following resumes when you return to the bottom.
  useEffect(() => {
    const scroller = colRef.current?.closest(".canvas") as HTMLElement | null;
    if (!scroller) return;
    const onScroll = () => {
      const atBottom = isAtBottom(
        scroller.scrollHeight,
        scroller.scrollTop,
        scroller.clientHeight,
      );
      pinnedRef.current = atBottom;
      setAdrift(!atBottom);
    };
    onScroll();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [turns.length === 0]);

  // A new turn means you just acted, or the agent just began a reply to
  // something you sent. Either way you want to see it, so following resumes.
  useEffect(() => {
    if (turns.length === 0) return;
    pinnedRef.current = true;
    setAdrift(false);
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns.length]);

  // Streaming text: follow only while pinned.
  useEffect(() => {
    if (!pinnedRef.current) return;
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns[turns.length - 1]?.text]);

  const toLatest = () => {
    pinnedRef.current = true;
    setAdrift(false);
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  };

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
    <div className="chat-col" ref={colRef}>
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
      {/* Sticky, so it rides the bottom edge of the scrollport while you read
          above it. Only while the agent is still writing: when nothing is
          being added, scrolling up is just reading and needs no way back. */}
      {adrift && busy && (
        <div
          style={{
            position: "sticky",
            bottom: "var(--s-3)",
            display: "flex",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <button
            className="btn"
            onClick={toLatest}
            style={{
              pointerEvents: "auto",
              fontSize: "var(--text-xs)",
              padding: "4px 12px",
              background: "var(--canvas)",
              boxShadow: "var(--lift-strong)",
              borderRadius: "var(--r-pill)",
            }}
          >
            <ArrowDown size={11} strokeWidth={2} />
            Jump to latest
          </button>
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}
