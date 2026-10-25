---
name: deep-research
description: Answer one question with a researched report — parallel searchers, a coverage judge, a single writer, then an audit that refetches every source it cites. Use when the answer needs many sources and you want the file, not a chat reply.
argument-hint: "<the question, and what the answer is for>"
disable-model-invocation: true
---

# Deep research

Six stages, run as a graph by [`workflow.js`](workflow.js) in this directory.
You do the scoping and the delivery; the script does the execution, so the shape
is identical on every run.

| stage | who | produces |
|---|---|---|
| seek | one `researcher` per sub-question, parallel | `findings/<id>.md` — claims, verbatim quotes, numbered sources |
| coverage | one `reviewer` | verdict: sufficient, or up to 3 named gaps (`rounds: 2`) |
| gap-fill | one `researcher` per gap | `findings/gap-N.md`, same format (`rounds: 2`) |
| draft | one `worker` | `draft.md` — the only writer on the run |
| audit | one `researcher` that fetches each cited URL | `audit.md` — per-claim supported / contradicted / absent / dead |
| revise | one `worker` | `report.md` — `draft.md` corrected against the audit |

The children run on `read`, `write`, `bash` and `web_search`, each in a fresh
context: a stage judges `brief.md` and the notes, never the conversation that
produced the question. There is no `fetch_content` and no `source_check` in this
setup: the `curl` recipe inside the script is how a page gets read.

**Cost.** `plan` length + 3 to +6 children, and roughly 15× the tokens of a chat
turn. A question one search answers is a bad fit — answer it directly and say why.

## 1. Write the brief

Pick the run directory where the user will look for the result: `research/<slug>/`
in the current repo, or `$TMPDIR/deep-research/<slug>` for something throwaway.
`mkdir -p <dir>/findings`, then write `brief.md` — the searchers write into that
directory and the script never creates it:

- the question, restated in one sentence with the ambiguity resolved the way the
  user means it;
- what the answer is *for* — a decision, a build, curiosity — and who reads it;
- what a good answer contains: the specific comparisons, numbers, or
  recommendations it must land;
- scope edges: what is out of bounds, and any source that counts as
  authoritative for this topic;
- today's date.

**Done when** someone who never saw the conversation could tell from `brief.md`
alone whether a finished report answers it.

## 2. Recon before you plan

Three to five `web_search` calls, and read the two or three best pages with
`curl -sSL --max-time 20 --compressed -A 'Mozilla/5.0' <url> | sed -e 's/<[^>]*>//g'`.
This is what turns a topic into sub-questions: you are learning the vocabulary,
finding who owns the facts, and seeing which claims are contested.

**Done when** you can name the authoritative sources for this topic and the two
or three things that actually decide the answer. If recon already answers the
question, give the answer in chat and say the graph was not worth its cost.

## 3. Plan the fan-out

The plan is the run's `args.plan` — data, not prose. Three to eight items, and the
count is the fan-out width, so it is also the cost knob. Each item:

- **independent** — answerable without another item's answer. A question that
  needs a sibling's answer belongs to the gap-fill round, not the plan;
- **non-overlapping** — the `angle` field states the boundary, so two searchers
  do not read the same three pages;
- **self-contained** — a searcher sees its own question and `brief.md`, never a
  sibling's;
- **an artifact, not a topic** — "the rate limit the provider documents, with the
  number and the tier it applies to", never "rate limits";
- `id` is lowercase, hyphenated, unique: `py-default`, `js-parity`.

**Done when** every item could be handed to a competent researcher who has never
heard of the others, and together they cover the brief with no item doing another's
work.

## 4. Run the graph

`subagent` is reachable only from codemode in this setup, and `workflow: true`
(an inline script block) is rejected from a codemode call — pass the script path.

```js
const result = await tools.subagent({
  workflow: "/abs/path/to/skills/engineering/deep-research/workflow.js",
  args: {
    outdir: "/abs/path/research/<slug>",
    rounds: 2,
    tier: "standard",
    plan: [
      { id: "py-default", question: "…", angle: "…" },
      { id: "js-parity", question: "…", angle: "…" },
    ],
  },
  async: true,
  options: { timeoutMs: 2700000, toolTimeoutMs: 240000 },
});
```

`toolTimeoutMs` is the backstop for a `curl` that ignores its own `--max-time`:
it kills a single tool call that stays open, instead of letting one searcher hold
the whole run.

The brief is not an arg: every child reads `brief.md` from `outdir`, so the file
is the one copy and an edit between stages reaches the next one.

`rounds`: `2` unless the question is narrow enough that one pass cannot leave a
hole. `tier`: `light` for a quick scan, `standard`, `deep` for a contested or
high-stakes question — it sets how many searches each searcher spends. `model`,
optional, overrides the model for every child.

It returns a receipt at once and the completion wakes you. Read the summary it
brings: it names the stages that failed.

## 5. Deliver

Read the run's `deliverable` (`report.md`, or `draft.md` when the revise stage
failed) and `audit.md`. In chat: the answer in three or four sentences, the path
to the deliverable, the path to `audit.md`, and the lines from the audit's
must-fix list that the revise stage did not clear. Claims the audit marked
unverified are still unverified — say which ones rather than smoothing over them.

**Done when** the user has the file path and knows what in it is load-bearing
versus unconfirmed.

## Recovery

| what you see | what to do |
|---|---|
| `every seeker failed` | the child model or the search backend is down. Check one `web_search` from this session, then rerun; do not hand-write the research |
| `draft failed`, or `draft.md` under ~2 kB | read the seeker notes; if they are thin the plan was wrong, so revise the plan and rerun. Do not patch the report yourself |
| `revise` failed or missing | deliver `draft.md`, and list the audit's must-fix items in chat as open. Never label an unrevised draft as verified |
| coverage returned no structured verdict | round 2 was skipped. Go straight to draft if the notes are solid, otherwise rerun with `rounds: 2` |
| audit skipped every claim as `dead` | `curl` is being blocked or rate-limited. Fetch two cited URLs by hand before trusting the report |
| one sub-question still open after gap-fill | that is a real finding. Report it as open in the delivery, do not let it become prose |

## Why this shape

The graph is the load-bearing part, so keep it when you change a prompt.

- **One writer.** Sections written in parallel read as disjoint sections; both
  LangChain and Cognition landed on a single final writing pass.
- **A citation audit that fetches.** Link validity runs above 94% while factual
  support for the cited claim runs 39–77% — the citation is not the evidence, so
  a separate agent re-reads every load-bearing source.
- **Coverage as a judgment, not a count.** The gap question is asked by an agent
  that did not do the searching, then the gaps are closed by name, once.
- **Notes in files, digests in context.** Each searcher writes its notes down and
  returns ten lines. The writer reads the files, so nothing has to survive a
  summary chain.
