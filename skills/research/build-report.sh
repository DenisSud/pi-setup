#!/usr/bin/env bash
# Build a single self-contained HTML report: an essay, then the evidence behind it.
#
# Usage:
#   build-report.sh <essay.md> <out.html> [appendix...]
#
# Each appendix argument is either a markdown file or a directory of markdown
# files. Files are appended as sections; for a directory, each file becomes one
# section anchored at #c-<basename>. The essay is expected to carry a YAML title.
#
# Requires: pandoc. Self-contained output — no external CSS, fonts, or scripts.
set -euo pipefail

ESSAY=${1:?usage: build-report.sh <essay.md> <out.html> [appendix...]}
OUT=${2:?usage: build-report.sh <essay.md> <out.html> [appendix...]}
shift 2
DATE=$(date +%Y-%m-%d)

md2html() { pandoc "$1" -t html5 --wrap=none --metadata title="" 2>/dev/null; }

# Sidebar entries are derived from the essay's own <h2> headings, so editing the
# essay updates the navigation with no second place to maintain.
MAIN_HTML=$(md2html "$ESSAY")
NAV_MAIN=$(printf '%s' "$MAIN_HTML" | perl -ne '
  while (m{<h2 id="([^"]+)">(.*?)</h2>}g) {
    my ($i, $t) = ($1, $2); $t =~ s/<[^>]+>//g;
    print qq{      <a href="#$i">$t</a>\n};
  }')

# Appendix nav: one entry per file, grouped by the directory each came from.
NAV_APPENDIX=$(
  for arg in "$@"; do
    if [ -d "$arg" ]; then
      printf '  <h2>%s</h2>\n' "$(basename "$arg")"
      for f in "$arg"/*.md; do
        c=$(basename "$f" .md)
        printf '      <a href="#c-%s">%s</a>\n' "$c" "$c"
      done
    fi
  done
)

{
cat <<HEAD
<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Research report</title>
<style>
:root{--bg:#fbfbfa;--fg:#1f2328;--muted:#656d76;--line:#d8dee4;--card:#fff;
--pass:#1a7f37;--pass-bg:#dafbe1;--fail:#cf222e;--fail-bg:#ffebe9;
--mid:#9a6700;--mid-bg:#fff8c5;--prune:#8250df;--prune-bg:#fbefff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
.wrap{display:grid;grid-template-columns:270px minmax(0,1fr);max-width:1400px;margin:0 auto}
nav{position:sticky;top:0;align-self:start;height:100vh;overflow-y:auto;
  padding:24px 18px;border-right:1px solid var(--line);background:#fff;font-size:14px}
nav h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:22px 0 8px}
nav a{display:block;padding:4px 8px;border-radius:6px;color:var(--fg);text-decoration:none}
nav a:hover{background:#f0f2f4}
main{padding:32px 40px 120px;min-width:0}
h1{margin:0 0 6px;font-size:31px;letter-spacing:-.02em}
h2{font-size:23px;margin:34px 0 12px;padding-bottom:7px;border-bottom:1px solid var(--line)}
h3{font-size:18px;margin:26px 0 8px}
h4{font-size:15px;margin:18px 0 6px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
table{border-collapse:collapse;width:100%;margin:14px 0;font-size:14.5px;display:block;overflow-x:auto}
th,td{border:1px solid var(--line);padding:8px 11px;text-align:left;vertical-align:top}
th{background:#f6f8fa;font-weight:600}
tr:nth-child(even) td{background:#fcfcfd}
code{background:#f0f2f4;padding:1px 5px;border-radius:5px;font-size:13.5px}
blockquote{margin:14px 0;padding:10px 16px;border-left:4px solid var(--line);
  background:#f6f8fa;border-radius:0 8px 8px 0;color:#3d444d}
blockquote p{margin:6px 0}
a{color:#0969da}
ul,ol{padding-left:22px}li{margin:3px 0}
hr{border:0;border-top:1px solid var(--line);margin:26px 0}
.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12.5px;font-weight:600;white-space:nowrap}
.pass{background:var(--pass-bg);color:var(--pass)}
.fail{background:var(--fail-bg);color:var(--fail)}
.mid{background:var(--mid-bg);color:var(--mid)}
.prune{background:var(--prune-bg);color:var(--prune)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin:18px 0}
.card{border:1px solid var(--line);border-radius:10px;padding:14px 16px;background:#fff}
.card h4{margin:0 0 6px;color:var(--fg);text-transform:none;letter-spacing:0;font-size:16px}
.card p{margin:6px 0;font-size:14.5px;color:#3d444d}
.kv{display:flex;gap:8px;font-size:14px;color:var(--muted);margin:3px 0}
.kv b{color:var(--fg);font-weight:600;min-width:105px}
@media print{nav{display:none}.wrap{display:block}main{padding:0}
  section{border:none;padding:0;margin:0 0 16px;break-inside:avoid}h2{break-after:avoid}}
@media(max-width:900px){.wrap{display:block}nav{position:static;height:auto;
  border-right:0;border-bottom:1px solid var(--line)}main{padding:20px}}
</style></head><body><div class="wrap">
<nav>
  <a href="#top"><b>Report home</b></a>
$(printf '%s' "$NAV_MAIN")
$(printf '%s' "$NAV_APPENDIX")
</nav>
<main id="top">
$MAIN_HTML
HEAD

for arg in "$@"; do
  if [ -d "$arg" ]; then
    printf '<section id="appendix">\n<h2>Appendix — dossiers</h2>\n'
    for f in "$arg"/*.md; do
      c=$(basename "$f" .md)
      printf '<div id="c-%s" style="margin-top:34px">\n' "$c"; md2html "$f"; printf '</div>\n'
    done
    printf '</section>\n'
  else
    printf '<section>\n'; md2html "$arg"; printf '</section>\n'
  fi
done

printf '<p style="color:#656d76;font-size:14px;margin-top:26px">Generated %s · every claim traces to a source in the dossiers · <code>OPEN</code> marks unverified items.</p>\n' "$DATE"
printf '</main></div></body></html>\n'
} > "$OUT"

echo "built $OUT: $(wc -c < "$OUT") bytes"
