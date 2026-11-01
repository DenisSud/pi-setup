---
name: full-send
description: "Carry a spec to shipped: implement, prove, review up to 3 rounds, then open and babysit a PR (github) or commit and push main (local). Never merges. Use when the user says 'full send' or grants autonomy to ship the current spec. Argument: issue number/URL, spec path, or a mode override."
metadata:
  credits:
    skill: full-send
    author: Theo Browne
    organisation: t3dotgg
    url: "https://github.com/t3dotgg/tstack/blob/main/skills/full-send/SKILL.md"
---

# Full send

The user is not watching. Own the work from the spec to the handoff. Their next
message is your report.

A full-send request authorizes the work, the test methods Proof needs, and the
push or PR. It does not authorize a merge, a force-push outside this task's
branch, or anything destructive outside the repo.

## 1. Read the pointer

The argument is the spec:

- An issue number, `owner/repo#123`, or an issue URL → **github** mode.
- A path to an existing file → **local** mode.
- `github` or `local` as the first token → override the mode, then read the
  pointer that follows.
- No argument → the current conversation is the spec. Take the mode from the
  repo's `AGENTS.md` (`ship: local` or `ship: pr`); if there is no marker, use
  `ship: pr` and say so.

Fetch the spec and restate its goal and success criteria in three lines before
touching code. A spec with no observable success criteria is a blocker: ask for
them, question first, and stop.

`ship: local` means commit and push `main`, no branch, no PR. `ship: pr` means a
branch and a PR. `pi-setup` and `nixos-config` are `ship: local`.

## 2. Preflight

```bash
git status --short
git fetch origin
git rev-parse --abbrev-ref HEAD
git rev-parse --short HEAD
```

- The tree must be clean, or contain only changes that belong to this spec. A
  local-mode repo with unrelated changes stops here; do not stash, discard, or
  commit them.
- Find the default branch (`git symbolic-ref refs/remotes/origin/HEAD` or
  `gh repo view --json defaultBranchRef`).
- **github**: create a branch from `origin/<default>` (`git switch -c
  spec/<slug> origin/<default>`), or use the current branch if it is already
  this task's branch and is ahead of the default by only this work.
- **local**: stay on `main`. If it is behind `origin/main`, fast-forward. If it
  has diverged, stop and report.

## 3. Implement

Read the spec and the code it names. Make the smallest change that meets the
success criteria. Follow the repo's existing patterns.

- Read `../tdd/SKILL.md` when the change has a testable seam.
- Read `../diagnosing-bugs/SKILL.md` when the task starts from a failure.
- Read `../workflow-engineering/SKILL.md` only when the work splits into
  independent fan-out. One writer per tree; parallel writers get worktrees.
- Commit in atomic slices as you go. Do not leave the tree dirty at the end.

## 4. Prove

Proof is evidence you observed in this session: command output, a reproduction,
a screenshot. Use the most direct proof the change allows.

- Reproduce the original failure, apply the fix, watch the same reproduction
  pass.
- Run the checks CI runs: typecheck, lint, tests. Run the focused test first,
  then the full suite once.
- For UI or runtime behavior, run the app and look at it. Green mocked tests do
  not prove the experience.
- Record the exact commands and their output for the report.

If you cannot prove the change, stop and ask. Do not ship on confidence.

## 5. Review

Read `../review-loop/SKILL.md` and run it on the diff against the base. It uses
one fresh reviewer, checks standards and spec conformance, and caps at three
rounds. Fix real findings; decline nits with a written reason. Do not push while
the loop runs.

Budget end is not approval. If a finding is still disputed, put both sides in
the report and stop; the user decides.

## 6. Ship

**github**

1. Rebase onto the latest default: `git fetch origin && git rebase
   origin/<default>`. Resolve conflicts; re-run proof after a meaningful
   conflict fix.
2. Push the branch. Use `--force-with-lease` only if you rebased a branch you
   already pushed, never on the default branch.
3. Write the PR body with `../pr/SKILL.md`. Open a real PR with `gh pr create`
   (not a draft). Add one line saying how you proved it.
4. Read `../babysit-pr/SKILL.md` and follow it. Keep the turn open with the
   watcher, fix real findings and CI failures, and get proof for each fix.
5. Stop when the PR is ready. Leave it open and unmerged.

Never merge, enable auto-merge, enter a merge queue, or bypass branch
protection. If auto-merge or a queue is already armed, disable it and report
that. If someone else merges while you watch, report it and stop.

**local**

1. Stage only the spec's files. Commit atomically.
2. Rebase onto `origin/main` if it moved. Re-run proof after a conflict fix.
3. `git push origin main`. No force-push. If the push is rejected, fetch and
   retry once; if it still fails, stop and report.
4. No PR. The pushed `main` is the handoff.

## 7. Report

TLDR first:

- Spec: issue link or file path; mode.
- What changed: `git diff --stat <base>`.
- Proof: the commands and what they showed.
- Review: rounds, verdict, fixed and declined findings.
- Shipped: PR link or pushed commit sha.
- Decisions you made for the user.
- Follow-ups: declined nits and anything out of scope.

## Ask only when blocked

- You cannot prove the change.
- The spec's goal is ambiguous in a way that changes the result.
- The next step is destructive or outside the repo: deleting data, touching
  production, closing someone else's PR, force-pushing another branch.
- A conflict or a failing check cannot be fixed without a decision.

Put the question first, with the context and your recommendation, then stop.
Everything else: decide with a sensible default and list it in the report.
