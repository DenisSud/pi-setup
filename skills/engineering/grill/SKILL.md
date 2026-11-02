---
name: grill
description: "A relentless interview in rounds until the plan's language, decisions and success criteria are shared. The first step before a spec."
disable-model-invocation: true
---

# Grill

Reach a shared understanding before code or a spec. The output is not a document;
the spec comes next. The output is that both of you can state the goal, the
decisions and the success criteria the same way.

Map the work as a **design tree**: every decision branches into the decisions
that hang off it.

## Recon

Before round one, find out what the repo already knows.

Read the files the ask names, then the ones that govern them: `AGENTS.md`,
`README`, `GLOSSARY.md`, `docs/adr/`, the docs for the area, and `git log
--oneline -20`. Read the tests around the seam: they state the behavior in a
form prose cannot. `rg` the ask's terms when the files are not obvious.

Open round one with a fact sheet, five lines at most:

- What the code does today in the area the ask touches.
- The seam the change lands on: file and line.
- What already exists that it should reuse rather than rebuild.
- The constraint that binds: an ADR, an invariant, a test that would break.
- What the repo cannot answer, and needs a decision.

Post it above the questions. A wrong fact is cheap to correct there and
expensive inside a question. Facts are asserted, never asked.

When the ask spans several areas, one read-only subagent per area is cheaper
than one wide read. When the question is where the seam belongs, read
`../codebase-design/SKILL.md`.

Not every grill has a repo. For a decision or a document, the same pass reads
the material the ask points at and names what is missing; skip what does not
exist.

## Rounds

Work the tree in **rounds**. The **frontier** is every decision whose
prerequisites are already settled: the questions you can ask now without
guessing at answers you have not heard. Ask the whole frontier in one round:
number each question and give your recommended answer. Then wait for the user's
answers before the next round.

```
❓ **Q1** - **<question title>**: <question body, including the choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, including the choices>

➡️ <your recommended answer>
```

Word each question so "yes" accepts your recommendation.

Each round reshapes the tree: settled decisions push the frontier outward and
unblock questions that depended on them. Recompute the frontier and ask the next
round. A question whose answer depends on another question still open belongs to
a later round.

## Facts and decisions

Finding **facts** is your job, never the user's. Recon covers what the ask
already implies; a frontier question can still turn up one the repo did not
volunteer. Look it up yourself or dispatch a subagent, and do not block the
whole round on it: only the questions downstream of that fact wait. Ask the rest
of the frontier now.

The **decisions** are the user's. Put each one to them and wait. Push back when
an answer is vague, contradicts an earlier decision, or assumes a fact that is
not true. Say what you think is wrong and why; do not just accept it.

## Repo vocabulary

When the repo has `GLOSSARY.md` or `docs/adr/`, use their terms and record
settled terms and hard-to-reverse decisions as you go. Read
`../domain-modeling/SKILL.md` when the words themselves are the problem. When
there is no glossary, do not create one unasked.

## Done

The frontier is empty: every branch visited, nothing silently assumed. State in
five lines:

- **Goal**: one sentence.
- **Success criteria**: observable checks, not adjectives.
- **Decisions**: the calls that shape the work.
- **Non-goals**: what this will not do.
- **Open questions**: anything left, or "none".

Ask the user to confirm. Then write the spec with `/spec github` or
`/spec local`. Do not implement before the spec exists.
