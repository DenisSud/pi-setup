---
name: babysit-pr
description: Watch a pull request through CI and review, fix real findings, and report when it is ready. Use when the user says "babysit", "watch this PR", or after filing a PR under full send.
metadata:
  credits:
    skill: babysit-pr
    author: Theo Browne
    organisation: t3dotgg
    url: "https://github.com/t3dotgg/tstack/blob/main/skills/babysit-pr/SKILL.md"
---

# Babysit PR

Many repos have AI review bots. They're helpful, even if they are not always
right.

## Waiting

Never write your own watcher, polling loop, or `sleep` loop. Use one watcher per
PR: `scripts/pr-wait` from this skill's directory. Use its absolute path.

```bash
pr-wait <pr> [--repo owner/name] [--until ready|green|any-change]
```

It prints one line per real event. It exits 0 when the `--until` condition is
met or the PR merges, 1 when it needs you (a required check failed, conflicts,
unresolved threads, PR closed), and 2 on bad input.

- `ready` (default): required checks green, the repo's gating review bot
  reviewed the head, and no unresolved threads. Use this to babysit.
- `green`: required checks only. Use it when the repo has no gating bot.
- `any-change`: exit on the first event.

Run it as one foreground bash command with a long timeout, so the turn stays
open and each line reaches you. There is no Monitor tool in this setup. Start it
again after you push, after you handle an exit 1, and after a resume. It
remembers what it already reported, so nothing that arrived in between is lost.
If it says another pid already watches the PR, do not start a second one. Kill
the old one only if its events do not reach you.

When an event needs no action, end your turn without a message. Never post or
say "still waiting".

## GitHub rate limits

`gh pr create`, `gh pr view`, and `gh pr checks` use GraphQL. When GraphQL is
used up, the REST limit is separate and usually still has room. Use
`gh api repos/<owner>/<repo>/pulls/<n>` to read a PR, and
`gh api repos/<owner>/<repo>/commits/<sha>/check-runs` for checks.

## Reviews

Only act on checks and comments newer than the latest push. Verify every bot
finding against the source before changing code. Fix real findings and CI
failures, distinguish repository failures from infrastructure flakes, and reply
with a written reason when dismissing false positives.

If the repo has `.macroscope/check-run-agents/*.md`, read those rules before you
reply to a Macroscope finding. Its findings cite them.

CodeRabbit is advisory. Treat its findings like any other finding, but never
wait for it and never hold a merge for it.

If a review bot leaves feedback you believe is not worth addressing, reply with
a written reason and resolve the comment. Keep the reply short: the conclusion,
the code or check that supports it, and what you changed or why you declined.

Screenshots and videos help as well, when you have a way to upload them.

Keep the PR at the size the user's goal needs. Review loops tend to grow a
PR one cheap-looking fix at a time. Fix real bugs in the intended case.
Decline the rest with a written reason, and list them as follow-ups:
unneeded tests, guards for edge cases that do not matter, extra integration
or compatibility, and small performance costs. Prefer the fix that deletes or
narrows code.

## Base branch and merging

Keep an eye on changes to `main` and rebase when needed. `pr-wait` reports when
new base commits touch this PR's files, and when the PR becomes BEHIND or DIRTY.

If an overlapping PR makes this one obsolete, stop monitoring, report it to the
user, and ask before closing the PR unless closure was explicitly authorized.

If nothing has changed, stay quiet rather than posting filler comments. Stop
when `pr-wait` exits 0 and the merge gate passes on the latest head. Merge only
when the user explicitly requested it or `full-send` granted it; otherwise
report that the PR is ready. Right before a merge, run `git fetch` and check the
PR again. Never merge when it is BEHIND or DIRTY, or when base commits that
landed after the last green run touch this PR's files. Rebase, push, and wait
for green again.
