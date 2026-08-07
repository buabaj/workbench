#!/usr/bin/env bash
# Quit a running Workbench before rebuilding.
#
# A live app holds its bundle open, which makes Tauri's bundling step fail
# intermittently with a bare "failed to build app". Quitting first is also
# what makes the new binary the one that actually runs: replacing a bundle
# under a live process leaves the old code running.
set -uo pipefail
if pgrep -f "Workbench.app/Contents/MacOS/workbench" >/dev/null; then
  echo "quitting the running Workbench…"
  osascript -e 'quit app "Workbench"' 2>/dev/null || true
  for _ in $(seq 1 20); do
    pgrep -f "Workbench.app/Contents/MacOS/workbench" >/dev/null || break
    sleep 0.25
  done
  pkill -f "Workbench.app/Contents/MacOS/workbench" 2>/dev/null || true
fi
exit 0
