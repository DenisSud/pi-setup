#!/usr/bin/env bash
# Render a harness page to an H.264 file.
#
#   ./capture.sh <page.html> <query> <out-dir> [timeout-seconds]
#   ./capture.sh ~/lab/ocean.html "w=2560&h=1440&sec=20&fps=30" ~/lab/ocean
#
# SITE_ROOT (default: $PWD) is the directory served over HTTP, so an absolute
# import like /static/js/ocean/index.js resolves against it. The page is copied
# in under a dot-name for the run and removed afterwards.
#
# The page must POST PNG frames to /frame?i=N and /done when finished; the
# harnesses here do. Encode settings: FPS (default 30), CRF (default 20).
set -euo pipefail

PAGE="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
QUERY="$2"
OUT="$3"
TMO="${4:-600}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SITE_ROOT="${SITE_ROOT:-$PWD}"
PORT="${PORT:-9411}"
FPS="${FPS:-$(printf '%s' "$QUERY" | tr '&' '\n' | sed -n 's/^fps=//p')}"
FPS="${FPS:-30}"

NAME=".capture-$(basename "$PAGE")"
rm -rf "$OUT" && mkdir -p "$OUT"
rm -f "$SITE_ROOT/done.flag"
cp "$PAGE" "$SITE_ROOT/$NAME"
WORK="$(mktemp -d)"

cleanup() {
  kill "$CPID" 2>/dev/null || true
  kill "$SPID" 2>/dev/null || true
  pkill -f "user-data-dir=$WORK/profile" 2>/dev/null || true
  rm -rf "$WORK" "$SITE_ROOT/$NAME"
}
trap cleanup EXIT

OUT="$OUT" node "$HERE/serve.mjs" "$PORT" "$SITE_ROOT" > "$WORK/server.log" 2>&1 &
SPID=$!
sleep 0.7

# setsid: the chromium wrapper forks, so the whole process group must go.
setsid chromium --headless=new --no-sandbox --disable-dev-shm-usage \
  --user-data-dir="$WORK/profile" --window-size="${WINDOW:-2560,1440}" --hide-scrollbars \
  --force-device-scale-factor=1 --disable-background-timer-throttling \
  --disable-renderer-backgrounding --disable-backgrounding-occluded-windows \
  --disable-features=CalculateNativeWinOcclusion \
  "http://localhost:${PORT}/${NAME}?${QUERY}" > "$WORK/chrome.log" 2>&1 &
CPID=$!

for _ in $(seq 1 "$TMO"); do
  [ -f "$SITE_ROOT/done.flag" ] && break
  sleep 1
done

cat "$WORK/server.log"
N=$(find "$OUT" -name '*.png' | wc -l)
echo "frames: $N"
if [ "$N" -eq 0 ]; then
  echo "no frames — browser log:"
  tail -20 "$WORK/chrome.log"
  exit 1
fi

ffmpeg -y -loglevel error -framerate "$FPS" -i "$OUT/%05d.png" \
  -c:v libx264 -preset slow -crf "${CRF:-20}" -pix_fmt yuv420p -tune animation \
  "$OUT.mp4"
ls -lh "$OUT.mp4"
