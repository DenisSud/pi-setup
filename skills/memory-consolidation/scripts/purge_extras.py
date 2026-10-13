#!/usr/bin/env python3
"""Delete every memory id outside the keeper set (new_ids.json), in parallel sweeps.

Idempotent; exits 1 if extraneous memories remain after the sweeps.
"""
import concurrent.futures as cf
import json
import os
import time
import urllib.request

WS = os.environ.get("WORKSPACE", os.path.expanduser("~/mem0-consolidation"))
BASE = os.environ.get("MEM0_BASE", "https://memory.sudakov.site")
KEY = os.environ["MEM0_PI_KEY"]
HDRS = {"X-API-Key": KEY, "Content-Type": "application/json"}
WORKERS = int(os.environ.get("PURGE_WORKERS", "24"))
SWEEPS = int(os.environ.get("PURGE_SWEEPS", "8"))


def api(method, path, body=None, tries=3):
    data = json.dumps(body).encode() if body is not None else None
    last = None
    for t in range(tries):
        try:
            req = urllib.request.Request(BASE + path, data=data, headers=HDRS, method=method)
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read().decode()
                return {"ok": True, "body": json.loads(raw) if raw.strip() else {}}
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (t + 1))
    return {"ok": False, "error": str(last)}


def store():
    r = api("GET", "/memories?user_id=denis&top_k=10000")
    return r.get("body", {}).get("results", [])


def main():
    keep = {m["id"] for m in json.load(open(f"{WS}/new_ids.json")) if m.get("id")}
    print(f"keeper ids: {len(keep)}")
    for sweep in range(1, SWEEPS + 1):
        st = store()
        ext = [m["id"] for m in st if m["id"] not in keep]
        print(f"sweep {sweep}: store={len(st)} extraneous={len(ext)}", flush=True)
        if not ext:
            break
        t0 = time.time()
        with cf.ThreadPoolExecutor(max_workers=WORKERS) as ex:
            results = list(ex.map(lambda i: (i, api("DELETE", f"/memories/{i}")), ext))
        errs = [r for _, r in results if not r.get("ok")]
        print(f"  deleted {len(ext) - len(errs)}/{len(ext)} in {time.time() - t0:.1f}s errs={len(errs)}",
              flush=True)
        time.sleep(1)
    st = store()
    ext = [m for m in st if m["id"] not in keep]
    print(f"FINAL store={len(st)} extraneous={len(ext)}")
    json.dump({"count": len(st), "extraneous": len(ext)}, open(f"{WS}/final_check.json", "w"))
    if ext:
        for m in ext[:10]:
            print("  EXTRA:", m["id"], m.get("memory", "")[:80])
        raise SystemExit(1)


if __name__ == "__main__":
    main()
