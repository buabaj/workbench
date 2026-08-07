#!/usr/bin/env bash
# Tauri's bundle_dmg.sh fails outright if a previous run left its scratch
# volume mounted, which happens whenever a build is interrupted. Detaching
# first turns a hard build failure into a no-op.
set -uo pipefail
for v in /Volumes/dmg.*; do
  [ -d "$v" ] || continue
  echo "detaching stale $v"
  hdiutil detach "$v" -force >/dev/null 2>&1 || true
done
exit 0
