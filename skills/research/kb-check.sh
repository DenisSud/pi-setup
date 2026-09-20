#!/usr/bin/env python3
"""Query a research knowledge base: gate verdicts, stale fields, open gaps, dead links.

Usage:
    kb-check.sh [vault-root] [--stale-days N]

Vault root defaults to ~/.pi/agent/memory. Reads the frontmatter of every note
under <root>/research/ — no YAML dependency, deliberately parsing only the small
subset the research skill prescribes (scalars, inline maps, inline lists, and the
`open:` block list).

Exit code is 0 always; this is a report, not a gate.
"""
import datetime as dt
import pathlib
import re
import sys

WIKILINK = re.compile(r"\[\[([^\]|#]+)")
STALE_DEFAULT = 90


def parse_frontmatter(text):
    """Return the frontmatter as a dict, or {} if absent."""
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end == -1:
        return {}
    out, key = {}, None
    for raw in text[3:end].splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip())
        line = raw.strip()
        if indent == 0 and ":" in line:
            key, _, val = line.partition(":")
            key, val = key.strip(), val.strip()
            if val == "":
                out[key] = []
            elif val.startswith("{"):
                out[key] = dict(
                    (k.strip(), v.strip())
                    for k, _, v in (p.partition(":") for p in val[1:-1].split(","))
                    if k.strip()
                )
            elif val.startswith("["):
                out[key] = [v.strip() for v in val[1:-1].split(",") if v.strip()]
            else:
                out[key] = val
        elif indent >= 2 and key is not None:
            # `open:` block list — items are `- key: value`, continued `key: value`
            if line.startswith("- "):
                out[key].append({})
                line = line[2:]
            if isinstance(out[key], list) and out[key] and ":" in line:
                k, _, v = line.partition(":")
                out[key][-1][k.strip()] = v.strip()
    return out


def age_days(value, today):
    try:
        return (today - dt.date.fromisoformat(value)).days
    except (ValueError, TypeError):
        return None


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    vault = pathlib.Path(args[0]).expanduser() if args else pathlib.Path.home() / ".pi/agent/memory"
    stale_after = STALE_DEFAULT
    if "--stale-days" in sys.argv:
        stale_after = int(sys.argv[sys.argv.index("--stale-days") + 1])

    root = vault / "research"
    if not root.is_dir():
        sys.exit(f"no research/ directory under {vault}")

    today = dt.date.today()
    notes, frontmatters, titles = {}, {}, {}
    for path in sorted(root.rglob("*.md")):
        fm = parse_frontmatter(path.read_text(encoding="utf-8", errors="replace"))
        fm["_path"] = path
        notes[path] = fm
        titles[path.stem] = path

    entities = [(p, fm) for p, fm in notes.items() if fm.get("type") == "entity"]

    # 1. Gate table
    print("=" * 78)
    print("GATE TABLE")
    print("=" * 78)
    if not entities:
        print("  (no entity notes yet)")
    for path, fm in entities:
        gates = fm.get("gates", {})
        if not isinstance(gates, dict):
            gates = {}
        cells = "  ".join(f"{k.upper()}:{str(v).upper()}" for k, v in sorted(gates.items()))
        print(f"  {fm.get('title', path.stem):<46} {fm.get('status', '?'):<12} {cells}")

    # 2. Stale fields
    print()
    print("=" * 78)
    print(f"STALE (> {stale_after} days since checked)")
    print("=" * 78)
    found_stale = False
    for path, fm in notes.items():
        for key, val in fm.items():
            if not key.endswith("_checked"):
                continue
            age = age_days(val, today)
            if age is not None and age > stale_after:
                field = key[: -len("_checked")]
                print(f"  {path.stem:<32} {field:<28} checked {val} ({age}d)")
                found_stale = True
    if not found_stale:
        print("  (nothing stale)")

    # 3. Open gaps, ranked by what they block
    blocking, nonblocking = [], []
    for path, fm in notes.items():
        items = fm.get("open", [])
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            blocks = str(item.get("blocks", "")).strip().lower()
            rec = (path.stem, item.get("id", "?"), item.get("question", ""), item.get("settle", ""), blocks)
            (nonblocking if blocks in ("", "none", "-") else blocking).append(rec)

    for label, rows in (("BLOCKING A GATE", blocking), ("NOT BLOCKING", nonblocking)):
        print()
        print("=" * 78)
        print(f"OPEN — {label}  ({len(rows)})")
        print("=" * 78)
        if not rows:
            print("  (none)")
        for note, ident, question, settle, blocks in rows:
            tag = f"[{blocks}]" if blocks not in ("", "none", "-") else ""
            print(f"  {tag:<8} {note}/{ident}")
            print(f"           {question}")
            if settle:
                print(f"           settle: {settle}")

    # 4. Dangling wikilinks — concepts worth writing, and dead references
    print()
    print("=" * 78)
    print("DANGLING WIKILINKS")
    print("=" * 78)
    dangling = {}
    for path, fm in notes.items():
        for target in WIKILINK.findall(path.read_text(encoding="utf-8", errors="replace")):
            if target.strip() not in titles:
                dangling.setdefault(target.strip(), set()).add(path.stem)
    if not dangling:
        print("  (all links resolve)")
    for target, sources in sorted(dangling.items()):
        print(f"  [[{target}]]  <- referenced by {', '.join(sorted(sources))}")


if __name__ == "__main__":
    main()
