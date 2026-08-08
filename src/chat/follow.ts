/**
 * Whether the transcript should follow the stream.
 *
 * Its own module because the rule is one comparison that is easy to get
 * backwards, and getting it backwards produces the worst possible behaviour:
 * an transcript that scrolls away from you while you are reading it.
 */

/**
 * The margin around "at the bottom".
 *
 * Not zero, and that matters. Sub-pixel heights, a last line still growing as
 * tokens arrive, and a programmatic scroll that lands a hair short would all
 * measure as "the user scrolled away" — which would stop the transcript
 * following for the rest of the turn, for no reason the reader can see.
 */
export const PIN_MARGIN = 80;

export function isAtBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
): boolean {
  return scrollHeight - scrollTop - clientHeight < PIN_MARGIN;
}
