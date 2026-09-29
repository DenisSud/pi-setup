#!/usr/bin/env bash
# Test runner for the web-search extension (SearXNG + system extractors).
#
#   ./test/run.sh harness   — functional tests (mocked fetch; real trafilatura/
#                             pandoc/pdftotext — wrapped in a nix shell if not
#                             installed system-wide, no network)
#   ./test/run.sh live      — live test against the local SearXNG service and
#                             a real page fetch (needs services.searx running)
#   ./test/run.sh           — both
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

# trafilatura/pdftotext are NixOS system packages; fall back to a nix shell
# so the harness can run before the next nixos-rebuild.
with_extractors() {
  if command -v trafilatura >/dev/null 2>&1 && command -v pdftotext >/dev/null 2>&1; then
    "$@"
  else
    nix shell nixpkgs#python3Packages.trafilatura nixpkgs#poppler-utils -c "$@"
  fi
}

run_harness() {
  echo "== harness tests =="
  with_extractors node "$HARNESS"
}

run_live() {
  echo "== live test (local SearXNG + real fetch) =="
  WEB_SEARCH_LIVE=1 with_extractors node "$HARNESS"
}

case "${1:-all}" in
  harness) setup_symlinks; run_harness ;;
  live) setup_symlinks; run_live ;;
  all) setup_symlinks; run_harness; run_live ;;
  *) echo "usage: $0 [harness|live|all]" ;;
esac
