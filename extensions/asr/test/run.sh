#!/usr/bin/env bash
# Test runner for the asr extension (pi-asr / Parakeet TDT 0.6B v3 wrapper).
#
#   ./test/run.sh harness   — functional tests (fake CLI, no model, no audio)
#   ./test/run.sh live      — real pi-asr on a short cut of a real recording
#   ./test/run.sh           — both
#
# The live variant needs the binary: `nix profile install ~/dev/pi-setup#asr`
# (or `nix build ~/dev/pi-setup#asr` and set ASR_LIVE_FILE / PATH). Without
# ASR_LIVE_FILE it takes a 20 s cut of the newest voice/meeting recording in
# ~/Downloads, so the live run costs a few seconds, not the whole file.
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
  echo "== live test (real pi-asr) =="
  local source_file="${ASR_LIVE_FILE:-}"
  if [ -z "$source_file" ]; then
    source_file="$(find "$HOME/Downloads" -maxdepth 1 -type f \
      \( -name '*.mp3' -o -name '*.m4a' -o -name '*.ogg' -o -name '*.wav' -o -name '*.webm' \) \
      -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)"
  fi
  if [ -z "$source_file" ]; then
    echo "no recording found — set ASR_LIVE_FILE to a short audio file" >&2
    exit 1
  fi
  local cut_file start
  cut_file="$(mktemp -t pi-asr-live-XXXXXX.wav)"
  # Expanded now: the trap outlives this function's locals.
  trap "rm -f '$cut_file'" EXIT
  # A fixed offset lands on silence in some recordings: take a cut from a
  # third of the way in instead, where a meeting or voice note has speech.
  start="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$source_file" \
    | awk '{ printf "%d", ($1 > 90 ? $1 / 3 : 0) }')"
  ffmpeg -nostdin -v error -ss "$start" -t 20 -i "$source_file" -ar 16000 -ac 1 -y "$cut_file"
  echo "   source: $source_file ($start s + 20 s)"
  ASR_LIVE_FILE="$cut_file" ASR_LIVE=1 node "$HARNESS"
}

case "${1:-all}" in
  harness) setup_symlinks; run_harness ;;
  live) setup_symlinks; run_live ;;
  all) setup_symlinks; run_harness; run_live ;;
  *) echo "usage: $0 [harness|live|all]" ;;
esac
