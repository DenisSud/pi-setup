#!/usr/bin/env bash
# Test runner for the personal bot's calendar extension.
#
#   ./test/run.sh harness   — ICS + CalDAV tests against a mocked fetch (no network)
#   ./test/run.sh live      — real CalDAV against cal.sudakov.site (read-only)
#   ./test/run.sh           — both
#
# Live write checks (create/update/delete a test event) only run with
# CALENDAR_LIVE_WRITE=1.
set -euo pipefail

EXT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BOT_DIR="$(cd "$EXT_DIR/../.." && pwd)"
HARNESS="$EXT_DIR/test/harness.mjs"
# Resolve the installed pi package (works across Nix store versions)
STORE="$(dirname "$(readlink -f "$(command -v pi)")")/../lib/node_modules/pi-monorepo"
[ -d "$STORE" ] || { echo "cannot resolve pi store at $STORE" >&2; exit 1; }

# The extensions import @earendil-works/* and typebox; pi injects them at run
# time, plain node needs symlinks. One set, shared by both extensions.
setup_symlinks() {
  mkdir -p "$BOT_DIR/node_modules/@earendil-works"
  if [ -d "$STORE/node_modules/@earendil-works/pi-coding-agent" ]; then
    ln -sfn "$STORE/node_modules/@earendil-works/pi-coding-agent" "$BOT_DIR/node_modules/@earendil-works/pi-coding-agent"
  else
    ln -sfn "$STORE" "$BOT_DIR/node_modules/@earendil-works/pi-coding-agent"
  fi
  ln -sfn "$STORE/node_modules/@earendil-works/pi-tui" "$BOT_DIR/node_modules/@earendil-works/pi-tui"
  ln -sfn "$STORE/node_modules/typebox" "$BOT_DIR/node_modules/typebox"
}

case "${1:-all}" in
  harness) setup_symlinks; echo "== harness tests =="; node "$HARNESS" ;;
  live) setup_symlinks; echo "== live test (cal.sudakov.site) =="; CALENDAR_LIVE=1 node "$HARNESS" ;;
  all) setup_symlinks; echo "== harness tests =="; node "$HARNESS"; echo "== live test (cal.sudakov.site) =="; CALENDAR_LIVE=1 node "$HARNESS" ;;
  *) echo "usage: $0 [harness|live|all]" ;;
esac
