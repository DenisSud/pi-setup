#!/usr/bin/env bash
# Test runner for the ptc extension.
#
#   ./test/run.sh harness   — functional tests (real child-process execution,
#                             temp fixtures, no network)
set -euo pipefail

EXT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Resolve the installed pi package (works across Nix store versions)
STORE="$(dirname "$(readlink -f "$(command -v pi)")")/../lib/node_modules/pi-monorepo"
[ -d "$STORE" ] || { echo "cannot resolve pi store at $STORE" >&2; exit 1; }

setup_symlinks() {
  mkdir -p "$EXT_DIR/node_modules/@earendil-works"
  ln -sfn "$STORE/node_modules/@earendil-works/pi-coding-agent" "$EXT_DIR/node_modules/@earendil-works/pi-coding-agent"
  ln -sfn "$STORE/node_modules/typebox" "$EXT_DIR/node_modules/typebox"
}

run_harness() {
  echo "== harness tests =="
  node "$EXT_DIR/test/harness.mjs"
}

case "${1:-harness}" in
  harness) setup_symlinks; run_harness ;;
  *) echo "usage: $0 [harness]"; exit 1 ;;
esac
