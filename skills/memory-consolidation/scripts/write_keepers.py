#!/usr/bin/env python3
"""Batch-write the keepers from $WORKSPACE/assembled.md (infer:false), idempotent.

Fetches the store, writes only keeper texts that are missing (batches of 25),
re-fetches to verify, and writes new_ids.json = [{"text","id"}] for the purge.
Exit 1 if any keeper text is still missing.
"""
import json
import os
import time
import urllib.request

WS = os.environ.get("WORKSPACE", os.path.expanduser("~/mem0-consolidation"))
BASE = os.environ.get("MEM0_BASE", "https://memory.sudakov.site")
KEY = os.environ["MEM0_PI_KEY"]
HDRS = {"X-API-Key": KEY, "Content-Type": "application/json"}
BATCH = 25


def api(method, path, body=None, tries=4):
    data = json.dumps(body).encode() if body is not None else None
    last = None
    for t in range(tries):
        try:
            req = urllib.request.Request(BASE + path, data=data, headers=HDRS, method=method)
            with urllib.request.urlopen(req, timeout=120) as r:
                raw = r.read().decode()
                return json.loads(raw) if raw.strip() else {}
        except Exception as e:  # noqa: BLE001 - retry, then surface the last error
            last = e
            time.sleep(2 * (t + 1))
    raise RuntimeError(f"{method} {path}: {last}")


def store():
    """Map memory text -> [ids] for the denis scope."""
    out = {}
    for m in api("GET", "/memories?user_id=denis&top_k=10000").get("results", []):
        out.setdefault(m.get("memory", ""), []).append(m["id"])
    return out


def main():
    texts = []
    for line in open(f"{WS}/assembled.md"):
        if line.startswith("- "):
            t = line[2:].strip()
            if t and t not in texts:
                texts.append(t)
    print(f"keepers: {len(texts)}")

    for round_ in range(1, 5):
        have = store()
        missing = [t for t in texts if t not in have]
        print(f"round {round_}: have={len(texts) - len(missing)} missing={len(missing)}", flush=True)
        if not missing:
            break
        for i in range(0, len(missing), BATCH):
            batch = missing[i:i + BATCH]
            body = {"messages": [{"role": "user", "content": t} for t in batch],
                    "user_id": "denis", "infer": False}
            resp = api("POST", "/memories", body)
            n = len(resp.get("results", []))
            if n != len(batch):
                print(f"  batch {i}: {n} results for {len(batch)}")
            time.sleep(0.3)

    have = store()
    missing = [t for t in texts if t not in have]
    multi = {t: ids for t, ids in have.items() if t in texts and len(ids) > 1}
    mapping = [{"text": t, "id": have[t][0]} for t in texts if t in have]
    json.dump(mapping, open(f"{WS}/new_ids.json", "w"), ensure_ascii=False, indent=1)
    print(f"new_ids.json: {len(mapping)}; missing={len(missing)}; duplicated texts={len(multi)}")
    if multi:
        print("  (duplicates get purged: only one id per text is kept)")
    for t in missing[:10]:
        print("  MISSING:", t[:100])
    if missing:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
