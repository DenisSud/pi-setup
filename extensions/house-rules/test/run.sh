#!/usr/bin/env bash
# Test runner for the house-rules extension.
#
#   ./test/run.sh harness   — hook tests against a stubbed ExtensionAPI (no network)
set -euo pipefail

EXT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS="$EXT_DIR/test/harness.mjs"
# Resolve the installed pi package (works across Nix store versions)
STORE="$(dirname "$(readlink -f "$(command -v pi)")")/../lib/node_modules/pi-monorepo"
[ -d "$STORE" ] || { echo "cannot resolve pi store at $STORE" >&2; exit 1; }

setup_symlinks() {
  mkdir -p "$EXT_DIR/node_modules/@earendil-works"
  if [ -d "$STORE/node_modules/@earendil-works/pi-coding-agent" ]; then
    ln -sfn "$STORE/node_modules/@earendil-works/pi-coding-agent" "$EXT_DIR/node_modules/@earendil-works/pi-coding-agent"
  else
    ln -sfn "$STORE" "$EXT_DIR/node_modules/@earendil-works/pi-coding-agent"
  fi
  ln -sfn "$STORE/node_modules/@earendil-works/pi-tui" "$EXT_DIR/node_modules/@earendil-works/pi-tui"
  ln -sfn "$STORE/node_modules/typebox" "$EXT_DIR/node_modules/typebox"
}

case "${1:-harness}" in
  harness) setup_symlinks; echo "== harness tests =="; node "$HARNESS" ;;
  *) echo "usage: $0 [harness]" ;;
esac
