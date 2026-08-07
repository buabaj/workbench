/**
 * Reading text out of prime-agent's message payloads.
 *
 * Verified against a live capture (2026-08-07): a run emits
 *   agent_start · turn_start · message_start · message_end · turn_end · agent_end
 * and — critically — **no `message_update` events at all** on this path. The
 * assistant's text lives in `message.content`, an array of parts:
 *
 *   { role: "assistant",
 *     content: [ { type: "text", text: "…" } ],
 *     model, provider, usage, stopReason, errorMessage? }
 *
 * Reading only `message_update.assistantMessageEvent` therefore rendered
 * nothing. Both paths are handled here: deltas when they arrive, content parts
 * otherwise.
 *
 * `errorMessage` is the other half of the same bug — a failed request still
 * emits agent_end, so ignoring it made a hard failure look like "complete"
 * with an empty reply.
 */

export interface MessageParts {
  role: string;
  text: string;
  errorMessage?: string;
  model?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Text from a `message` object's content parts. */
export function textFromMessage(message: unknown): string {
  if (!isRecord(message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!isRecord(part)) return "";
      // Observed: {type:"text", text:"…"}. Tolerate a couple of near variants
      // rather than silently dropping content if the shape shifts upstream.
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .join("");
}

export function describeMessage(message: unknown): MessageParts {
  if (!isRecord(message)) return { role: "", text: "" };
  return {
    role: typeof message.role === "string" ? message.role : "",
    text: textFromMessage(message),
    errorMessage:
      typeof message.errorMessage === "string" && message.errorMessage
        ? message.errorMessage
        : undefined,
    model: typeof message.model === "string" ? message.model : undefined,
  };
}

/**
 * Streaming delta, when `message_update` is emitted. Its internal discriminants
 * are still unverified upstream, so this stays tolerant.
 * TIGHTEN-LATER(assistant-message-event): this is the only site that reads it.
 */
export function extractDelta(ev: unknown): string {
  if (!isRecord(ev)) return "";
  if (typeof ev.delta === "string") return ev.delta;
  if (typeof ev.text === "string") return ev.text;
  const delta = ev.delta;
  if (isRecord(delta) && typeof delta.text === "string") return delta.text;
  return "";
}
