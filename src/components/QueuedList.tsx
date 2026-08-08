import { Play, X } from "lucide-react";
import { useState } from "react";
import { useChat } from "../store/chat";

/**
 * Prompts waiting their turn, above the composer.
 *
 * Each shows the mode or command it was typed under, because that is what it
 * will run as — a queued `/plan` stays a plan even if you have since switched
 * to `/explain`. Both are editable until the item starts, which is the whole
 * point of a queue you can see.
 */
function Row({ id }: { id: string }) {
  const item = useChat((s) => s.queue.find((q) => q.id === id));
  const editQueued = useChat((s) => s.editQueued);
  const setQueuedTemplates = useChat((s) => s.setQueuedTemplates);
  const removeQueued = useChat((s) => s.removeQueued);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  if (!item) return null;

  const commit = () => {
    const next = draft.trim();
    // An emptied row is a removal — there is nothing to send.
    if (!next) removeQueued(item.id);
    else editQueued(item.id, next);
    setEditing(false);
  };

  return (
    <div className="queued-row">
      {/* Both, when both apply: a sticky mode and a one-shot command can be
          set together, and showing one would misrepresent what will run. */}
      {item.mode && (
        <span className="chip mode" style={{ flexShrink: 0 }}>
          <b>{item.mode.name}</b> mode
          <button
            className="chip-x"
            aria-label={`Run this queued prompt without ${item.mode.name} mode`}
            onClick={() => setQueuedTemplates(item.id, null, item.oneShot)}
          >
            <X size={10} strokeWidth={2.2} />
          </button>
        </span>
      )}
      {item.oneShot && (
        <span className="chip mode" style={{ flexShrink: 0 }}>
          <b>/{item.oneShot.name}</b>
          <button
            className="chip-x"
            aria-label={`Run this queued prompt without /${item.oneShot.name}`}
            onClick={() => setQueuedTemplates(item.id, item.mode, null)}
          >
            <X size={10} strokeWidth={2.2} />
          </button>
        </span>
      )}

      {editing ? (
        <input
          className="field"
          autoFocus
          style={{ flex: 1, fontSize: "var(--text-sm)", padding: "2px 6px" }}
          aria-label="Edit queued prompt"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          className="queued-text"
          title="Edit before it runs"
          onClick={() => {
            setDraft(item.text);
            setEditing(true);
          }}
        >
          {item.text}
        </button>
      )}

      <button
        className="btn icon queued-x"
        aria-label={`Remove "${item.text.slice(0, 40)}" from the queue`}
        title="Remove"
        onClick={() => removeQueued(item.id)}
        style={{ padding: 2, color: "var(--ink-faint)", flexShrink: 0 }}
      >
        <X size={11} strokeWidth={2} />
      </button>
    </div>
  );
}

export function QueuedList() {
  const queue = useChat((s) => s.queue);
  const paused = useChat((s) => s.queuePaused);
  const resumeQueue = useChat((s) => s.resumeQueue);

  if (queue.length === 0) return null;

  return (
    <div className="composer-meta" style={{ display: "block" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--s-2)",
          fontSize: "var(--text-xs)",
          color: "var(--ink-faint)",
          padding: "0 2px 3px",
        }}
      >
        <span>
          {queue.length} queued
          {paused && " — held"}
        </span>
        {paused && (
          <>
            <span style={{ color: "var(--ink-muted)" }}>
              the last turn stopped, so nothing starts on its own
            </span>
            <button
              className="btn"
              style={{ fontSize: "var(--text-xs)", padding: "1px 8px", gap: 4 }}
              onClick={resumeQueue}
            >
              <Play size={10} strokeWidth={2.2} />
              Resume
            </button>
          </>
        )}
      </div>
      {queue.map((q) => (
        <Row key={q.id} id={q.id} />
      ))}
    </div>
  );
}
