#!/usr/bin/env bash
# Test runner for the memory extension.
#
#   ./test/run.sh harness   — frontmatter, indexing, tools, injection (temp
#                             dirs; no network, no model)
set -euo pipefail

EXT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
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
  harness) setup_symlinks; echo "== harness tests =="; node "$EXT_DIR/test/harness.mjs" ;;
  *) echo "usage: $0 [harness]"; exit 1 ;;
esac
