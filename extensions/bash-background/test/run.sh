#!/usr/bin/env bash
# Test runner for the bash-background extension.
#
#   ./test/run.sh harness   — functional tests against real pi internals (no LLM)
#   ./test/run.sh integration — end-to-end run inside pi (needs the configured provider)
#   ./test/run.sh           — both
set -euo pipefail

EXT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Resolve the installed pi package (works across Nix store versions)
STORE="$(dirname "$(readlink -f "$(command -v pi)")")/../lib/node_modules/pi-monorepo"
[ -d "$STORE" ] || { echo "cannot resolve pi store at $STORE" >&2; exit 1; }

setup_symlinks() {
  mkdir -p "$EXT_DIR/node_modules/@earendil-works"
  ln -sfn "$STORE" "$EXT_DIR/node_modules/@earendil-works/pi-coding-agent"
  ln -sfn "$STORE/node_modules/typebox" "$EXT_DIR/node_modules/typebox"
}

run_harness() {
  echo "== harness tests =="
  node "$EXT_DIR/test/harness.mjs"
}

run_integration() {
  local work; work="$(mktemp -d)"
  echo "== integration (real pi, print mode) =="
  echo "workdir: $work"
  cd "$work"
  pi --print "Use the bash tool with run_in_background=true to run the command: echo INTEGRATION_DONE_XYZ && sleep 2
You will receive a follow-up notification when the job finishes. Reply with ONLY the marker INTEGRATION_DONE_XYZ followed by the job's pid from the tool result details (e.g. INTEGRATION_DONE_XYZ 123456)." 2>&1 | tee "$work/out.txt"
  if grep -q "INTEGRATION_DONE_XYZ" "$work/out.txt"; then
    if grep -qE "INTEGRATION_DONE_XYZ[^0-9]*[0-9]{3,}" "$work/out.txt"; then
      echo "integration: PASS (marker + pid)"
    else
      echo "integration: PASS (marker, but no pid found in reply)"
    fi
  else
    echo "integration: FAIL (marker not found in output)"
    return 1
  fi
}

case "${1:-all}" in
  harness) setup_symlinks; run_harness ;;
  integration) setup_symlinks; run_integration ;;
  all) setup_symlinks; run_harness; run_integration ;;
  *) echo "usage: $0 [harness|integration|all]"; exit 1 ;;
esac
