import { File, FileCode, FileCog, FileImage, FileText, Folder, FolderOpen } from "lucide-react";

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

/**
 * Lucide glyphs, tinted from the palette map above. Lucide ships
 * `stroke="currentColor"`, so colour comes from the wrapper and never leaves
 * the design system — brand-coloured language logos would read as decorative
 * saturation against the warm surfaces.
 */
export function FileIcon({ name }: { name: string }) {
  const color = COLOR_VAR[colorFor(name)];
  const lower = name.toLowerCase();
  const Glyph = lower.endsWith(".md") || lower.endsWith(".markdown")
    ? FileText
    : /\.(png|jpe?g|gif|webp|svg|ico)$/.test(lower)
      ? FileImage
      : /\.(json|toml|ya?ml|xml|lock|env)$/.test(lower) || lower === ".gitignore"
        ? FileCog
        : /\.(rs|ts|tsx|js|jsx|py|rb|go|swift|c|h|cpp|hpp|sh|zsh|bash|lua|php|sql|css|html)$/.test(lower)
          ? FileCode
          : File;
  return (
    <span className="file-icon" style={{ color }}>
      <Glyph size={14} strokeWidth={1.6} aria-hidden />
    </span>
  );
}

export function FolderIcon({ open }: { open: boolean }) {
  const Glyph = open ? FolderOpen : Folder;
  return (
    <span className="file-icon" style={{ color: "var(--clay)" }}>
      <Glyph size={14} strokeWidth={1.6} aria-hidden />
    </span>
  );
}
