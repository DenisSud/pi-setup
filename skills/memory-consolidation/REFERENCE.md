# Memory consolidation — reference

## Store API (personal scope `denis`)

- Base `https://memory.sudakov.site`; auth header `X-API-Key: $MEM0_PI_KEY` (secrets profile `mem0`; never echo the key).
- List: `GET /memories?user_id=denis&top_k=10000` → `{"results":[{"id","memory","created_at",…}]}`. Server cap is `ALL_MEMORIES_LIMIT` (10,000; over-limit → 422). The `mem0_memory` tool truncates — use curl or python for full listings.
- Write: `POST /memories` `{"messages":[{"role":"user","content":"<fact>"}],"user_id":"denis","infer":false}` — stores verbatim, no inference.
- Update: `PUT /memories/{id}` `{"text":"<fact>"}`. Delete: `DELETE /memories/{id}`.
- The table also holds other user scopes (bots, test users) — always filter to `denis`.

## Database (ground truth, RPi)

Snapshot count:

```bash
ssh 192.168.1.6 "podman exec mem0-db psql -U mem0 -d postgres -A -t -c \"SELECT count(*) FROM memories WHERE payload->>'user_id' = 'denis'\""
```

Backup / restore:

```bash
ssh 192.168.1.6 "podman exec mem0-db pg_dump -U mem0 -d postgres" | gzip > backup-$(date +%F_%H%M%S).sql.gz

zcat backup-<ts>.sql.gz | ssh 192.168.1.6 "podman exec -i mem0-db psql -U mem0 -d postgres"
```

Schema: table `memories` (`id uuid`, `vector vector(768)`, `payload jsonb`); the fact text is `payload->>'data'`.

## Scripts (this folder)

All read `WORKSPACE` (default `~/mem0-consolidation`).

| script | does |
|---|---|
| `scripts/export_vectors.sh` | `export.csv` (id, data, timestamps, embedding) via psql `\copy` |
| `scripts/build_chunks.py` | NN-chain ordering → `chunks/chunk_NN.md` (~240 items, ≤45 KB) |
| `scripts/validate_parts.py` | part/chunk accounting + assembled duplicate-prefix scan |
| `scripts/write_keepers.py` | idempotent batch write of `assembled.md` keepers + verification → `new_ids.json` |
| `scripts/purge_extras.py` | parallel delete of every id outside `new_ids.json`, swept to zero |

`build_chunks.py` needs numpy on NixOS:

```bash
nix-shell -p 'python3.withPackages (ps: [ ps.numpy ])' --run "python3 scripts/build_chunks.py"
```

Run order: export → build_chunks → (read/keep/fact-check/assemble) → write_keepers → purge_extras, with `validate_parts.py` after the keep pass.

## Pitfalls (learned the hard way)

- **Capture-on strays.** With capture on, new memories keep arriving; the purge is id-set based, so strays die automatically. Flushes are lazy and can carry an old `created_at` (timestamped from their turn) while arriving long after your last sweep — check by id, not by date, and re-run `purge_extras.py` if a late flush lands after the final sweep (e.g. after the report or a later session).
- **Sequential deletes are a trap.** ~1,700 one-by-one deletes take tens of minutes and got aborted mid-run; `purge_extras.py` uses 24 parallel workers plus retries and finishes in about a minute.
- **Read-tool truncation.** Files near 50 KB truncate; read in halves when the footer says so, and never treat a truncated read as a full pass.
- **Verify writes by text equality.** `infer:false` should return the fact verbatim; `write_keepers.py` compares stored text against the keeper list and reports mismatches.
- **Corrections can silently miss.** In the original run a factcheck correction never reached the final keepers — a dropped claim survived into the store and later surfaced in chat recall. Grep a distinctive phrase of every corrected/dropped claim before writing, and if a bad keeper is found after the fact, fix it via `PUT /memories/{id}` and sync `assembled.md` + `new_ids.json`.
- **Idempotence.** Both write and purge are safe to re-run; `new_ids.json` is the checkpoint.
- **Keep the backup until the end.** `gzip -t` the dump; keep the frozen `store.json` + `store_preleft`-style snapshot for the report.
- **Context discipline.** Keep assistant prose minimal during the run; the chunks are the budget.
- **Policy feedback.** A consolidation exposes capture-policy gaps. Record them (e.g. `issues-and-policy.md`); the mem0 extension now dedupes at capture time — the store rebuild is the heavy fallback when drift wins anyway.
