---
name: research
description: Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to a background agent.
---

# Research

Spin up background agents to do the research, so you keep working while they read. Each agent investigates one question against **primary sources** — official docs, source code, specs, arxiv, first-party APIs — not a secondary write-up of them.

## Steps

### 1. Scope threads
Split the question into independent **threads** — one thread = one question that can be answered without the others. Each thread becomes one subagent; a single-question task needs one; a quick fact-check needs none (see step 2).
*Done when:* every thread is answerable on its own, without reference to another thread's findings.

### 2. Dig or delegate
- **Quick fact-check** — a few URLs, or a question you already half-know: search directly. You have `web_search` / `web_fetch` yourself, plus `web_scrape` via the web-tools extension.
- **Real research** (the normal case): delegate. Follow the subagents skill, with one deliberate override: **research subagents must NOT use `--no-extensions`** — the web tools are extension-provided, so stripping extensions blinds them. Give them exactly `web_search,web_fetch,write` and nothing else.

### 3. Spawn one subagent per thread (parallel)
Read `RESEARCH-PROMPT.md` (same directory as this skill) and append its contents to the prompt, e.g.:
```bash
pi \
  --model opencode-go/deepseek-v4-flash \
  --tools web_search,web_fetch,write \
  --no-skills --no-context-files \
  --thinking medium \
  --print \
  --session-dir /tmp/pi-subagent-<thread>-$(date +%s) \
  "<thread question> — write findings.md to this session dir.
   <RESEARCH-PROMPT.md contents>"
```
Run all threads in parallel (one bash call each). Each agent writes `findings.md` into its own `--session-dir` and prints a ≤15-line summary.
*Done when:* every thread has a `findings.md` whose every claim carries its source URL.

### 4. Merge into one file
Read each `findings.md` and synthesize **one** Markdown file:
- Header: date + method (sources used, any gaps).
- **TL;DR** — the answer in a few lines, before the detail.
- One section per thread; every claim keeps its inline source URL; secondary sources stay labeled `[secondary]`.
- **Source index** at the end (primary sources first).

Save it where the repo already keeps such notes; match the existing convention, and if there is none, put it somewhere sensible and say where.
*Done when:* every claim in the final file carries a source URL and a source label — nothing uncited survives the merge.

### 5. Audit with consult (recommended)
Before delivering, run the `consult` tool: pass the merged file as `context` and ask it to review for gaps, unsupported claims, and missing primary sources — hallucinated citations are the risk here. Fix what it flags. Skip for small fact-checks.
*Done when:* every audit flag is either fixed or consciously rejected.

### 6. Deliver
Answer in chat first (lead with the conclusion, then the evidence, then caveats), name the file's path, and commit it if the repo convention tracks notes (pi-setup: yes — commit and push).

## Reference

- **Primary source**: official docs, source code, specs, arxiv, first-party APIs. A blog post about the docs is not the docs.
- **Citation rule**: claim + URL inline; `[secondary]` for anything not primary; source index at the end.
- **Prompt contract** (codified in `RESEARCH-PROMPT.md`): primary-first, per-claim URLs, secondary labeling, dense output, retry failed searches, write `findings.md` to the session dir, print a short summary.
