#!/usr/bin/env bash
# Test runner for the web-search extension (SearXNG search only).
#
#   ./test/run.sh harness   — functional tests (mocked fetch, no network)
#   ./test/run.sh live      — live test against the local SearXNG service
#   ./test/run.sh           — both
set -euo pipefail

EXT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS="$EXT_DIR/test/harness.mjs"
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
  node "$HARNESS"
}

run_live() {
  echo "== live test (local SearXNG) =="
  WEB_SEARCH_LIVE=1 node "$HARNESS"
}

case "${1:-all}" in
  harness) setup_symlinks; run_harness ;;
  live) setup_symlinks; run_live ;;
  all) setup_symlinks; run_harness; run_live ;;
  *) echo "usage: $0 [harness|live|all]" ;;
esac
