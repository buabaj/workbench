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
  for _ in $(seq 1 40); do
    pgrep -f "Workbench.app/Contents/MacOS/workbench" >/dev/null || break
    sleep 0.25
  done
  # Deliberately no pkill. Since the quit guard exists, a Workbench that has
  # not exited is one holding unsaved changes behind a dialog — killing it
  # would destroy exactly the work the guard was added to protect, and a build
  # is never worth that. Fail loudly instead.
  if pgrep -f "Workbench.app/Contents/MacOS/workbench" >/dev/null; then
    echo "Workbench is still running — it may be asking about unsaved changes." >&2
    echo "Answer it (or save and quit), then run this again." >&2
    exit 1
  fi
fi
exit 0
