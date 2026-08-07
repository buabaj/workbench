#!/usr/bin/env bash
# Put the freshly built app where it is actually launched from.
#
# The bundle lands under src-tauri/target, but the app in use lives in
# /Applications. Dragging it across by hand is easy to forget, and the failure
# mode is the worst kind: everything builds, tests pass, and the running app
# simply does not have the change. Worse, replacing a bundle while it is
# running leaves the OLD process live, so even a fresh copy appears broken
# until it is relaunched — hence the quit first.
set -euo pipefail

SRC="src-tauri/target/release/bundle/macos/Workbench.app"
DEST="/Applications/Workbench.app"

[ -d "$SRC" ] || { echo "no build at $SRC — run 'npm run tauri build' first" >&2; exit 1; }

if pgrep -f "Workbench.app/Contents/MacOS/workbench" >/dev/null; then
  echo "quitting the running Workbench…"
  osascript -e 'quit app "Workbench"' 2>/dev/null || true
  for _ in $(seq 1 20); do
    pgrep -f "Workbench.app/Contents/MacOS/workbench" >/dev/null || break
    sleep 0.25
  done
  pkill -f "Workbench.app/Contents/MacOS/workbench" 2>/dev/null || true
fi

rm -rf "$DEST"
cp -R "$SRC" "$DEST"
echo "installed $(shasum -a 256 "$DEST/Contents/MacOS/workbench" | cut -c1-12) -> $DEST"
