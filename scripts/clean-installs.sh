#!/usr/bin/env bash
# Leave exactly one Workbench on this machine.
#
# Two things accumulate. Duplicate bundles on disk: Tauri writes to
# target/release/bundle, and a target-specific directory can hold a second,
# older copy. And Launch Services registrations: every DMG that was ever
# mounted stays in its database long after the volume is gone, so macOS can
# resolve "Workbench" to a build from days ago. Both present the same way —
# a change that is definitely in the binary is definitely not in the app.
set -uo pipefail

LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
KEEP="/Applications/Workbench.app"
CANONICAL="src-tauri/target/release/bundle/macos/Workbench.app"

# Any bundle in the project other than the one Tauri is told to build.
while IFS= read -r app; do
  [ "$app" = "$CANONICAL" ] && continue
  echo "removing duplicate bundle: $app"
  rm -rf "$app"
done < <(find src-tauri/target -maxdepth 6 -name "Workbench.app" -type d 2>/dev/null)

# Drop every registration, including the ones pointing at volumes that no
# longer exist. The surviving app re-registers itself when it is next opened,
# and install-app.sh registers it explicitly.
if [ -x "$LSREG" ]; then
  count=0
  while IFS= read -r path; do
    "$LSREG" -u "$path" >/dev/null 2>&1 && count=$((count + 1))
  done < <("$LSREG" -dump 2>/dev/null | grep -oE '/[^ ]*Workbench\.app' | sort -u)
  echo "unregistered $count Workbench paths from Launch Services"
  [ -d "$KEEP" ] && "$LSREG" -f "$KEEP" >/dev/null 2>&1
fi
exit 0
