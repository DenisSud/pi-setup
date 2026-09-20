# The report

Research that only lives in chat is research that gets re-done. The deliverable is
one **self-contained HTML file** the user can open and read straight through.

Two layers, in this order:

1. **The essay** — the reasoning. A human reads this and understands the answer
   without opening anything else.
2. **The appendix** — the evidence. One dossier per node, each claim carrying its
   source, its label, and the date it was checked.

## The essay

Write it as prose, in this shape:

| Section | What it does |
|---|---|
| **The question behind the question** | The real decision under the stated ask. Says what is actually being optimised, and why the obvious framing is wrong. |
| **The constraints** | The handful of facts that do most of the work. Name them and give the numbers. |
| **The first sweep** | What the gates eliminated and *why*. The reasons are often more useful than the survivors. |
| **The survivors** | Side-by-side, in a table, with the one-line case for each. |
| **Deep dives** | One section per survivor: why it looked right, the real obstacle, the ordered tactic, the honest probability. |
| **Where the paths converge** | The cross-cutting insight — the single action that decides several branches at once. Usually the most valuable section in the report. |
| **What would change the answer** | The `OPEN` items, as a to-do list. |
| **The decision that belongs to the user** | What research cannot settle. Say so plainly instead of implying a recommendation. |

Rules that make it readable:

- **Prose carries the argument; tables carry data.** A table of numbers is good. A
  table of sentences means the prose is missing.
- **Every number traces to a dossier.** The essay cites no URLs — the appendix does.
  Keep that division clean; inline links in the essay are clutter.
- **Quantify the uncertainty.** "20–30%" beats "challenging". Where a third party
  decides, say so and name the question to ask them.
- **State the probability of the *plan*, not the *dream*.** Say whether the target
  date is the realistic date or the optimistic one.
- **Name the trade.** If the decision costs something real, put it in its own
  section rather than burying it.

## Building it

`build-report.sh` (same directory) turns the essay plus the dossier files into one
self-contained HTML page — sticky sidebar nav, verdict badges, print CSS, no
external resources:

```bash
build-report.sh research/REPORT.md report.html research/countries
```

- The sidebar nav is **derived from the essay's `<h2>` headings**, so editing the
  essay updates the navigation with no second place to maintain.
- Each directory argument gets appended as an appendix section, one entry per file.
- Requires `pandoc` only. Copy the script into the project's `tools/` so the build
  is reproducible from the repo.

Check the output before claiming it works: confirm the file is self-contained (no
external `src`/`href` references), confirm every nav anchor resolves to an `id`,
and open it once in a browser.

## Where it lives

Put the report in the repo whose state it describes, next to the markdown it was
built from, and name the path in chat. If the user will read it repeatedly, serve
it over the LAN rather than making them hunt for a `file://` path:

```bash
setsid nohup python3 -m http.server 8099 --bind 0.0.0.0 --directory <repo> &
```

Say how to stop it. Offer a permanent service only if they ask for one.
