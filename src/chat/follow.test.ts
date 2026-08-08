import { describe, expect, it } from "vitest";
import { isAtBottom, PIN_MARGIN } from "./follow";

/**
 * The autoscroll fight: following the stream unconditionally means scrolling
 * up to re-read something turns into a tug of war, every token pulling you
 * back down. These pin the rule that decides who wins.
 */
describe("deciding whether to follow the stream", () => {
  it("follows when the view is at the bottom", () => {
    expect(isAtBottom(1000, 800, 200)).toBe(true);
  });

  it("does not follow when the reader has scrolled up", () => {
    // 600px of content below the fold: they are reading, not watching.
    expect(isAtBottom(1600, 800, 200)).toBe(false);
  });

  it("treats a near-miss as the bottom", () => {
    // A last line growing mid-token leaves a few pixels. Calling that
    // "scrolled away" would stop following for the rest of the turn.
    expect(isAtBottom(1000, 780, 200)).toBe(true);
    expect(isAtBottom(1000, 1000 - 200 - (PIN_MARGIN - 1), 200)).toBe(true);
  });

  it("stops following just past the margin", () => {
    expect(isAtBottom(1000, 1000 - 200 - PIN_MARGIN, 200)).toBe(false);
  });

  it("counts a transcript shorter than the window as the bottom", () => {
    // Nothing to scroll: the reader cannot be adrift.
    expect(isAtBottom(300, 0, 800)).toBe(true);
  });

  it("survives an overscrolled position without inverting", () => {
    // Rubber-band scrolling on macOS reports scrollTop past the end.
    expect(isAtBottom(1000, 900, 200)).toBe(true);
  });
});
