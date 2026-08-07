/**
 * Fixtures here are copied verbatim from a live prime-agent capture
 * (openrouter/openai-gpt-4o-mini, 2026-08-07) rather than written from the
 * docs — every bug this file guards came from the wire shape differing from
 * what the code assumed.
 */
import { describe, expect, it } from "vitest";
import {
  describeMessage,
  extractDelta,
  summarizeToolArgs,
  textFromMessage,
  toolResultText,
} from "./normalize";

describe("extractDelta", () => {
  it("takes text deltas", () => {
    expect(extractDelta({ type: "text_delta", contentIndex: 0, delta: " development" })).toBe(
      " development",
    );
  });

  /** The regression that put raw JSON in the middle of the reply. */
  it("ignores tool-call deltas, which reuse the `delta` field", () => {
    const streamed = [
      { type: "toolcall_start", contentIndex: 0 },
      { type: "toolcall_delta", contentIndex: 0, delta: '{"' },
      { type: "toolcall_delta", contentIndex: 0, delta: "code" },
      { type: "toolcall_delta", contentIndex: 0, delta: '":"' },
      { type: "toolcall_delta", contentIndex: 0, delta: "import os" },
      { type: "toolcall_end", contentIndex: 0 },
    ];
    expect(streamed.map(extractDelta).join("")).toBe("");
  });

  it("does not repeat the message when text_end replays it", () => {
    const stream = [
      { type: "text_start", contentIndex: 0 },
      { type: "text_delta", contentIndex: 0, delta: "Hello " },
      { type: "text_delta", contentIndex: 0, delta: "world" },
      { type: "text_end", contentIndex: 0, content: "Hello world" },
    ];
    expect(stream.map(extractDelta).join("")).toBe("Hello world");
  });

  it("still reads an untyped event, so an upstream change degrades gracefully", () => {
    expect(extractDelta({ delta: "hi" })).toBe("hi");
    expect(extractDelta({ delta: { text: "hi" } })).toBe("hi");
    expect(extractDelta({ text: "hi" })).toBe("hi");
  });

  it("survives junk", () => {
    for (const v of [null, undefined, 42, "str", {}, []]) {
      expect(extractDelta(v)).toBe("");
    }
  });
});

describe("textFromMessage", () => {
  it("reads assistant text parts", () => {
    expect(
      textFromMessage({
        role: "assistant",
        content: [{ type: "text", text: "The project contains a README file." }],
      }),
    ).toBe("The project contains a README file.");
  });

  /** A toolCall part has no text; it must not be stringified into the reply. */
  it("renders nothing for a tool-call part", () => {
    expect(
      textFromMessage({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_Js7O26OJU3Zj7RaIN0w8zzW9",
            name: "ipython",
            arguments: { code: "import os\nos.listdir('.')" },
          },
        ],
      }),
    ).toBe("");
  });

  it("keeps the text when a turn mixes prose and a tool call", () => {
    expect(
      textFromMessage({
        role: "assistant",
        content: [
          { type: "text", text: "Let me look. " },
          { type: "toolCall", name: "ipython", arguments: { code: "1+1" } },
        ],
      }),
    ).toBe("Let me look. ");
  });
});

describe("describeMessage", () => {
  it("surfaces errorMessage, which agent_end alone would hide", () => {
    const m = describeMessage({
      role: "assistant",
      content: [],
      errorMessage: "Insufficient balance",
    });
    expect(m.errorMessage).toBe("Insufficient balance");
  });
});

describe("summarizeToolArgs", () => {
  it("summarises an ipython call by its code", () => {
    expect(summarizeToolArgs({ code: "import os\nos.listdir('.')" })).toBe(
      "import os os.listdir('.')",
    );
  });

  it("prefers the command-like field over incidental ones", () => {
    expect(summarizeToolArgs({ timeout: 30, command: "git status" })).toBe("git status");
  });

  it("falls back to the first scalar for an unknown tool", () => {
    expect(summarizeToolArgs({ thing: "value" })).toBe("thing: value");
  });

  it("truncates rather than flooding the row", () => {
    const out = summarizeToolArgs({ code: "x".repeat(500) });
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns empty for junk", () => {
    expect(summarizeToolArgs(null)).toBe("");
    expect(summarizeToolArgs({})).toBe("");
  });
});

describe("toolResultText", () => {
  it("reads the content parts of a real tool_execution_end result", () => {
    expect(
      toolResultText({
        content: [{ type: "text", text: "['README.md', 'src']" }],
        details: { durationMs: 5, status: "ok", stdout: "", stderr: "", result: "['README.md', 'src']" },
        isError: false,
      }),
    ).toBe("['README.md', 'src']");
  });

  it("falls back to details when content is empty", () => {
    expect(toolResultText({ content: [], details: { stdout: "compiled ok" } })).toBe("compiled ok");
  });

  it("returns empty when there is nothing to show", () => {
    expect(toolResultText({ content: [], details: {} })).toBe("");
    expect(toolResultText(null)).toBe("");
  });
});
