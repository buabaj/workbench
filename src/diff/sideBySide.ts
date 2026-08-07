/**
 * Turning a unified patch into two aligned columns.
 *
 * A unified diff is a stream of removals then additions; side by side needs
 * them paired, so a changed line sits opposite the line it replaced rather
 * than below it. That pairing is the whole job, and it is where a naive
 * implementation goes wrong: removals and additions arrive in runs, and the
 * runs are rarely the same length.
 */

export type RowKind = "context" | "change" | "add" | "remove" | "hunk" | "meta";

export interface Side {
  /** 1-indexed line number in that version of the file, when it has one. */
  num: number | null;
  text: string;
}

export interface Row {
  kind: RowKind;
  left: Side | null;
  right: Side | null;
}

/** Header lines a reader does not need: the file name is already on screen. */
function isNoise(line: string): boolean {
  return (
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("similarity index") ||
    line.startsWith("rename from") ||
    line.startsWith("rename to") ||
    line.startsWith("old mode") ||
    line.startsWith("new mode")
  );
}

/** `@@ -a,b +c,d @@` — the line numbers each side resumes at. */
function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const m = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
  if (!m) return null;
  return { oldStart: Number(m[1]), newStart: Number(m[2]) };
}

export function toSideBySide(patch: string): Row[] {
  const rows: Row[] = [];
  let oldNo = 0;
  let newNo = 0;

  // Runs are held until the run ends, because pairing needs both lengths.
  let removed: Side[] = [];
  let added: Side[] = [];

  const flush = () => {
    if (removed.length === 0 && added.length === 0) return;
    const n = Math.max(removed.length, added.length);
    for (let i = 0; i < n; i++) {
      const l = removed[i] ?? null;
      const r = added[i] ?? null;
      rows.push({
        // A row with both sides is a replacement; one side alone is a pure
        // insertion or deletion, and reads differently.
        kind: l && r ? "change" : l ? "remove" : "add",
        left: l,
        right: r,
      });
    }
    removed = [];
    added = [];
  };

  for (const line of patch.split("\n")) {
    if (isNoise(line)) continue;

    const hunk = parseHunkHeader(line);
    if (hunk) {
      flush();
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      rows.push({ kind: "hunk", left: { num: null, text: line }, right: null });
      continue;
    }

    const marker = line[0];
    const text = line.slice(1);

    if (marker === "+") {
      added.push({ num: newNo++, text });
    } else if (marker === "-") {
      removed.push({ num: oldNo++, text });
    } else if (marker === " ") {
      flush();
      rows.push({
        kind: "context",
        left: { num: oldNo++, text },
        right: { num: newNo++, text },
      });
    } else if (line === "\\ No newline at end of file") {
      rows.push({ kind: "meta", left: { num: null, text: line }, right: null });
    }
    // Anything else is a blank trailing line or unknown furniture; a diff
    // viewer that renders those is showing the transport, not the change.
  }
  flush();
  return rows;
}

/** Added and removed line counts, for a header. */
export function countChanges(rows: Row[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.kind === "add" || r.kind === "change") if (r.right) added++;
    if (r.kind === "remove" || r.kind === "change") if (r.left) removed++;
  }
  return { added, removed };
}
