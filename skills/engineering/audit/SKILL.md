---
name: audit
description: "Quality audit of a whole repo: bugs, security holes, what breaks under real load, risky code without tests, slow paths, shallow modules, and what to delete, merge or split. Ranked, each finding in plain English. One-shot report, changes nothing. Use when the user asks to audit a codebase, review the whole repo, find the bloat, asks what can be deleted, or says the architecture is getting in the way."
metadata:
  credits:
    skill: ponytail-audit
    author: Dietrich Gebert
    organisation: DietrichGebert
    url: "https://github.com/DietrichGebert/ponytail/blob/main/skills/ponytail-audit/SKILL.md"
    license: MIT
---

Audit the whole repo like the senior developer who just inherited it and
will be paged when it breaks. Order of importance: correct, safe, holds under
load, tested, fast, lean, well-shaped. Lean still matters: every extra line must
be read, tested and fixed later. This is a report the user asked for, so give it
in full.

## 1. Map first

- Audit what the user names: a folder, a package, or the whole repo.
  Nothing named: the whole repo.
- Read the README, the deploy and build config, the dependency list, the
  entry points (main, routes, handlers, jobs, CLI commands) and the tests.
- Weigh attention by churn, not by file count: walk back a stretch of
  `git log --oneline` and let the paths that keep changing pull your attention
  first. A module nobody touches can wait; one that changes every week pays for
  a finding now.
- Find the expected load: one person running a script, or many users and
  processes at once. Judge scale against that, and say which load you assumed.
- Trace the main flows end to end: where data comes in, what is stored,
  what goes out. Read those paths fully: input from users, money, auth,
  data writes, background jobs, anything shared between processes.
- Read `GLOSSARY.md` and any ADRs in the area you audit: the glossary names the
  modules, and an ADR records a decision this report must not re-litigate.
- Big repo: fan out one read-only subagent per area, none of them changing
  code. Say which parts nobody read.

## 2. Look for

1. **Bug:** wrong result, crash, missed edge case (empty, zero, last item,
   rounding, time zones), callers that disagree with what a function returns,
   the same rule applied differently in two places.
2. **Risk:** security holes (injection, weak randomness, secrets in code,
   missing checks on input from users), data loss (errors swallowed, writes
   in the wrong order, no transaction).
3. **Scale:** fine for one user, wrong for many: check-then-write races, the
   same work done by every process, memory or lists that only grow, a query
   per item, O(n^2) on big input, per-process state that must be shared.
4. **Missing test:** risky logic (a branch, a parser, money, security, data
   writes) with no test that fails when it breaks. One good test, not coverage.
5. **Speed:** big slowdowns are problems. Small wins (work repeated in a hot
   loop) are suggestions; some software counts every millisecond.
6. **Lean:** code that should not exist or should be smaller.
   - delete: dead code, unused options, flags and config, speculative features
   - reuse: two helpers doing the same thing (keep one, name the path)
   - stdlib / native: the standard library or platform already does it;
     a dependency doing what a few lines or the platform can do
   - yagni: interface with one implementation, factory with one product,
     wrapper that only passes calls through
   - merge: near-copies that must change together
   - split: one function or class doing several unrelated jobs, so it is
     hard to read or test. Split by job, never by line count, and never into
     helpers that exist only to make a function shorter.
7. **Shape:** a module whose interface is nearly as complex as its
   implementation, with no locality. Read `../codebase-design/SKILL.md` and use
   its words — module, interface, depth, seam, adapter, leverage, locality — not
   "component" or "service". Where to look, from that skill's friction list:
   - one concept that takes bouncing between many small modules to understand
   - pure functions extracted for testability while the real bugs live in how
     they are called
   - modules that leak across their seam, so a change in one edits the other
   - code with no way to test it through its interface
   Apply the deletion test: if deleting it concentrates complexity, it is
   earning its keep; if complexity just moves, it is a pass-through. A
   deepening pays off where the code churns, so a shallow module nobody touches
   is a nice-to-have, not a finding.

## 3. Check before you report

- Every finding needs a concrete case: "this input or situation leads to this
  wrong result". No case, no finding.
- Before calling code unused, grep the whole tree for it, including tests,
  fixtures, config, and string or dynamic references.
- A shortcut marked with a `shortcut:` (or older `ponytail:`) comment that names
  its limit is a decision, not a finding, unless the expected load already
  crosses it.
- Propose the smallest fix that works. Prefer fixes that delete code. Never
  add layers, frameworks or config the problem does not need.
- A shape finding names the deepening: the interface that shrinks, what moves
  behind the seam, and the locality or leverage it buys. No taste, no "could be
  cleaner". If it contradicts an ADR, say which one and why the friction is
  worth reopening it.
- No style taste, no "consider", no vague worries.

## 4. Output

Very simple English: short sentences, everyday words. Explain a technical
term the first time you use it. The reader may never have seen this code.

Start with `What this repo does:` in two or three sentences, and the load
you assumed.

Then the findings in three groups, most important first, skip empty groups:

- **Must fix:** bug, security, data loss, breaks at the expected load.
- **Should fix:** risky code without a test, real slowness, duplication, a
  function that mixes jobs, code that should not exist, a shallow module that
  the churn says will keep costing.
- **Nice to have:** small speed-ups, shorter forms.

Number findings across all groups, so the user can say "fix 2 and 5". At
most 20 findings; if you left smaller ones out, say how many.
Every finding has all four parts, each one or two short sentences:

2. **Orders land on the wrong day** (`billing/close_day.py:L40-52`)
   - **What this is:** At midnight this job closes the day and bills all orders
     of that day.
   - **Problem:** It takes "today" from the server clock, which runs in UTC. An
     order placed at 00:30 in Berlin is billed on the day before.
   - **Fix:** Compute the day once in the shop's time zone:
     `datetime.now(ZoneInfo("Europe/Berlin")).date()`. One line, nothing else
     changes.
   - **If we skip it:** Late orders show the wrong date, and accounting fixes
     them by hand.

End with:

- `Verdict:` one line: healthy, or what to fix first. When the verdict is a
  shape finding, say it is the one to take into `/grill` next.
- `Lean: -<N> lines, -<M> dependencies possible.` when lean findings exist.
- `Not checked:` the parts you did not read or could not run.

Nothing found: `What this repo does:`, then `Healthy. Nothing to fix.` and
one line on what you checked.

One-shot report, changes no code.
