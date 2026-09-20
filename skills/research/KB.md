# The knowledge base

A research run that only produces a report is research that gets re-done next time.
The durable output is a **note base** — markdown, Obsidian-compatible, in
`~/.pi/agent/memory`, so it syncs across devices and accumulates instead of
scattering per project.

The project repo keeps the **decision**: the plan, the profile, the next actions.
The note base keeps the **evidence**. The report is a frozen projection of it.

## Layout

```
memory/
  research/
    index.md                  # THIN — one line per research body, nothing else
    <body>/                   # one per decision-domain, e.g. eu-relocation
      README.md               # the MOC: subjects, the concept/entity map, links
      concepts/               # rules shared across entities
      entities/               # one note per concrete option
```

`~/.pi/agent/memory` is already an Obsidian vault (`.obsidian/` is gitignored).
Open it as a vault and the graph, the backlinks pane and the unresolved-links pane
all work with no further setup.

**One body per decision-domain, not per project.** Two subjects researching the same
domain share the concepts between them — that sharing is the point. Splitting per
project re-duplicates the legal baseline, which is the failure this whole method
exists to prevent.

## The index stays thin

`research/index.md` gets **one line per body** — a pointer, a one-sentence scope, and
a "use when" clause. Never enumerate sub-points there. Enumerating is how an index
becomes context bloat that loads on every turn and has to be maintained by hand.

## Note types

| Type | Is | Lives in |
|---|---|---|
| **MOC** (`README.md`) | The map for one body: subjects, the concept/entity tables, where things live | `<body>/` |
| **Concept** | A rule true across entities — a legal baseline, a recognition rule, a funding instrument | `<body>/concepts/` |
| **Entity** | One concrete option: a university, programme, country, vendor, library | `<body>/entities/` |

**Extract a concept note on reuse, never up front.** When a third entity note needs
the same rule, it becomes a note and the others link to it. Before that, the rule
lives where it was first written. Designing a taxonomy in advance produces notes
nobody reads.

## Entity frontmatter — the part that does the work

The numbers a gate reads live **here, once**, and nowhere else. Prose quotes them;
nothing restates them.

```yaml
---
title: JKU Linz — BSc Artificial Intelligence
type: entity
kind: university
country: AT
status: active            # active | blocked | pruned | 2030-target
updated: 2026-09-20

tuition_eur_sem: 726.72
tuition_checked: 2026-09-20
proof_of_funds_eur_yr: 8671
proof_of_funds_checked: 2026-09-20
language: en
deadline_non_eu: 2027-04-30

gates: {g1: pass, g2: conditional, g3: fail, g4: pass}
open:
  - id: jku-exam-count
    question: How many supplementary exams does JKU prescribe for an 11-year attestat?
    blocks: g2
    settle: admission@jku.at
tags: [research/eu-relocation, country/at]
---
```

Every figure carries its own `*_checked` date. Every verdict is a gate name and a
value. Obsidian renders this as Properties, so a human can scan it, and
`kb-check.sh` queries it.

## Gaps — two kinds, and only one is urgent

Both look like "a note that isn't there yet". They are not the same thing:

- **Missing concept** → a dangling `[[link]]`. It records that a note needed this,
  in situ. Nothing is blocked; write it when the third reference appears. Obsidian
  shows these as unresolved links.
- **Missing fact** → an `open:` record with `blocks:` naming the gate it blocks.
  This is a to-do with a consequence attached. The `settle:` field names the URL or
  contact that would close it.

Ranking gaps by `blocks:` is what keeps a growing base from becoming a guilt pile
where every red link looks equally urgent.

## Querying it

```bash
kb-check.sh                      # the memory vault
kb-check.sh /path/to/vault       # elsewhere
kb-check.sh --stale-days 60      # tighter freshness window
```

Prints four things: the **gate table** across all entities, **stale fields** (any
`*_checked` older than the window), **open items split by whether they block a gate**,
and **dangling wikilinks** with what references them.

## When a fact changes

Edit it in one place — the entity frontmatter — and re-run `kb-check.sh`. The
report, if it is regenerated, picks up the new value. This is the whole reason the
numbers live in fields rather than in prose: in the pre-KB state, a single visa
figure was written in ten files and every change meant finding all ten.
