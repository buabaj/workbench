import { describe, expect, it } from "vitest";
import {
  acceptAll,
  acceptSpan,
  findAgentSpans,
  markGenerated,
  rejectSpan,
  unverifiedSummary,
} from "./provenance";

const NOTE = `# Paper

## Notes

<!-- agent gpt-5.1-codex 2026-08-08 -->
The reward model is trained on preference pairs.
<!-- /agent -->

This contradicts Ouyang et al.
`;

describe("markGenerated", () => {
  it("wraps text with its origin", () => {
    const out = markGenerated("  hello  ", "gpt-5.1-codex", "2026-08-08");
    expect(out).toBe("<!-- agent gpt-5.1-codex 2026-08-08 -->\nhello\n<!-- /agent -->");
  });

  /** A space in the name would make the marker unparseable coming back. */
  it("makes a model name safe for the marker", () => {
    expect(markGenerated("x", "some model v2", "2026-01-01")).toContain("agent some-model-v2 ");
  });

  it("survives provider ids with slashes and dots", () => {
    const out = markGenerated("x", "anthropic/claude-haiku-4.5", "2026-01-01");
    expect(findAgentSpans(out)[0].model).toBe("anthropic/claude-haiku-4.5");
  });

  it("round-trips", () => {
    const out = markGenerated("some generated prose", "m", "2026-01-01");
    const [span] = findAgentSpans(out);
    expect(span.text).toBe("some generated prose");
    expect(span.model).toBe("m");
    expect(span.date).toBe("2026-01-01");
  });
});

describe("findAgentSpans", () => {
  it("reads the model, date and text", () => {
    const [span] = findAgentSpans(NOTE);
    expect(span.model).toBe("gpt-5.1-codex");
    expect(span.date).toBe("2026-08-08");
    expect(span.text).toBe("The reward model is trained on preference pairs.");
  });

  it("reports offsets covering the whole block", () => {
    const [span] = findAgentSpans(NOTE);
    expect(NOTE.slice(span.start, span.end)).toContain("<!-- agent");
    expect(NOTE.slice(span.start, span.end)).toContain("<!-- /agent -->");
  });

  it("reports inner offsets covering only the prose", () => {
    const [span] = findAgentSpans(NOTE);
    expect(NOTE.slice(span.textStart, span.textEnd)).toBe(
      "The reward model is trained on preference pairs.",
    );
  });

  it("finds several", () => {
    const two = `${NOTE}\n<!-- agent m2 2026-08-09 -->\nsecond\n<!-- /agent -->\n`;
    expect(findAgentSpans(two).map((s) => s.model)).toEqual(["gpt-5.1-codex", "m2"]);
  });

  /**
   * The dangerous case: deleting a closing marker must not reclassify the
   * whole rest of the file as generated.
   */
  it("ignores an unclosed marker rather than swallowing the file", () => {
    const broken = "<!-- agent m 2026-01-01 -->\neverything after this\n\nmy own careful notes";
    expect(findAgentSpans(broken)).toEqual([]);
  });

  it("finds nothing in a note nobody generated into", () => {
    expect(findAgentSpans("# Just my writing\n\nall mine")).toEqual([]);
  });
});

describe("acceptSpan", () => {
  it("keeps the text and drops the markers", () => {
    const [span] = findAgentSpans(NOTE);
    const out = acceptSpan(NOTE, span);
    expect(out).toContain("The reward model is trained on preference pairs.");
    expect(out).not.toContain("<!-- agent");
    expect(out).not.toContain("<!-- /agent -->");
    // Everything around it survives.
    expect(out).toContain("This contradicts Ouyang et al.");
    expect(out).toContain("# Paper");
  });
});

describe("rejectSpan", () => {
  it("removes the text as well as the markers", () => {
    const [span] = findAgentSpans(NOTE);
    const out = rejectSpan(NOTE, span);
    expect(out).not.toContain("reward model");
    expect(out).not.toContain("<!-- agent");
    expect(out).toContain("This contradicts Ouyang et al.");
  });

  it("does not leave a hole of blank lines", () => {
    const [span] = findAgentSpans(NOTE);
    expect(rejectSpan(NOTE, span)).not.toMatch(/\n{3,}/);
  });
});

describe("acceptAll", () => {
  it("clears every span, with later ones not shifting earlier offsets", () => {
    const two = `${NOTE}\n<!-- agent m2 2026-08-09 -->\nsecond bit\n<!-- /agent -->\n`;
    const out = acceptAll(two);
    expect(findAgentSpans(out)).toEqual([]);
    expect(out).toContain("The reward model is trained on preference pairs.");
    expect(out).toContain("second bit");
  });
});

describe("unverifiedSummary", () => {
  it("counts what is still unverified", () => {
    expect(unverifiedSummary(NOTE)).toEqual({
      spans: 1,
      chars: "The reward model is trained on preference pairs.".length,
    });
  });

  it("is zero for a note with nothing generated", () => {
    expect(unverifiedSummary("mine alone")).toEqual({ spans: 0, chars: 0 });
  });
});
