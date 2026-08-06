/**
 * The dot grid is Workbench's one piece of visual voice — it's the app icon,
 * the chat mark, and the agent-state indicator. Everything drawn here uses the
 * same vocabulary so those read as one family.
 *
 * State is never carried by motion or colour alone: every use pairs with a
 * text label, and each state has a distinct static pattern for reduced motion.
 */
export type MatrixState =
  | "awaiting-input"
  | "thinking"
  | "running-tools"
  | "complete"
  | "failed";

const COLS = 7;
const ROWS = 5;

function activeCells(state: MatrixState): boolean[] {
  const cells = new Array<boolean>(COLS * ROWS).fill(false);
  const set = (r: number, c: number) => {
    cells[r * COLS + c] = true;
  };
  switch (state) {
    case "awaiting-input":
      set(0, 0); set(0, COLS - 1); set(ROWS - 1, 0); set(ROWS - 1, COLS - 1);
      break;
    case "thinking":
      for (let r = 0; r < ROWS; r++) set(r, 3);
      break;
    case "running-tools":
      for (const r of [0, 2, 4]) for (let c = 1; c < COLS - 1; c++) set(r, c);
      break;
    case "complete":
      cells.fill(true);
      break;
    case "failed":
      for (let i = 0; i < Math.min(ROWS, COLS); i++) {
        set(i, i + 1); set(i, COLS - 2 - i);
      }
      break;
  }
  return cells;
}

const ANIMATED: MatrixState[] = ["thinking", "running-tools"];

export function DotMatrix({ state }: { state: MatrixState }) {
  const cells = activeCells(state);
  const classes = [
    "matrix",
    ANIMATED.includes(state) ? "animate" : "",
    state === "failed" ? "failed" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes} role="img" aria-label={`agent state: ${state}`}>
      {cells.map((on, i) => (
        <i key={i} className={on ? "a" : ""} />
      ))}
    </div>
  );
}

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
      viewBox={`0 0 ${cols} ${HALF.length}`}
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
        const lit = Math.max(1, Math.round(Math.min(1, lvl * 2.2) * rows));
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
