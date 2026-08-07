/**
 * The app's mark, plus the recording meter.
 *
 * Agent *thinking* uses `thinking-orbs` (see AgentOrb). Recording deliberately
 * does NOT: a generic animation can't tell you the microphone is actually
 * hearing you, and a live level meter can. Reserving the orb for thinking also
 * keeps the two states visually distinct.
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

/**
 * Live input level as a dot column histogram — the recording indicator.
 * Reads as part of the same dot language rather than a red blob, and the
 * columns scroll so you can see that audio is genuinely arriving.
 */
export function DotWaveform({
  levels,
  columns = 14,
}: {
  levels: number[];
  columns?: number;
}) {
  const rows = 5;
  const recent = levels.slice(-columns);
  const padded = [...new Array(Math.max(0, columns - recent.length)).fill(0), ...recent];
  // Speech after AGC peaks around 0.05–0.2 of full scale, so a fixed gain left
  // every column showing a single dot. Normalising against the loudest recent
  // sample keeps the shape lively at any input level, with a floor so quiet
  // rooms don't amplify noise into a full bar.
  const peak = Math.max(0.06, ...levels.slice(-60));
  return (
    <div
      className="waveform"
      role="img"
      aria-label="input level"
      style={{ display: "grid", gridTemplateColumns: `repeat(${columns}, 3px)`, gap: 2 }}
    >
      {padded.map((lvl, c) => {
        // Map 0..1 to how many of the 5 dots light, always at least one so the
        // shape stays legible in silence.
        const lit = Math.max(1, Math.round(Math.min(1, lvl / peak) * rows));
        return (
          <div key={c} style={{ display: "grid", gap: 2 }}>
            {new Array(rows).fill(0).map((_, r) => {
              const on = rows - r <= lit;
              return (
                <i
                  key={r}
                  style={{
                    width: 3,
                    height: 3,
                    borderRadius: "50%",
                    background: on ? "var(--clay)" : "var(--border-strong)",
                    transition: "background 90ms linear",
                  }}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
