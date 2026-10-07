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
`<bot>/automations/<name>.md`, then ask the user before it runs anywhere.

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

- Never install external packages, skills or extensions — the user decides those.
- Never automate credential handling, irreversible actions, or anything
  outward-facing (mail, other people's calendars, money) without explicit
  approval.
- Never automate work whose benefit is in the doing — the cognitive-benefit
  boundary. Brain dumps, priority calls and learning stay the user's.
- Every automation is idempotent, owned by one bot, and off by default
  (`enabled: false`) until approved.

Done when the spec is committed and the user has approved, or the spec is
disabled and waiting.

## Evolution track (pi platform)

Above automation sits **self-evolution**: changing the agent's own wiring —
new extensions, event hooks, always-on triggers — so the system improves
between sessions, not just within them.

- **Hooks on external events** (calendar reminders, GitHub issues/PRs, opengym
  logs, mail) can trigger agent action automatically once Denis runs an
  always-on pi instance; until then, event hooks fire at the next session.
- **The ladder for evolution:** repeat → skill → automation → **extension/hook**
  (compiled into the platform itself, e.g. the mem0 extension, the calendar
  extension). An extension is the last rung: only when a skill/automation has
  proven stable for a while.
- **Proposal flow:** every candidate goes through a weekly-review proposal
  (max 2): name it, name the hook/trigger, the payoff, and the rung. Denis
  approves before anything is built.
- **Consequential self-modification** (new extension, hook that can act
  outward, prompt-file edits beyond the append file) always get a review
  *before* merge — like the mem0 extension review: built, then Denis reads
  the design before it goes live.
- **The growth boundary is absolute:** agents prepare and organize; thinking,
  deciding, learning, writing stay Denis's. Automation removes drudgery, not
  judgment.
