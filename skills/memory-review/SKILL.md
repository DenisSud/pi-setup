---
name: memory-review
description: |
  Periodic consolidation of Denis's memory repository (~/.pi/agent/memory):
  review recent notes for staleness, contradictions, index drift — then apply
  fixes directly (edit, commit, push). Use when: running a memory review
  (weekly cron `memory-review` or an on-demand "memory review" request).
---

# Memory Review

Review the memory repository, apply safe fixes directly, commit, and push.
**You never touch `SOUL.md`** (human-authored) and never delete notes without
a supersession reason.

## Setup

1. Repo: `/home/denis/.pi/agent/memory`. Report dir:
   `/home/denis/.pi/agent/memory-reviews/` (outside the repo on purpose, so
   `/memory commit` doesn't sweep it in).
2. Verify the working tree is clean (`git status --porcelain`). If dirty,
   stop and report — do not resolve unrelated changes.
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
2. **Stale references** — verify cheaply against reality: do referenced
   paths/repos/commands still exist (`ls`, `test -d`, `grep`)? Don't build
   or run anything.
3. **Supersession** — is the note's content fully covered by a newer note?
   If yes → SUPERSEDE (old note: add `status: superseded` + link to
   replacement at top, `git mv` to `archive/`, update its index).
4. **Index consistency** — does each index one-liner still match the file?
   Does `wc -c` on each `*/index.md` stay under 4000 chars (the context cap)?
   Are there notes missing from their index?

## Applying fixes

For every finding with concrete evidence (a path that doesn't exist, a
contradicting sentence, a wrong one-liner):

1. Edit the note **in place** with the minimal correct replacement. Keep
   edits surgical — never rewrite sections that are still accurate.
2. For SUPERSEDE/ARCHIVE: mark and `git mv` as described, remove/replace
   the index entry.
3. Commit everything as one commit:
   `git commit -am "memory-review: apply <YYYY>-W<ww> consolidation"`, then
   `git push origin main`. If push fails, leave the commit local and say so.

Do NOT apply findings you cannot verify with evidence. When unsure, put the
finding in the report under an "UNRESOLVED" section instead of editing.

## Output

Write `/home/denis/.pi/agent/memory-reviews/<YYYY>-W<ww>.md` (ISO week) with:

```markdown
# Memory review <YYYY>-W<ww>

Scope: N notes (list or count). Verdict per note: OK / fixed / UNRESOLVED.

## Applied
- `path/file.md` — what was changed and the evidence.

## UNRESOLVED
- finding + why it needs a human decision.

## Checked, no action
- one line per healthy note
```

Every entry must cite the evidence (a path that doesn't exist, a
contradicting sentence, an index line). No speculative findings.

## Finish

Print the report path plus a summary: counts per category, the commit hash,
and push status.
