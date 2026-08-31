---
name: memory-review
description: |
  Periodic consolidation review of Denis's memory repository
  (~/.pi/agent/memory). Reviews recently-changed notes for staleness,
  contradictions, and index drift, then writes a human-gated proposal file.
  Produces proposals only — never edits the memory repo directly.
  Use when: running a memory review (weekly cron `memory-review` or on-demand
  "memory review" request).
---

# Memory Review

Review the memory repository and produce a proposal file. **You never edit,
create, or delete anything inside the memory repo itself** — the human applies
proposals.

## Setup

1. Repo: `/home/denis/.pi/agent/memory`. Proposals dir:
   `/home/denis/.pi/agent/memory-reviews/` (outside the repo on purpose, so
   `/memory commit` doesn't sweep it in).
2. Verify the working tree is clean (`git status --porcelain`). If dirty,
   stop and report.
3. `git pull --rebase`. If it fails (network/ssh), stop and report —
   reviewing a stale repo is worse than no review.

## Scope

- All notes under `projects/` (fast-moving state).
- Notes under `knowledge/` and `preferences/` touched in the last 30 days:
  `git log --since="30 days ago" --name-only --pretty=format: | sort -u`
- Skip `archive/`, `index.md` files (checked separately), `SOUL.md`
  (human-authored), `memory.md` (checked for index consistency only).

## Checks (per note)

1. **Contradictions** — does it conflict with another note or with a newer
   note on the same topic? Cross-check notes sharing a project or library.
2. **Stale references** — verify cheaply: do referenced paths/repos/commands
   still exist (`ls`, `test -d`)? Don't build or run anything.
3. **Supersession** — is the note's content fully covered by a newer note?
   If yes → propose SUPERSEDE (old note: add `status: superseded` + link to
   replacement at top, `git mv` to `archive/`).
4. **Index consistency** — does each index one-liner still match the file?
   Does `wc -c` on each `*/index.md` stay under 4000 chars (the context cap)?
   Are there notes missing from their index?

## Output

Write `/home/denis/.pi/agent/memory-reviews/<YYYY>-W<ww>.md` (ISO week) with:

```markdown
# Memory review <YYYY>-W<ww>

Scope: N notes (list or count). Verdict per note: OK / finding.

## UPDATE
- `path/file.md` — what and why, with proposed replacement text inline.

## SUPERSEDE
- `path/old.md` → superseded by `path/new.md` — why.

## ARCHIVE
- `path/file.md` — why it's obsolete (no replacement).

## INDEX FIXES
- Which index lines to change, proposed new text.

## Checked, no action
- one line per healthy note
```

Every finding must cite the evidence (a path that doesn't exist, a
contradicting sentence, an index line). No speculative findings.

## Finish

Print the proposal path plus a summary: counts per category, and the 2–3
findings the human should look at first. The human applies proposals in a
normal pi session (apply, commit `git add`/`git commit`, `git push`), or asks
the agent to apply a specific proposal.
