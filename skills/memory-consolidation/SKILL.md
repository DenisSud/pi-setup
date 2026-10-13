---
name: memory-consolidation
description: Full rebuild of the mem0 memory store — read every memory, rewrite keepers, purge the rest. Run deliberately; heavy and destructive.
disable-model-invocation: true
---

# Memory consolidation

A **consolidation** reads the whole mem0 store, rewrites it into a few hundred **keepers** — standalone durable facts — and purges everything else. It is destructive by design: the new write *is* the store; every old memory dies. Work in `~/mem0-consolidation/` (the scripts default there).

Run it with capture off (`MEM0_AUTO_CAPTURE=false`) and budget most of the context window: ~1,700 memories read as ~7 chunks of ~240. If capture stays on, captured notes become **strays** and the purge sweeps them — nothing breaks, the report just gets noisier.

## Steps

1. **Freeze.** Back up before touching anything: snapshot the store to `store.json`, dump the database to `backup-<ts>.sql.gz`, note the before-count (commands in [REFERENCE.md](REFERENCE.md)).
   *Done when:* the snapshot count matches the database and the backup passes `gzip -t`.

2. **Order & chunk.** Export `export.csv` and run `scripts/build_chunks.py`: it chains items by nearest-neighbour similarity so near-duplicates land adjacent, then cuts chunks of ~240 items ≤45 KB (the read tool caps at 50 KB).
   *Done when:* every store id appears in exactly one chunk file.

3. **Read & keep.** Read every chunk in full, in context — the merge-or-drop judgment needs the full view, so don't delegate the reading. For each chunk write `keepers/part_NN.md`: keeper lines, then a `## dropped` log (`[id] category — reason`). Decide every item: fold it into a keeper, or drop it and log it. Merging beats dropping when in doubt.
   *Done when:* every chunk has a part file and `scripts/validate_parts.py` reports every item accounted for, no dropped id outside its chunk, no cross-part duplicate ids.

4. **Fact-check.** Check every machine-checkable keeper against the live system — paths, repos, hosts, services, configs. Record corrections in `factcheck.md`; apply them at assembly. Keep world claims (scholarships, visas, prices) as recorded notes, marked unverified.
   *Done when:* the corrections list exists and no keeper contradicts the live machine.

5. **Assemble.** Merge the parts into `assembled.md`; merge cross-part overlaps; apply corrections; resolve conflicts toward the newest/most authoritative source (live code > note > memory). One canonical line per fact — delete merged duplicates rather than leaving two versions. Then grep the assembled text for every claim you corrected or dropped in step 4 — none may survive.
   *Done when:* the prefix scan is clean, every line stands alone, and no corrected or dropped claim is still present.

6. **Write.** Smoke-test one keeper (`infer:false`, then GET it back verbatim), then run `scripts/write_keepers.py` to batch-write the rest (~25 per call) and verify. The script is idempotent — safe to re-run after an interruption.
   *Done when:* zero keeper texts are missing from the store.

7. **Purge.** Run `scripts/purge_extras.py`: it deletes every id outside the keeper set with parallel workers and sweeps until extraneous is zero. (Sequential deletes take tens of minutes and invite an abort; this takes about one.)
   *Done when:* store count equals keeper count and two consecutive sweeps stay at zero.

8. **Report.** Write `report.md`: before/after counts, dropped-by-category, merges that changed meaning, backup path, capture caveat. Distil it for chat.
   *Done when:* the report answers what changed, what was lost, where the backup is.

## Keeper style

- One standalone declarative fact per line, normalized to "Denis …" where the subject is Denis; self-contained — no "this", "at that time", "the above".
- Normalize names, paths, hosts, ports, dates; keep amounts with their currency; mark unverified figures.
- ~100–250 chars. A large fact may take two lines; two lines never state one fact.
- Durable material only: identity, preferences, decisions with reasons, stable system knowledge (paths, hosts, repos, constraints, gotchas), goals with horizons, hard rules.
- Merging beats splitting: fold a chunk's variants into the most complete line.

## Drop log

- One line per dropped id: `[8-char-id] category — short reason`; ids come from chunk headers.
- Categories: `superseded`, `stale`, `moot`, `transient`, `progress`, `meta`, `irrelevant`, `duplicate`, `absorbed`.
- `absorbed` = covered by a keeper: log it for the audit trail, count it as kept, not as loss.

## Reference

Store API and database mechanics, the scripts, and the pitfalls that cost time last run: [REFERENCE.md](REFERENCE.md).
