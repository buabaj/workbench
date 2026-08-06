/**
 * File-type icons with colour that stays inside the palette.
 *
 * Per-language brand colours would read as decorative saturation against warm
 * ivory. Instead each file type maps to one of the palette's named material
 * colours, so the tree gains distinction without importing a second design
 * system. Folders are clay — the one accent — so structure reads first.
 */

type IconColor =
  | "clay"
  | "sky"
  | "olive"
  | "fig"
  | "kraft"
  | "heather"
  | "cactus"
  | "muted";

const COLOR_VAR: Record<IconColor, string> = {
  clay: "var(--clay)",
  sky: "var(--sky)",
  olive: "var(--olive)",
  fig: "var(--fig)",
  kraft: "var(--kraft)",
  heather: "var(--heather)",
  cactus: "var(--cactus)",
  muted: "var(--ink-faint)",
};

/** extension → colour. Grouped by role, not by vendor brand. */
const BY_EXT: Record<string, IconColor> = {
  // systems languages
  rs: "kraft", go: "sky", c: "sky", h: "sky", cpp: "sky", hpp: "sky", swift: "kraft",
  // scripting
  ts: "sky", tsx: "sky", js: "kraft", jsx: "kraft", py: "olive", rb: "fig", sh: "olive",
  zsh: "olive", bash: "olive", lua: "sky", php: "heather",
  // markup + style
  html: "kraft", css: "heather", scss: "heather", svg: "fig",
  // data + config
  json: "olive", toml: "olive", yaml: "olive", yml: "olive", xml: "olive",
  sql: "cactus", env: "olive", lock: "muted",
  // prose
  md: "clay", markdown: "clay", txt: "muted", pdf: "fig",
  // media
  png: "fig", jpg: "fig", jpeg: "fig", gif: "fig", webp: "fig", ico: "fig",
};

const BY_NAME: Record<string, IconColor> = {
  "cargo.toml": "kraft",
  "package.json": "kraft",
  "readme.md": "clay",
  ".gitignore": "muted",
  dockerfile: "sky",
  makefile: "olive",
};

function colorFor(name: string): IconColor {
  const lower = name.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  return BY_EXT[ext] ?? "muted";
}

/** A page glyph with a folded corner — same silhouette for every file, colour
 * carrying the type. Shape stays constant so scanning the tree is about names. */
export function FileIcon({ name }: { name: string }) {
  const fill = COLOR_VAR[colorFor(name)];
  return (
    <svg className="file-icon" viewBox="0 0 16 16" aria-hidden focusable="false">
      <path
        d="M4 1.5h5L13 5.5V14a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 3 14V2a.5.5 0 0 1 .5-.5Z"
        fill={fill}
        fillOpacity="0.18"
      />
      <path
        d="M4 1.5h5L13 5.5V14a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 3 14V2a.5.5 0 0 1 .5-.5Z"
        fill="none"
        stroke={fill}
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <path d="M9 1.5V5a.5.5 0 0 0 .5.5H13" fill="none" stroke={fill} strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  );
}

export function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg className="file-icon" viewBox="0 0 16 16" aria-hidden focusable="false">
      <path
        d={
          open
            ? "M2 4.5A.5.5 0 0 1 2.5 4h3.2l1.3 1.5h6.5a.5.5 0 0 1 .48.63l-1.6 5.5a.5.5 0 0 1-.48.37H2.5a.5.5 0 0 1-.5-.5v-7Z"
            : "M2 3.5a.5.5 0 0 1 .5-.5h3.2l1.3 1.5h6.5a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-8.5Z"
        }
        fill="var(--clay)"
        fillOpacity="0.16"
        stroke="var(--clay)"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  );
}
