---
name: self-improvement
description: Turn repeated work up a ladder — task, skill, automation. Use when the same task has been done a second time, when a procedure has stabilized, when asked to "automate this", or during a weekly review.
---

# Self-improvement

Work that repeats is a candidate. Move it up the ladder only as far as it
earns: **task → skill → automation**.

## Notice

The second time you do something, stop and name it: "this is a repeatable
procedure." A procedure is repeatable when the steps would be the same next
time. If they would not be, let it go — one-offs are not candidates.

Done when the procedure has a name and you have said it in one sentence.

## Skill

Write it to your own `skills/<name>/SKILL.md` (guide: base `skill-authoring`),
commit it in your repo, and say in chat what you added and why. The skill is
the default rung: cheap, reversible, and it fires when its description matches.

Done when the skill exists, is committed, and its description names when it
fires.

## Automation

A skill that has run routinely — about three times, or on a natural cadence —
is a candidate for firing without a person. Write the spec to
`<bot>/automations/<name>.md`, then ask Denis before it runs anywhere.

```markdown
---
name: weekly-review
bot: manager
schedule: Sun 18:00        # intent; the app owns real scheduling until then
enabled: false
---

The prompt to run, or the steps the bot takes.
```

Hard limits:

- Never install external packages, skills or extensions — Denis decides those.
- Never automate credential handling, irreversible actions, or anything
  outward-facing (mail, other people's calendars, money) without explicit
  approval.
- Never automate work whose benefit is in the doing — the cognitive-benefit
  boundary in `~/Bots/docs/productivity.md`. Brain dumps, priority calls and
  learning stay Denis's.
- Every automation is idempotent, owned by one bot, and off by default
  (`enabled: false`) until approved.

Done when the spec is committed and Denis has approved, or the spec is
disabled and waiting.
