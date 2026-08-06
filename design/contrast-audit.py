#!/usr/bin/env python3
"""Contrast audit for Workbench tokens, LIGHT and DARK. Run after any palette
change:  python3 design/contrast-audit.py

Text tokens must clear WCAG AA 4.5:1 on canvas, surface AND raised.
--clay is exempt in light mode: there it is a fill/mark colour and clay TEXT
uses --clay-text. On dark, clay clears on its own.
"""
import re, sys, pathlib

css = (pathlib.Path(__file__).parent.parent / "src/styles/tokens.css").read_text()

def block(selector):
    """Declarations of the first rule whose selector matches exactly."""
    i = css.index(selector)
    seg = css[i + len(selector):]
    seg = seg[: seg.index("\n}")]
    return dict(re.findall(r"--([a-z-]+):\s*(#[0-9a-fA-F]{6})", seg))

LIGHT = block(":root {\n")
DARK = {**LIGHT, **block(':root[data-theme="dark"] {\n')}

def srgb(c):
    c /= 255
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

def lum(h):
    h = h.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b)

def ratio(a, b):
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)

TEXT = ["ink", "ink-secondary", "ink-muted", "ink-faint", "clay-text",
        "error", "diff-add", "diff-del",
        "syn-keyword", "syn-string", "syn-number", "syn-function",
        "syn-comment", "syn-type", "syn-punct"]

fails = []
for name, tok in (("LIGHT", LIGHT), ("DARK", DARK)):
    print(f"\n{name}")
    bgs = [tok["canvas"], tok["surface"], tok["raised"]]
    for t in TEXT:
        if t not in tok:
            continue
        mn = min(ratio(tok[t], bg) for bg in bgs)
        ok = mn >= 4.5
        if not ok:
            fails.append((name, t, round(mn, 2)))
        print(f"  {t:15}{mn:6.2f}  {'PASS' if ok else 'FAIL'}")
    ink_on_clay = ratio(tok["ink"], tok["clay"])
    print(f"  {'ink on clay':15}{ink_on_clay:6.2f}  (fills must use ink, never the light surface)")

if fails:
    print(f"\nFAILURES: {fails}")
    sys.exit(1)
print("\nAll text tokens clear 4.5:1 on every surface, both themes.")
