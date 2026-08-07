/**
 * Reading text out of prime-agent's message payloads.
 *
 * Verified against live captures. A run emits
 *   agent_start · turn_start · (message_start · message_update* · message_end)+
 *   · tool_execution_start · tool_execution_end · turn_end · agent_end
 *
 * The assistant's text lives in `message.content`, an array of parts:
 *
 *   { role: "assistant",
 *     content: [ { type: "text", text: "…" } ],
 *     model, provider, usage, stopReason, errorMessage? }
 *
 * A tool call is a part of the SAME shape family but carries no text:
 *
 *   { type: "toolCall", id, name: "ipython", arguments: { code: "…" } }
 *
 * `message_update` is not always emitted — an early capture had none, and text
 * arrived only via content parts — so both paths are handled here.
 *
 * The `assistantMessageEvent` discriminants are now confirmed:
 *   text_start · text_delta · text_end · toolcall_start · toolcall_delta · toolcall_end
 * Crucially, BOTH text and tool-call streams use a field called `delta`, so
 * reading it without checking `type` splices the tool's raw JSON arguments into
 * the middle of the visible reply. That is what put
 * `{"code": "import os\nos.listdir()"}` in the chat.
 *
 * `errorMessage` is the other half of an older bug — a failed request still
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
      // Tool calls live alongside text parts and must not be rendered as prose.
      if (part.type === "toolCall" || part.type === "tool_use") return "";
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
 * Visible text from a `message_update`, and nothing else.
 *
 * Only the `text_*` stream reaches the reply. `toolcall_delta` carries the
 * tool's arguments through the identically-named `delta` field; those are
 * rendered as a tool row instead (see `summarizeToolArgs`).
 *
 * An event with no `type` at all falls through to the tolerant path, so an
 * upstream shape change degrades to "still shows the text" rather than blank.
 * TIGHTEN-LATER(assistant-message-event): this is the only site that reads it.
 */
export function extractDelta(ev: unknown): string {
  if (!isRecord(ev)) return "";
  const type = typeof ev.type === "string" ? ev.type : "";
  if (type && !type.startsWith("text")) return "";
  // `text_end` repeats the whole message in `content`; the deltas already
  // built it, and `message_end` is the backstop, so taking it here would
  // double the reply.
  if (type === "text_end") return "";
  if (typeof ev.delta === "string") return ev.delta;
  const delta = ev.delta;
  if (isRecord(delta) && typeof delta.text === "string") return delta.text;
  if (typeof ev.text === "string") return ev.text;
  return "";
}

/** The field of a tool's arguments that reads as "what it is doing". */
const ARG_PRIORITY = [
  "command",
  "code",
  "query",
  "pattern",
  "path",
  "file_path",
  "filePath",
  "url",
  "message",
];

function condense(s: string, max = 120): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * One line describing a tool invocation, for the activity row.
 *
 * The arguments used to reach the user by accident, as streamed JSON in the
 * middle of the answer. Showing them deliberately — and briefly — keeps the
 * information without the mess.
 */
export function summarizeToolArgs(args: unknown): string {
  if (typeof args === "string") return condense(args);
  if (!isRecord(args)) return "";
  for (const key of ARG_PRIORITY) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return condense(v);
  }
  // Unknown tool: show its first scalar argument rather than nothing.
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" && v.trim()) return condense(`${k}: ${v}`);
    if (typeof v === "number" || typeof v === "boolean") return `${k}: ${v}`;
  }
  return "";
}

/** Readable output from a `tool_execution_end` result payload. */
export function toolResultText(result: unknown): string {
  if (typeof result === "string") return condense(result, 200);
  if (!isRecord(result)) return "";

  const content = result.content;
  if (Array.isArray(content)) {
    const text = content
      .map((p) => (isRecord(p) && typeof p.text === "string" ? p.text : ""))
      .join("")
      .trim();
    if (text) return condense(text, 200);
  }
  if (typeof content === "string" && content.trim()) return condense(content, 200);

  const details = result.details;
  if (isRecord(details)) {
    for (const key of ["result", "stdout", "stderr"]) {
      const v = details[key];
      if (typeof v === "string" && v.trim()) return condense(v, 200);
    }
  }
  return "";
}
