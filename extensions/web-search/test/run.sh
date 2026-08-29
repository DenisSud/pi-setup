#!/usr/bin/env bash
# Test runner for the web-search extension.
#
#   ./test/run.sh harness   — functional tests (mocked fetch, no network)
#   ./test/run.sh live      — live test against the real ollama.com API
#                             (requires WEB_SEARCH_KEY; free tier, may rate-limit)
#   ./test/run.sh           — both
set -euo pipefail

EXT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Resolve the installed pi package (works across Nix store versions)
STORE="$(dirname "$(readlink -f "$(command -v pi)")")/../lib/node_modules/pi-monorepo"
[ -d "$STORE" ] || { echo "cannot resolve pi store at $STORE" >&2; exit 1; }

setup_symlinks() {
  mkdir -p "$EXT_DIR/node_modules/@earendil-works"
  # The pi-coding-agent package IS the monorepo root (not a subdir of its
  # own node_modules) in older store layouts; newer layouts ship it under
  # node_modules. Prefer the subdir, fall back to the store root.
  if [ -d "$STORE/node_modules/@earendil-works/pi-coding-agent" ]; then
    ln -sfn "$STORE/node_modules/@earendil-works/pi-coding-agent" "$EXT_DIR/node_modules/@earendil-works/pi-coding-agent"
  else
    ln -sfn "$STORE" "$EXT_DIR/node_modules/@earendil-works/pi-coding-agent"
  fi
  ln -sfn "$STORE/node_modules/@earendil-works/pi-tui" "$EXT_DIR/node_modules/@earendil-works/pi-tui"
  ln -sfn "$STORE/node_modules/typebox" "$EXT_DIR/node_modules/typebox"
}

run_harness() {
  echo "== harness tests =="
  node "$EXT_DIR/test/harness.mjs"
}

run_live() {
  [ -n "${WEB_SEARCH_KEY:-}" ] || { echo "WEB_SEARCH_KEY=<ollama api key> required for the live test" >&2; exit 1; }
  echo "== live web-search test (real ollama.com API) =="
  WEB_SEARCH_LIVE=1 node "$EXT_DIR/test/harness.mjs"
}

case "${1:-all}" in
  harness) setup_symlinks; run_harness ;;
  live) setup_symlinks; run_live ;;
  all) setup_symlinks; run_harness; run_live ;;
  *) echo "usage: $0 [harness|live|all]" ;;
esac
