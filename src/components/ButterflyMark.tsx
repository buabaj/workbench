/**
 * The app's mark.
 *
 * Live agent and voice state now use `thinking-orbs` (see AgentOrb); the dot
 * grid stayed only for identity, where a static, deliberate mark beats an
 * animation.
 */
/** The app's mark, small. Same silhouette as the icon: clay wings, ink body. */
export function ButterflyMark({ size = 16 }: { size?: number }) {
  // Left half + centre column, mirrored — matches the icon generator exactly.
  const HALF = [
    "....o...",
    ".....o..",
    "..oooo.x",
    ".ooooo.x",
    "oooooo.x",
    "oooooo.x",
    "..oooo.x",
    ".......x",
    "..oooo.x",
    ".ooooo.x",
    "..oooo.x",
    "...oo..x",
    ".......x",
  ];
  const cols = 15;
  const dots: { x: number; y: number; ink: boolean }[] = [];
  HALF.forEach((line, r) => {
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === ".") continue;
      const mirrored = cols - 1 - i;
      for (const c of new Set([i, mirrored])) {
        dots.push({ x: c, y: r, ink: ch === "x" });
      }
    }
  });
  return (
    <svg
      width={size}
      height={size}
      // Square viewBox around a 15x13 pattern: without it the mark is
      // letterboxed and sits high in its box, pulling tab labels off-centre.
      viewBox={`0 ${-(cols - HALF.length) / 2} ${cols} ${cols}`}
      aria-hidden
      style={{ flexShrink: 0, display: "block" }}
    >
      {dots.map((d, i) => (
        <circle
          key={i}
          cx={d.x + 0.5}
          cy={d.y + 0.5}
          r={0.42}
          fill={d.ink ? "var(--ink)" : "var(--clay)"}
        />
      ))}
    </svg>
  );
}

