#!/usr/bin/env bash
# Test runner for the personal bot's gmail extension.
#
#   ./test/run.sh harness   — tool tests against a fake IMAP server (no network)
#   ./test/run.sh live      — real Gmail login + read-only checks
#                             (needs GMAIL_APP_PASSWORD in ~/.pi/agent/env.json)
#   ./test/run.sh           — both
#
# Live write checks (create/update/delete a draft) only run with
# GMAIL_LIVE_WRITE=1.
set -euo pipefail

EXT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BOT_DIR="$(cd "$EXT_DIR/../.." && pwd)"
HARNESS="$EXT_DIR/test/harness.mjs"
# Resolve the installed pi packages from the running `pi` binary. Two layouts
# exist: `lib/node_modules/pi-monorepo` (older) and `lib/pi/node_modules`, where
# @earendil-works/* are the peer packages this repo imports.
PI_LIB="$(dirname "$(readlink -f "$(command -v pi)")")/../lib"
STORE="$PI_LIB/pi/node_modules"
[ -d "$STORE/@earendil-works/pi-coding-agent" ] || STORE="$PI_LIB/node_modules/pi-monorepo/node_modules"
[ -d "$STORE/@earendil-works/pi-coding-agent" ] || { echo "cannot resolve @earendil-works/pi-coding-agent under $PI_LIB" >&2; exit 1; }

# The extensions import @earendil-works/* and typebox; pi injects them at run
# time, plain node needs symlinks. One set, shared by both extensions.
setup_symlinks() {
  # `npm install` puts the peer packages here already; linking into them
  # would nest a link inside the package directory.
  [ -d "$BOT_DIR/node_modules/@earendil-works/pi-coding-agent" ] && return 0
  mkdir -p "$BOT_DIR/node_modules/@earendil-works"
  ln -sfn "$STORE/@earendil-works/pi-coding-agent" "$BOT_DIR/node_modules/@earendil-works/pi-coding-agent"
  ln -sfn "$STORE/@earendil-works/pi-tui" "$BOT_DIR/node_modules/@earendil-works/pi-tui"
  ln -sfn "$STORE/typebox" "$BOT_DIR/node_modules/typebox"
  [ -d "$BOT_DIR/node_modules/imapflow" ] || [ -d "$EXT_DIR/node_modules/imapflow" ] || (cd "$EXT_DIR" && npm install --prefix "$EXT_DIR" --no-audit --no-fund --no-save imapflow html-to-text iconv-lite)
}

case "${1:-all}" in
  harness) setup_symlinks; echo "== harness tests =="; node "$HARNESS" ;;
  live) setup_symlinks; echo "== live test (real Gmail) =="; GMAIL_LIVE=1 node "$HARNESS" ;;
  all) setup_symlinks; echo "== harness tests =="; node "$HARNESS"; echo "== live test (real Gmail) =="; GMAIL_LIVE=1 node "$HARNESS" ;;
  *) echo "usage: $0 [harness|live|all]" ;;
esac
