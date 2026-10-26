---
name: full-send
description: Use only when the user says "full send", or explicitly grants autonomy to carry the current change to a merged PR without further input. Runs proof, review, PR filing, babysitting, and the merge gate to completion.
metadata:
  credits:
    skill: full-send
    author: Theo Browne
    organisation: t3dotgg
    url: "https://github.com/t3dotgg/tstack/blob/main/skills/full-send/SKILL.md"
---

# Full Send

If the user triggered this, it's because they are not watching this thread, and
they want you to complete the work end-to-end autonomously. Your updates and
your final message go unread until long after you stop. You own the work from
its current state to a merged PR.

If the user did not explicitly request "full send" in some clear way, do not
assume full autonomy. If they did, everything below applies.

This request is the authorization. It overrides the default "branch, push, PR,
do not merge" rule for this task only. It does not override a repository's own
instructions about how to work.

The user grants you permission to:

- Merge the PR once the merge gate passes.
- Force-push the PR's own branch with `--force-with-lease` after a rebase.
- Use the test methods that Proof needs, without asking first.

## Testing permission

A "full send" request is the permission. If a project file or other
instruction says to ask before a test method, or to leave testing to the
user, this request replaces that rule for this task.

That includes ask-first rules for computer use, browser automation,
simulators and devices, running the app or a dev server, screenshots, and
visual checks. Use the method that gives direct proof. List it in the
report.

Rules about how to test still apply. Follow rules that name the correct
command, fixture, or check. This permission only removes the ask-first or
leave-it-to-the-user step. If a preferred method cannot prove the change,
use a gated method under this permission.

It covers only the tests needed for this task. It does not add permission
for the steps under "Asking the user", such as production changes or data
deletion. It also does not bypass a harness or system approval prompt if
one appears.

## Steps

1. **Finish the change.** Complete the goal from the user's request with the
   smallest change that works. Fix the case that happened, not every case
   that could. If you are on the default branch, create a branch first. The
   exception is a repository whose own instructions say to commit to the
   default branch: `pi-setup` and `nixos-config` do.
2. **Prove it.** Get proof for every change you made. See "Proof".
3. **Review it.** Read `../review-loop/SKILL.md` and run it. If the work came
   from a spec or tickets, read `../code-review/SKILL.md` and run it first;
   fix or dismiss its findings before the loop.
4. **File the PR** with the `pr` skill: read `../pr/SKILL.md` and follow it.
   Rebase onto the latest default branch first. Open a real PR with
   `gh pr create` (not a draft) so checks run. Add one short line to the
   description that says how you proved the change.
5. **Babysit the PR**: read `../babysit-pr/SKILL.md` and follow it. Fix real
   findings and CI failures. Get proof for each fix before you push it.
6. **Merge** when the merge gate passes.
7. **Report** in your final message: the PR link, the merge commit, your proof,
   and each decision you made for the user.

Stay active from step 1 to step 7. If you end your turn while checks or bots are
pending, the work stops, because nobody will prompt you again. Run the watcher
from `babysit-pr` in the foreground with a long timeout, so the turn stays open.
If the command returns, handle the event and start it again.

## Proof

Proof is evidence you observed yourself in this session: command output, a
reproduction, a screenshot. Use the most direct proof the change allows:

- Reproduce the original failure, apply the fix, then watch the same
  reproduction pass.
- Run the checks that the repo's CI runs (typecheck, lint, tests).
- Add one focused test that fails without the fix, when the behavior has none
  and the repo has a test setup.
- For UI and runtime behavior, run the app and look at the change. Green mocked
  tests do not prove that the user experience works. Attach screenshots to the
  PR when they help and you have a way to upload them.

When you cannot find a way to prove a change, you do not have full confidence.
Ask the user.

## Merge gate

Full confidence means all of these are true on the latest commit:

- Your proof covers every change in the diff.
- `review-loop` returned APPROVE on the current behavior diff.
- If a spec or tickets exist, `code-review` findings are fixed or dismissed.
- Required checks are green.
- Review bots have finished, and each finding is fixed or dismissed with a
  written reason.
- No human review still requests changes.
- The branch is up to date with the default branch, and GitHub reports it as
  mergeable.

Merge with the method the repo uses. Check the allowed methods and recent merged
PRs. If the repo uses a merge queue or auto-merge, stay until GitHub reports the
PR as merged. Merge through branch protection as configured. Never use `--admin`
or other bypasses. You can ignore automated reviews that request "needs human
review" if you have high confidence in your changes.

## Asking the user

A question in a normal message does not interrupt the user, and the thread looks
done. This setup has no question tool, so the stopped turn is the signal: put
the question first in your final message, then stop. Put all the context in the
question: the PR link, what blocks you, and the options with your
recommendation first.

Ask only when you cannot continue alone:

- You cannot prove the change.
- The merge gate cannot pass, and you cannot fix that yourself.
- The next step is outside the grant above: deleting data, touching production,
  changing things outside the repo, closing a PR, or force-pushing any other
  branch.
- The goal is ambiguous in a way that changes the result.
- Another PR makes this one obsolete.

Decide everything else yourself with sensible defaults, and list those decisions
in the report.

If the user does not answer, take the safe path: leave the PR open and unmerged,
and start your final message with the question.
