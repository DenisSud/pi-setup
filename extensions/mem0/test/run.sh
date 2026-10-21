#!/usr/bin/env bash
# Test runner for the mem0 extension.
#
#   ./test/run.sh harness   — functional tests (fake mem0/gate HTTP servers,
#                             stubbed pi API, no network, no credentials)
set -euo pipefail

EXT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Resolve the installed pi packages from the running `pi` binary. Two layouts
# exist: `lib/node_modules/pi-monorepo` (older) and `lib/pi/node_modules`, where
# @earendil-works/* are the peer packages this repo imports.
PI_LIB="$(dirname "$(readlink -f "$(command -v pi)")")/../lib"
STORE="$PI_LIB/pi/node_modules"
[ -d "$STORE/@earendil-works/pi-coding-agent" ] || STORE="$PI_LIB/node_modules/pi-monorepo/node_modules"
[ -d "$STORE/@earendil-works/pi-coding-agent" ] || { echo "cannot resolve @earendil-works/pi-coding-agent under $PI_LIB" >&2; exit 1; }

setup_symlinks() {
  # `npm install` puts the peer packages here already; linking into them
  # would nest a link inside the package directory.
  [ -d "$EXT_DIR/node_modules/@earendil-works/pi-coding-agent" ] && return 0
  mkdir -p "$EXT_DIR/node_modules/@earendil-works"
  ln -sfn "$STORE/@earendil-works/pi-coding-agent" "$EXT_DIR/node_modules/@earendil-works/pi-coding-agent"
  ln -sfn "$STORE/@earendil-works/pi-tui" "$EXT_DIR/node_modules/@earendil-works/pi-tui"
  ln -sfn "$STORE/typebox" "$EXT_DIR/node_modules/typebox"
}

run_harness() {
  echo "== harness tests =="
  node "$EXT_DIR/test/harness.mjs"
}

case "${1:-harness}" in
  harness) setup_symlinks; run_harness ;;
  *) echo "usage: $0 [harness]"; exit 1 ;;
esac
