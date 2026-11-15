#!/usr/bin/env bash
# Publish a recording for a pull request.
#
#   publish.sh <raw.webm> <slug>
#
# <slug> names the files on the artifact host, e.g. linkers-pr65-323a32d.
# Writes an h264 mp4 and a gif, copies both to the host, verifies the public
# URL, and prints the markdown block for the PR body.
#
# The host is pi:/srv/artifacts, served by caddy at artifacts.sudakov.site.
# See ../SKILL.md.
set -euo pipefail

raw=${1:?usage: publish.sh <raw.webm> <slug>}
slug=${2:?usage: publish.sh <raw.webm> <slug>}
host=artifacts.sudakov.site
remote=pi:/srv/artifacts
max_gif_bytes=$((6 * 1024 * 1024))

[ -f "$raw" ] || { echo "publish: no such recording: $raw" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "publish: ffmpeg is not on PATH" >&2; exit 1; }

work=$(mktemp -d "${TMPDIR:-/tmp}/demo-publish.XXXXXX")
trap 'rm -rf "$work"' EXIT

mp4="$work/$slug.mp4"
gif="$work/$slug.gif"

# Even dimensions: h264 refuses an odd width or height.
ffmpeg -y -loglevel error -i "$raw" \
    -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" \
    -c:v libx264 -pix_fmt yuv420p -crf 24 -movflags +faststart "$mp4"

gif_at() { # width fps
    ffmpeg -y -loglevel error -i "$raw" -filter_complex \
        "fps=$2,scale=$1:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3" \
        "$gif"
}

gif_at 960 12
if [ "$(stat -c %s "$gif")" -gt "$max_gif_bytes" ]; then
    echo "publish: gif over 6 MB at 960px/12fps, retrying at 800px/10fps" >&2
    gif_at 800 10
fi
if [ "$(stat -c %s "$gif")" -gt "$max_gif_bytes" ]; then
    echo "publish: gif still over 6 MB ($(stat -c %s "$gif") bytes): shorten the flow" >&2
    exit 1
fi

scp -q "$gif" "$mp4" "$remote/"

gif_bytes=$(stat -c %s "$gif")
mp4_bytes=$(stat -c %s "$mp4")
mp4_mb=$(awk -v b="$mp4_bytes" 'BEGIN { printf "%.1f", b / 1048576 }')

for attempt in 1 2 3 4 5 6; do
    code=$(curl -sS -m 20 -o /dev/null -w '%{http_code}' "https://$host/$slug.gif" || true)
    [ "$code" = 200 ] && break
    sleep 3
    [ "$attempt" = 6 ] && { echo "publish: https://$host/$slug.gif answered $code" >&2; exit 1; }
done

content_type=$(curl -sSI -m 20 "https://$host/$slug.gif" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-type"{print $2}')
[ "$content_type" = "image/gif" ] || {
    echo "publish: $host serves image/gif, got '$content_type'" >&2
    exit 1
}

cat <<EOF
![demo](https://$host/$slug.gif)

[full quality mp4](https://$host/$slug.mp4) ($mp4_mb MB)
EOF

echo "publish: gif $((gif_bytes / 1024)) KB, mp4 $((mp4_bytes / 1024)) KB" >&2
