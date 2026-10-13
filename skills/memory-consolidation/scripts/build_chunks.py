#!/usr/bin/env python3
"""Build topically-ordered reading chunks (nearest-neighbour chain over embeddings).

Input:  $WORKSPACE/store.json (API snapshot), $WORKSPACE/export.csv (vectors)
Output: $WORKSPACE/chunks/chunk_NN.md — ~240 items each, <=45 KB, near-duplicates adjacent.

numpy is required; on NixOS run via:
  nix-shell -p 'python3.withPackages (ps: [ ps.numpy ])' --run "python3 .../build_chunks.py"
"""
import collections
import csv
import json
import os

import numpy as np

WS = os.environ.get("WORKSPACE", os.path.expanduser("~/mem0-consolidation"))
CHUNK = 240      # items per chunk
FLOOR = 0.75     # similarity floor; clusters are not split across chunks

store = json.load(open(f"{WS}/store.json"))["results"]
by_id = {it["id"]: it for it in store}
rows = list(csv.DictReader(open(f"{WS}/export.csv")))
ids = [r["id"] for r in rows]
assert set(ids) == set(by_id), f"export/store mismatch: {len(ids)} vs {len(by_id)}"
print("items:", len(rows))

X = np.vstack([np.fromstring(r["vec"].strip("[]"), sep=",", dtype=np.float32) for r in rows])
Xn = X / np.linalg.norm(X, axis=1, keepdims=True).clip(min=1e-9)

# cluster ids at FLOOR so one cluster stays inside one chunk
S = Xn @ Xn.T
np.fill_diagonal(S, 0.0)
parent = list(range(len(ids)))


def find(x):
    while parent[x] != x:
        parent[x] = parent[parent[x]]
        x = parent[x]
    return x


ii, jj = np.where(np.triu(S, 1) >= FLOOR)
for a, b in zip(ii.tolist(), jj.tolist()):
    ra, rb = find(a), find(b)
    if ra != rb:
        parent[ra] = rb
cid = [find(i) for i in range(len(ids))]

# nearest-neighbour chain
remaining = np.ones(len(ids), dtype=bool)
order, cur = [], 0
for _ in range(len(ids)):
    order.append(cur)
    remaining[cur] = False
    if not remaining.any():
        break
    sims = Xn[cur] @ Xn[remaining].T
    cur = int(np.flatnonzero(remaining)[int(np.argmax(sims))])
print("order built")

last_pos = {}
for pos, idx in enumerate(order):
    last_pos[cid[idx]] = pos

chunks, curc = [], []
for pos, idx in enumerate(order):
    curc.append(idx)
    if len(curc) >= CHUNK and pos == last_pos[cid[idx]] and (len(ids) - 1 - pos) >= 130:
        chunks.append(curc)
        curc = []
if curc:
    chunks.append(curc)

os.makedirs(f"{WS}/chunks", exist_ok=True)
for n, chunk in enumerate(chunks, 1):
    path = f"{WS}/chunks/chunk_{n:02d}.md"
    with open(path, "w") as f:
        for i in chunk:
            it = by_id[ids[i]]
            text = " ".join(it["memory"].split())
            f.write(f"[{it['id'][:8]}] {it['created_at'][:10]}\n{text}\n\n")
    size = os.path.getsize(path)
    warn = "  WARNING: >45KB, split or read in halves" if size > 46000 else ""
    print(f"{path}  {len(chunk)} items  {size} bytes{warn}")

first = collections.Counter(" ".join(it["memory"].split()[:2]) for it in store)
print("top first-two-words:", first.most_common(5))
