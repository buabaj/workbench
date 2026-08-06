/**
 * Dot-matrix agent-state indicator. 7×5 grid; the pattern per state is specified in
 * design/DESIGN.md. Dots reinforce state — the adjacent text label always carries it.
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
