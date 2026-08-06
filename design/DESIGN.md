# Prime Workbench — Design Foundation (LOCKED 2026-08-06)

Direction: **Dark Research Instrument — Amber.** Paper-like editorial structure rendered in
dark mode. Restrained industrial chrome. Typography does the hierarchy; borders and spacing do
the structure; luminance does the depth. No glass, no gradients, no decoration without
information.

Ground truth: comp `design/comps/amber.html` (Comp A). The other two comps (`signal.html`,
`ice.html`) are kept as rejected alternatives for reference.

## Hard rules

- **Never acid-green / acid-lime.** Vetoed outright by Jerry.
- Red (`--danger`) is reserved exclusively for destructive/error states.
- Source Serif 4 is for research prose only. Everything system — labels, code, metadata,
  chrome — is JetBrains Mono.
- Motion only when it communicates real agent state; always paired with a text label and a
  non-color indicator; `prefers-reduced-motion` fully respected.
- Anti-patterns: AI gradients, oversized hero typography, decorative pill saturation, fake
  terminal styling, unnecessary card nesting, motion without meaning.

## Locked tokens

```css
:root {
  /* surfaces */
  --canvas:         #0F1012;   /* window background, near-black graphite */
  --surface:        #151619;   /* panel background — the center canvas uses this */
  --surface-raised: #1B1D21;   /* active/hover surfaces */

  /* ink — warm paper, never pure white */
  --ink:            #E4DFD3;
  --ink-muted:      #9A968B;
  --ink-faint:      #5C5A54;

  /* structure — cool gray */
  --structure:        #2A2C31;
  --structure-strong: #3D4048;

  /* accent — pale amber */
  --accent:      #D9A441;
  --accent-dim:  #8A6A2E;   /* anchor rules, quiet accent borders */
  --accent-ink:  #141005;   /* text on accent fills */

  /* semantic */
  --link:   #7FB2BE;        /* muted cyan — links, cross-mode references */
  --danger: #C0503C;        /* destructive/error ONLY */

  /* type */
  --serif: "Source Serif 4", Georgia, serif;
  --mono:  "JetBrains Mono", ui-monospace, monospace;

  /* shape */
  --r: 3px;
}
```

Both fonts are OFL — **vendor them into the app** (`@font-face` from packaged assets; the CSP
forbids external fonts). Weights needed: Source Serif 4 — 400, 600, 400-italic (optical size
axis 8..60); JetBrains Mono — 400, 500, 600.

## Type & density (from Comp A)

- Chrome/system base: 12.5px JetBrains Mono. Micro-labels: 10px, weight 500,
  letter-spacing .14em, `--ink-faint`, uppercase.
- Research prose: 16.5px/1.65 Source Serif 4, measure ~660px, headings 600.
  H1 29px, H2 19px. Doc metadata row: 11px mono, hairline bottom border.
- Code blocks in prose: 12px mono on `--canvas`, 1px `--structure` border, radius `--r`.
- Density: editorial/roomy — rail items 4px vertical padding, panels 16px padding,
  sections separated by 20–22px.
- Mixed-case labels in chrome; uppercase reserved for section micro-labels only.

## Component primitives (from Comp A)

- **Active/selected state**: `--surface-raised` fill + `inset 2px 0 0 var(--accent)` left rule.
  Never an accent fill for selection.
- **Panels**: 1px `--structure` border, radius `--r`, `--surface` fill. Emphasized panels
  (live agent) use `--structure-strong`. No shadows, no nesting.
- **Chips**: 1px border, radius `--r`, mono 11px. Origin/provenance chips use dashed border +
  `--ink-faint` (e.g. "workspace default").
- **Anchored claim blocks** (research): 2px `--accent-dim` left rule, anchor tag line in 10px
  mono `--accent` with `⌁` glyph.
- **Wikilinks / cross-refs**: `--link` with dotted underline.
- **Primary action**: `--accent` fill, `--accent-ink` text, weight 600. One per region, max.
- **Typed-link rows**: kind in 10px uppercase `--accent`, target in `--link`, hairline
  separators.

## Dot-matrix state language

7×5 dot grid, 4px dots, 3px gap, circular. Dots are `--structure-strong` at rest, `--accent`
when active. States:

| State | Pattern | Motion |
|---|---|---|
| awaiting-input | four corners lit | none |
| thinking | center column lit | slow column sweep, ~2s |
| running-tools | rows 1/3/5 lit | staggered row pulse, 1.1s (comp A's `rowpulse`) |
| complete | full grid lit | none |
| failed | X shape, `--danger` | none |

Reduced motion: static characteristic pattern per state. The adjacent text label
(`RUNNING TOOLS`, `THINKING`, …, 11px, letter-spacing .1em, `--accent`) is always present —
dots reinforce, never solely carry, the state.

## Layout constants (from Comp A)

Command bar 44px (traffic-light inset ~84px left padding, `titleBarStyle: Overlay`).
Left rail 232px. Right inspector 300px. Composer 88px. Center canvas fluid, doc measure 660px
centered. Region separators: 1px `--structure`, no gaps, no gutters between regions.
