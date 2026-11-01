---
name: review-loop
description: "Independent review of the current diff before shipping: one fresh reviewer, standards and spec conformance, at most 3 rounds, fix real findings. Use when the user says 'review loop', or from full-send before the PR or push."
metadata:
  credits:
    skill: sol-loop
    author: Theo Browne
    organisation: t3dotgg
    url: "https://github.com/t3dotgg/tstack/blob/main/skills/sol-loop/SKILL.md"
---

# Review loop

One reviewer, fresh context, rounds with a budget and a ledger. The reviewer is
the second opinion; the parent owns the fix.

## Budget

- Three rounds total. Round 1 is full. Later rounds check only changed code and
  open findings. Extend only when the user asks; a security or data-loss finding
  does not buy a fourth round on its own.
- Stop early if a round returns only nits. A declined nit, or a comment, doc, or
  format-only fix, needs no new round.
- One reviewer only. It must not start subagents or reviewers.
- Keep a ledger: id, severity, outcome, evidence. Never guess usage.

## 1. Scope

Run `git status --short`. Do not stash, discard, or include unrelated changes.
If unrelated changes cannot be separated cleanly, stop and ask.

Find the base after `git fetch origin`:

- **Spec/PR**: `gh pr view <n> --json baseRefName,headRefOid`, or the spec's
  `Base:` line. Base: `git merge-base HEAD origin/<base>`.
- **Local**: `git merge-base HEAD origin/<default-branch>`. No remote: a base
  the user names, or `HEAD` for uncommitted changes only.

The change is base to working tree, including untracked files. Use one diff
command for every round. State the intent, the spec pointer, and what is out of
scope in two sentences. Run the covering checks first. Do not send code this
change breaks. Note missing or pre-failing checks in the brief.

## 2. Start the reviewer

`subagent` is reachable from codemode, not as a declared tool. Use the
`reviewer` agent: read-only, with `bash` for git history, diffs, issues and the
repo's test commands.

```js
const result = await tools.subagent({
  agent: "reviewer",
  task: "<the round 1 brief>",
  async: false,
});
text(result);
```

Do not pass a model. The reviewer inherits the setup default: DeepSeek V4.1
Flash at high thinking, the same family as the parent. The fresh context and the
brief are the second opinion; the round budget caps the cost. Same-family review
shares the parent's blind spots, so this is not a substitute for a
different-family check on a risky change.

The child gets no history, so the brief carries everything. Do not edit scoped
files while review runs. Wait for the result. Do not poll or start a second
reviewer. A timeout, an error, or no reply is not approval.

### Round 1 brief

```
Review only. Do not edit, commit, push, comment on PRs, or start subagents.
Repo: <abs path>
Base: <sha>
Spec: <issue link or path, or "none">
Intent: <what the change is for>
Out of scope: <scope>
Checks: <commands and results>
Diff: git diff <base> [-- <paths>]; git status --short for untracked files.

Read the surrounding code. Check two axes:
1. Standards: the repo's documented standards (AGENTS.md, CONTRIBUTING.md,
   docs) and its existing patterns. If the repo documents none, use Fowler's
   smell baseline as judgement calls, never hard violations. Skip style that
   tooling enforces.
2. Spec: every success criterion is met, nothing was added that the spec did not
   ask for, and the implementation is not merely shaped like the requirement.

Find bugs, broken callers, and tests that cannot fail. Hold to the smallest
change. Flag code, tests or guards the spec does not need.

blocker = the intended case is wrong.
should = a real bug callers will hit, inside the intent.
nit = everything else.

Reply:
VERDICT: APPROVE or CHANGES
S1 [blocker|should|nit] <file>:<line> <claim>. Fix: <suggestion>
Use stable ids. Say exactly "No issues found." when nothing qualifies.
```

## 3. Answer findings

Check each finding and its severity yourself. Another path, a rare case, or a
small cost is a nit, whatever label it came with.

- **Agree**: make the smallest fix. Prefer delete or narrow over a new lock,
  cache, helper, or option. Fix the case that happened. Add one focused test
  that fails without the fix, if the spec needs it.
- **Disagree**: say why, with evidence (file:line, test output, a contract).
- **Out of scope or nit**: decline in one line. List it as a follow-up.

Update the ledger. Re-run the checks and `git diff --shortstat <base>`. If review
grew the diff, cut first. Do not agree just to end the loop.

## 4. Next round

Start one only if the budget remains and a blocker or should is open, behavior
code changed, or the approval does not cover the current behavior diff.

Launch a fresh reviewer with the round 1 brief, the ledger (`fixed:` /
`disagree:` / `declined:` with evidence), the same base diff, and the change
since the last round. Tell it: open ids and changed code only. Mark each old id
`resolved` or `still open: <reason>`.

## 5. Stop and ship

Agreed: APPROVE on the current behavior diff, no blocker or should open, and no
concern of your own. Stuck: an item stays disputed after two replies, or the
budget ends. Show both sides in two or three lines each; the user decides.
Budget end is not approval.

Do not push during the loop. Push after agreement only if the user asked to
push, ship, or update the PR.

Report: rounds, verdict, diff size before and after, fixed and declined findings
with reasons, and the reviewer model (inherited from the setup default).
