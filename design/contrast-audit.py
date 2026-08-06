#!/usr/bin/env python3
"""Contrast audit for Workbench tokens. Run after ANY palette change:
    python3 design/contrast-audit.py
Text tokens must clear WCAG AA 4.5:1 on canvas, surface AND raised.
--clay is exempt: it is a fill/mark colour; clay TEXT uses --clay-text.
"""
import re, sys, pathlib

css = (pathlib.Path(__file__).parent.parent / "src/styles/tokens.css").read_text()
tok = dict(re.findall(r"--([a-z-]+):\s*(#[0-9a-fA-F]{6})", css))

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

BGS = [tok["canvas"], tok["surface"], tok["raised"]]
TEXT = ["ink", "ink-secondary", "ink-muted", "ink-faint", "clay-text",
        "error", "diff-add", "diff-del",
        "syn-keyword", "syn-string", "syn-number", "syn-function",
        "syn-comment", "syn-type", "syn-punct"]

fails = []
print(f"{'token':16}{'min ratio':>10}  verdict")
for name in TEXT:
    if name not in tok:
        continue
    mn = min(ratio(tok[name], bg) for bg in BGS)
    ok = mn >= 4.5
    if not ok:
        fails.append((name, round(mn, 2)))
    print(f"{name:16}{mn:10.2f}  {'PASS' if ok else 'FAIL'}")

# Text on a clay fill must be ink, never ivory.
on_clay_ink = ratio(tok["ink"], tok["clay"])
on_clay_ivory = ratio(tok["canvas"], tok["clay"])
print(f"\nink on clay fill  {on_clay_ink:6.2f}  {'PASS' if on_clay_ink >= 4.5 else 'FAIL'}")
print(f"ivory on clay     {on_clay_ivory:6.2f}  (expected FAIL — never use ivory on clay)")

if fails:
    print(f"\nFAILURES: {fails}")
    sys.exit(1)
print("\nAll text tokens clear 4.5:1 on every surface.")
