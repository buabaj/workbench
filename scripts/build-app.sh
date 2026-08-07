#!/usr/bin/env bash
# Build the app bundle with the toolchain this project actually needs.
#
# npm does not inherit an interactively-exported PATH, so it resolved a
# system cargo (1.84.1) that predates edition2024 and cannot build our
# dependency tree — surfacing as a bare "failed to build app". Pinning the
# rustup toolchain here makes the build behave the same however it is invoked.
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
echo "using $(cargo --version)"
npm run tauri build
