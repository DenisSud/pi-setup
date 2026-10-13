#!/usr/bin/env python3
"""Check keeper/drop accounting between chunks/ and keepers/, and scan assembled.md
for duplicate prefixes. Exit 1 with a problem list when anything is off."""
import collections
import glob
import os
import re
import sys

WS = os.environ.get("WORKSPACE", os.path.expanduser("~/mem0-consolidation"))
problems = []


def ids_of(path, pattern):
    return [m.group(1) for m in re.finditer(pattern, open(path).read(), re.M)]


chunk_ids = {}
for cf in sorted(glob.glob(f"{WS}/chunks/chunk_*.md")):
    chunk_ids[os.path.basename(cf)] = ids_of(cf, r"^\[([0-9a-f]{8})\]")
id2chunk = {i: c for c, lst in chunk_ids.items() for i in lst}

dropped_global = collections.Counter()
parts = sorted(glob.glob(f"{WS}/keepers/part_*.md"))
for pf in parts:
    pn = os.path.basename(pf).split("_")[-1].split(".")[0]
    want = f"chunk_{pn}.md"
    section = open(pf).read().split("## dropped", 1)[1] if "## dropped" in open(pf).read() else ""
    drops = re.findall(r"^- \[([0-9a-f]{8})\]", section, re.M)
    for d in drops:
        dropped_global[d] += 1
        if id2chunk.get(d) != want:
            problems.append(f"{pf}: dropped {d} belongs to {id2chunk.get(d, '???')}")
    total = len(chunk_ids.get(want, []))
    print(f"part {os.path.basename(pf)}: chunk={total} dropped={len(drops)} kept={total - len(drops)}")

dupes = [i for i, n in dropped_global.items() if n > 1]
if dupes:
    problems.append(f"duplicate dropped ids across parts: {dupes[:10]}")

total_items = sum(len(v) for v in chunk_ids.values())
print(f"chunks: {len(chunk_ids)} files, {total_items} items; "
      f"dropped logged: {len(dropped_global)}; kept: {total_items - len(dropped_global)}")

asm = f"{WS}/assembled.md"
if os.path.exists(asm):
    lines = [l[2:].strip() for l in open(asm) if l.startswith("- ")]
    print(f"assembled: {len(lines)} lines")
    pref = collections.defaultdict(list)
    for l in lines:
        if not l:
            problems.append("assembled: empty keeper line")
            continue
        pref[l[:70].lower()].append(l)
    for k, v in list({k: v for k, v in pref.items() if len(v) > 1}.items())[:10]:
        problems.append(f"assembled duplicate prefix: {v[0][:70]}")

if problems:
    print("\nPROBLEMS:")
    for p in problems:
        print(" -", p)
    sys.exit(1)
print("OK")
