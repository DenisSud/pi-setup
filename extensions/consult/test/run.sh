#!/usr/bin/env bash
# Test runner for the consult extension.
#
#   ./test/run.sh harness   — functional tests (fake streams, no network)
#   ./test/run.sh live      — live test against the real kimi-k3 endpoint
#                             (requires CONSULT_KEY; costs real money, ~$0.01)
#   ./test/run.sh           — both
set -euo pipefail

EXT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Resolve the installed pi package (works across Nix store versions)
STORE="$(dirname "$(readlink -f "$(command -v pi)")")/../lib/node_modules/pi-monorepo"
[ -d "$STORE" ] || { echo "cannot resolve pi store at $STORE" >&2; exit 1; }

setup_symlinks() {
  mkdir -p "$EXT_DIR/node_modules/@earendil-works"
  ln -sfn "$STORE/node_modules/@earendil-works/pi-ai" "$EXT_DIR/node_modules/@earendil-works/pi-ai"
  ln -sfn "$STORE/node_modules/typebox" "$EXT_DIR/node_modules/typebox"
}

run_harness() {
  echo "== harness tests =="
  node "$EXT_DIR/test/harness.mjs"
}

run_live() {
  [ -n "${CONSULT_KEY:-}" ] || { echo "CONSULT_KEY=sk-... required for the live test" >&2; exit 1; }
  echo "== live consult test (real kimi-k3, ~\$0.01) =="
  CONSULT_LIVE=1 node "$EXT_DIR/test/harness.mjs"
}

case "${1:-all}" in
  harness) setup_symlinks; run_harness ;;
  live) setup_symlinks; run_live ;;
  all) setup_symlinks; run_harness; run_live ;;
  *) echo "usage: $0 [harness|live|all]"; exit 1 ;;
esac
