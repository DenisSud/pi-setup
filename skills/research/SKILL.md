---
name: research
description: Investigate a question across many sources or candidates and deliver an evidence-gated answer. Use when the user wants a topic researched, options compared against hard constraints, or reading legwork delegated to background agents.
---

# Research

Research here is a **graph**, not a reading list: freeze the inputs, turn the hard
constraints into **gates**, compute shared facts once, fan out one node per
candidate, then let the gates — not prose — decide what survives.

The principle is **deterministic where possible, model where necessary**.
Judgement belongs in the nodes. Routing, thresholds, and pass/fail belong in the
structure, so a candidate cannot pass on "probably fine".

## Steps

### 1. Freeze the inputs and the gates
Before any searching, write down — in a file, not in chat:

- **The decision** — what is actually being chosen, and by whom.
- **The hard constraints** — budget, deadline, eligibility, language, legal
  status. Each one either cites a source or is a stated assumption.
- **The candidate set** — the countries, products, libraries, vendors or papers
  in scope. One line of *why this is in scope* for each.
- **The criteria and their weights** — what the ranking optimises.
- **The gates** — each hard constraint converted, now, into a comparison.

A gate is a **Boolean check over a typed evidence field**, not a judgement:

```
constraint (frozen)                     gate   reads                    fail
tuition ≤ €5k AND capital ≤ €10k        G4     tuition_eur, funds_eur   prune
```

Name the fields while freezing — **the field names are also the frontmatter keys
of the notes the run will write** (see `KB.md`). If a constraint cannot be expressed
as a comparison over a field, it belongs in the ranking, not in a gate; decide that
here rather than at the join. Mark every unknown `?`; names go in the user's
mouth, not yours, because an unstated preference is the most common cause of a
wasted run.

*Done when:* every constraint has a source or an explicit assumption, every
constraint has either a gate or a ranking slot, and every unknown is visibly `?`.

### 2. Choose the shape
Route the run before spending threads on it:

| Shape | When | Do |
|---|---|---|
| **Direct** | One question, one or two sources, or something you half-know | Search it yourself. No fan-out, no dossiers. |
| **Minimal** | One question, no cross-branch fan-out — a handful of candidates, or a single topic | Direct search plus the evidence standard below. Skip Tier 1, the verification lane, and the dossier set. |
| **Full graph** | Several candidates compared against hard constraints | Steps 3–8. |

Fan-out, an independent verifier and a dossier set are real overhead. They earn
it when branches would otherwise **diverge on shared facts**, or when a gate
depends on a claim someone could get wrong. Below that, spend the tokens on
reading instead.

*Done when:* the shape is chosen and you can say in one line why.

### 3. Fan out in two tiers
Split the work into nodes — one node = one question answerable without the
others. Run them in **two tiers**:

- **Tier 1 — cross-cutting.** Facts true for every candidate, or that every
  candidate node would otherwise re-derive: the legal baseline, the recognition
  or compatibility rule, the funding instruments, the access constraints. Run
  these **first, and let them finish**.
- **Tier 2 — per candidate.** One node per candidate against the fixed question
  set, each **citing** Tier 1 rather than re-deriving it.

Strict Tier-1-first is load-bearing, not ceremony: if everything fans out at
once, branches act on divergent premises and the divergence surfaces only at the
join, as rework. Parallelise *within* a tier, serialise *across* them. In the
worst case a flat fan-out returns **different answers for the same fact** in
different branches — which is exactly what the gates then cannot resolve.

Spawn the threads as parallel subagents per the `subagents` skill, with one
deliberate override: **research subagents must NOT use `--no-extensions`** — the
web tools are extension-provided, and stripping extensions blinds them. Give them
`web_search,web_fetch,write` and nothing else, with
`--no-skills --no-context-files --thinking high`.

Read `RESEARCH-PROMPT.md` (same directory) and append it to every thread prompt.
Name each thread's output path inside the note base, so the join is a file read and
the result accumulates instead of being thrown away. See `KB.md`.

*Done when:* every node has a note whose claims follow the evidence standard, and
whose gate-relevant numbers are typed frontmatter fields rather than prose.

### 4. Join and evidence-check
Read every claim back in one form:

```
claim | excerpt | source URL | primary/secondary | date checked | node
```

The **excerpt** is the sentence or field from the source that carries the claim —
not a paraphrase. It is what lets a later reader check that the source *exists*
**and** says what the claim says. A URL, a date and a self-assessed confidence
cannot catch a confident misreading of a correct source; an excerpt can.

A **load-bearing claim** is one a gate, a ranking or a deadline depends on.
Those require a primary source — the authority that owns the fact. Articles,
aggregators, agency blogs and forums are `[secondary]`: they may support a claim,
never carry one.

Anything unverified gets **retried at most twice**, then marked `OPEN` with the
URL that would settle it. `OPEN` is a first-class state, not a gap to be smoothed
over. An `OPEN` load-bearing claim **blocks the gate that reads it** — the
candidate becomes `blocked, pending X` and is reported as such. It is neither
silently passed nor silently pruned.

Reuse facts you already have rather than re-searching them, and check the date
before trusting one. A gate-relevant number is read **from its field**, not from a
sentence — so if the same figure has been written into two notes, one of them is a
bug: collapse it into the concept note both should be citing.
*Done when:* every claim has a URL, a label and an excerpt, and every
unverifiable one is `OPEN` with a settling URL.

### 5. Apply the gates
Evaluate the frozen gate list against the joined fields. Every candidate gets a
verdict — `pass`, `fail`, or `blocked` — with the values and the source that
produced it. No evidence means no pass.

A gate failure is a **research result**, not a failure of the run. Record the
rule and the URL behind it and report it: the reasons a candidate was eliminated
are often more useful than the survivors, because they stop the question being
re-opened next month.
*Done when:* every candidate has a recorded verdict with the evidence behind it.

### 6. Deep-dive the survivors
Only now spend effort on detail, and only on what passed. For each survivor
produce an **ordered tactic**: the sequence of actions with dates, the critical
path, the priced-in risks with their trigger points, the fallbacks *by failure
point*, and an honest probability.

Where a survivor depends on a discretionary decision by a third party, say so,
name the contact, and draft the exact question to ask them. That letter is
usually the cheapest way to move a probability.

A deep dive ends with a **blunt assessment**: is the target date realistic, or is
it the fallback date? State which, and what would change the verdict.
*Done when:* each survivor has a step sequence with a named critical path and
named fallbacks, and a stated probability.

### 7. Verify independently
Staff one more lane with a **different agent** — one that did not write the
claim, working from a **fresh context**, with web tools, and given only the claim
and its URL. It must fetch the source and return confirm, refute, or `OPEN`.

Verify **every claim a gate reads**, not a sample. Gate-critical claims are few —
a handful per candidate — and a wrong one silently corrupts the whole answer.
Claims in the deep-dive prose can be sampled.

An agent re-reading its own work confirms it; independence is the point. This is
also the only real defence against fabricated citations, and it requires
*actually fetching the URL*: a reviewer without web access cannot tell a real
citation from an invented one, so consulting a model over the finished text is
**not** a substitute for this lane. Make the verifier adversarial — ask it to
refute, not to review.
*Done when:* every gate-critical claim is confirmed, corrected, or marked `OPEN`
with the reason.

### 8. Write the report and update state
Lead with an **essay** a human can read straight through — the reasoning, the
constraints, why the losers lost, the tactics — with tables kept where they carry
data. Push the full evidence behind it: one dossier per node as an appendix.
Ship it as a single self-contained HTML file and say where it lives. See
`REPORT.md` for the shape and the build recipe.

Then answer in chat — conclusion, evidence, caveats, `OPEN` items — and write the
result where the project keeps its state: the synthesis file, the plan, the
decision log. Commit if the repo tracks notes.

The human gate is the user's: you produce the ranked, gated, verified answer and
the reasons; **they decide**. Record the decision and its next actions.
*Done when:* state is updated and the user has the answer, the artifacts, and the
open questions.

## Reference

### Scope control
Decide up front what is **out** of scope, and write it down. Prestige rankings,
"general vibe", and anything that does not move the decision are noise — a node
spent on them is a node not spent on a gate. Re-open scope only when a gate
failure forces a replacement candidate.

### Why this shape
Three failures of flat research, and the structure that prevents each:

- **Same fact, different answers per branch** → Tier 1 computes shared facts
  once, before the fan-out.
- **Confident wrong answers** → the excerpt in the evidence standard, plus an
  adversarial verifier that fetches the source rather than re-reading the claim.
- **Missing cross-cutting constraints** — the known blind spot of
  model-generated plans → gates frozen from the constraints up front and
  evaluated mechanically.

### Where the durable output goes
The report is a projection; the **note base** is the artefact that survives. Notes
are markdown with typed frontmatter, Obsidian-compatible, kept in
`~/.pi/agent/memory`, with a deliberately thin index. Concepts are extracted on
reuse, never designed up front, and gaps are recorded as either a dangling link
(nothing blocked) or an `open:` record naming the gate it blocks.

Reference: `KB.md` (the note base) · `RESEARCH-PROMPT.md` (the worker contract) ·
`REPORT.md` (the deliverable recipe) · `build-report.sh` · `kb-check.sh`.
