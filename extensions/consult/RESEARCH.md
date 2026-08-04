# Consult tool — research: how others implement "consult a stronger model"

**Date:** 2026-08-04 · **Method:** delegated background research against primary sources (official docs, repos, arxiv), secondary sources labeled. Two research files merged: `findings.md` (Claude Code) and `findings.md` (other tools + literature) — full sources at bottom.

**TL;DR:** Claude Code has no `/consult` — the real feature is the **Advisor tool** (`/advisor`): the executor model auto-invokes a stronger server-side model mid-task, which sees the *full transcript* (no tools, no files) and returns guidance inside the same API request. Anthropic measured +2.7pp SWE-bench Multilingual at 11.9% lower cost, 2.1× BrowseComp for Haiku. Other tools productize the same idea as review commands with their own model (Codex `/review` + `review_model`), dual-model pipelines (aider architect/editor), per-mode models (Cline), or parallel ensembles (Qwen `/review`, 12 agents). The literature says: same-model self-consult doesn't work (Huang ICLR'24); cross-model consult helps only with genuine asymmetry (different model, capability, or information — Khan ICML'24, Kenton NeurIPS'24); a single critique ≈ full debate (Elasky 2026); critique prompts have known bias failure modes (over-criticism flips correct→wrong, verbosity bias, framing inheritance).

---

# 1. Claude Code: "consultation" is the Advisor tool

## Terminology correction
There is no native `/consult` command or "consultation mode" in Claude Code. The feature that implements "consulting a second model" is the **Advisor tool** (`/advisor`), plus the distinct `/btw` side-question overlay. "Consult" appears only as the verb in advisor docs ("consult the advisor before you continue") and in third-party plugins. — https://code.claude.com/docs/en/commands · https://code.claude.com/docs/en/advisor

## What it is
"The advisor tool lets Claude consult a second, typically stronger model at key moments during a task, such as before committing to an approach, when stuck on a recurring error, or before declaring a task complete." It runs **server-side as a server tool** (`server_tool_use` block named `advisor`) inside the *same* `/v1/messages` request — no extra round-trips or context management. — https://code.claude.com/docs/en/advisor · https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool · https://claude.com/blog/the-advisor-strategy

## Triggers (no keybinding; auto-escalation is the design)
1. `/advisor` command (mid-session; `/advisor opus`; `/advisor off`); saved to `advisorModel` setting.
2. `advisorModel` in settings.json.
3. `--advisor opus` launch flag (precedence over setting; deliberately absent from `--help`).

The **executor model decides when** to call it — "the timing is model-driven rather than rule-based" (before committing to an approach, on recurring errors, before declaring done). Users can request it in a prompt: "consult the advisor before you continue." No cap/force setting in Claude Code; at API level `max_uses` and `tool_choice: {"type":"tool","name":"advisor"}` exist. — https://code.claude.com/docs/en/advisor · https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool

## Context: full transcript, no tools
- The advisor **always receives the full conversation — system prompt, tool definitions, every prior turn, every tool call and result, and the executor's in-progress text.** No filtering, no params (executor's `input` is empty; server builds the advisor's view).
- The advisor runs under its own Anthropic-supplied system prompt; sees the transcript as quoted context. **No tools, no file system, no shell, no web, no MCP. Its thinking blocks are dropped; only the advice text returns.** Not a separate session; cannot continue the conversation itself.
- Guidance is cached as part of the transcript on later turns (later advisor calls see earlier advice); the advisor's own read is not cached between calls (opt-in `caching: {"type":"ephemeral","ttl":"5m"|"1h"}` at API level; worthwhile at ≥3 calls/conversation). — https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool · https://code.claude.com/docs/en/advisor

## Model selection
- Aliases `opus`/`sonnet` (track current default versions) or full IDs. **Claude models only, Anthropic API only** (not Bedrock/Vertex/Foundry).
- **Pairing rule:** advisor must be ≥ executor capability; invalid pairs silently dropped (e.g. Opus 4.6 main cannot use Sonnet 4.6 advisor). Subagents inherit the configured advisor (same pairing check).
- Org `availableModels` allowlists gate it. — https://code.claude.com/docs/en/advisor

## UX
Inline `Advising <model>` line in the transcript; **Ctrl+O expands the full guidance**; advisor sub-inference does not stream (executor's stream pauses with ~30s keepalives). The agent **continues working after** and may contradict the advice when its own evidence conflicts. Guidance survives compaction. — https://code.claude.com/docs/en/advisor · https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool

## Cost / permissions
- **No per-call approval prompt** — the model calls it autonomously; one startup notification ("may use more tokens").
- Billed at advisor rates, reported separately (`usage.iterations[]` `advisor_message` entries; top-level usage = executor only).
- **Typical advisor output: 400–700 text tokens (~1,400–1,800 incl. thinking).**
- **`max_tokens: 2048` recommended — ~7× output reduction, ~0% truncation, no detectable quality loss (n=40).** 1024 → ~10× reduction, ~10% truncated.
- Toggling `/advisor` does not invalidate the main prompt cache (unlike `/model` changes).
- Disable: `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1`. — https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool · https://code.claude.com/docs/en/advisor

## Effectiveness (Anthropic's numbers, with their footnotes)
- SWE-bench Multilingual: Sonnet 4.6 solo 72.1% → +Opus advisor **74.8% (+2.7pp)**, cost per task **−11.9%** vs Opus solo.
- BrowseComp: Haiku 4.5 19.7% → +Opus advisor **41.2% (2.1×)**, at 85% lower cost than Sonnet solo.
- **Nudge data:** a mid-conversation "consult the advisor" nudge raised Haiku pass rates ~7pp; on Sonnet no measurable effect; on Opus slightly *lower*; a turn-2 nudge on workloads whose baseline first call was turn 7+ correlated with **3–4pp drop**. 74–98% of nudged attempts called the advisor immediately.
- Vendor quotes (Bolt, Genspark, Eve Legal) all positive (better plans, 5× lower cost with Haiku+Opus).
- Independent anecdote [secondary]: Sonnet+Opus caught a proration timezone bug after 3 failed fix attempts; same-model (Opus+Opus) still helped on recurring errors but "loses the fresh-eyes effect."
- — https://claude.com/blog/the-advisor-strategy · https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool · https://www.mejba.me/blog/claude-code-advisor-slash-command [secondary]

## Known problems
- Experimental label; v2.1.139 needed env flag `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL=1` [secondary]; absent from stable v2.1.122 (issue #56178).
- **"Narrate then never calls" freeze** — model announces consultation, ends turn with no tool_use, session looks stuck (issue #63880, "same issue faced many times").
- **Cost can exceed baseline on small tasks** ($0.685 vs $0.44 on a small read-only task) [secondary].
- **Advisor loops** (repeated calls, no convergence) and over-calling under aggressive prompts.
- **Full-transcript framing bias** [secondary]: advisor inherits the executor's mis-framed context — the argument for fresh-context subagents instead.
- Docs gaps: picker/allowlist interaction (#67744), subagent frontmatter `advisor:` (#45964).

## Relationship to other features (official table)
| Approach | When the stronger model runs | How it starts |
|---|---|---|
| Advisor tool | At decision points mid-task | Claude calls it when it needs guidance |
| `opusplan` | During plan mode, then Sonnet executes | You enter plan mode |
| Subagents with `model` | Entire delegated subtask | Claude delegates / you invoke |
| `/model` | All subsequent turns | You switch models |

`/btw` (side questions): full-context, no-tools, ephemeral, never enters history — "the inverse of a subagent: full conversation but no tools, vs tools but empty context." — https://code.claude.com/docs/en/interactive-mode#side-questions-with-btw

## Third-party "consult" ecosystem (NOT Anthropic features)
- **raine/consult-llm** (Rust CLI): installs `/consult`, `/debate`, `/collab` skills into Claude Code/Codex/OpenCode; pipes prompts to *other providers* (Gemini, GPT/Codex, Grok, DeepSeek, OpenRouter, LiteLLM) with file context, streamed inline; multi-turn via `thread_id`. — github.com/raine/consult-llm
- **agent-sh/consult** (skills): cross-tool second opinions (Gemini/Codex/Claude/OpenCode/Copilot); known breakage invoking `claude -p` nested in a Claude session. — github.com/agent-sh/consult
- MCP consultant plugins (doodledood/claude-code-plugins, nicknisi/claude-plugins); kreek/consult (human-in-the-loop engineering skills).
- **Our extension is closest in spirit to this third-party pattern** (tool-based, arbitrary provider, isolated proposal) + the advisor philosophy (stronger model at decision points).

---

# 2. Other implementations

## Gemini CLI — internal escalation ladders + subagents
- No "ask another model" button; `/think` PR closed not_planned. Multi-model surface = subagents/remote agents + **internal model roles** (from `defaultModelConfigs.ts`): `classifier`, `summarizer-*`, `edit-corrector`, `fast-ack-helper` on flash-lite (thinking off); `loop-detection-double-check` escalates to gemini-3-pro; `modelChains` = fallback chains pro→flash (isLastResort retries).
- `modelConfigs` per-config `thinkingBudget`/`thinkingLevel`; codebaseInvestigator subagent gets extra budget in docs example.
- — github.com/google-gemini/gemini-cli (docs/cli/generation-settings.md, docs/cli/model-routing.md, packages/core/src/config/defaultModelConfigs.ts)

## OpenAI Codex CLI — review as invocation with its own model
- `/plan` (separate plan), `codex review` (dedicated command), `/review` reviews working tree.
- **`review_model` in config.toml** — explicitly configurable second model for the review role; `codex review -m <model>` per invocation. Context = git diff vs base.
- **Structured verdict output** (cookbook): findings[] with title/body/confidence/priority/**code_location** (file:line), final `"patch is correct" | "patch is incorrect"` + confidence 0–1 via JSON schema. Wrong line citations get comments rejected — forces verifiable claims.
- `/side`/`/btw` ephemeral side chats; `/compact` (cheaper model internally); `/model` + `/fast` tiers.
- — developers.openai.com/codex/cli/reference.md, /codex/cli/features, /cookbook/examples/codex/build_code_review_with_codex_sdk

## Aider — architect/editor dual-model pipeline (the canonical two-model pattern)
- `--architect`: main Architect model proposes in prose; an **Editor model** (`--editor-model`) converts the proposal into file edits.
- **Numbers:** o1-preview+editor = 85.0% vs 79.7% solo; **same-model pairing also helped** (sonnet→sonnet 80.5% vs 77.4%) — two inference passes beat one. Cost: "two LLM requests."
- `--weak-model` for commits/summarization (small-model-for-meta pattern).
- — aider.chat/docs/usage/modes.html, aider.chat/2024/09/26/architect.html

## opencode (opencode.ai)
- Agents: `build`/`plan` (+subagents general/explore); Tab/Shift+Tab cycles agents (this is the "shift+tab" thing, not a model switch).
- `small_model` for titles/summaries/internal agents; per-model `variants` (thinking depth), **Ctrl+T cycles variants** — same model, different thinking effort, like gears.
- Subagents run in child sessions with fresh context, own `model: provider/model#variant`.
- — opencode.ai/v2/docs/agents, dev.opencode.ai/docs/models/

## Cursor
- `@` attaches context (files/dirs/docs), not models. Model switch is manual; docs recommend "plan with a thinker, execute with a fast model."
- **Auto/Cursor Router** (classifier routes per-request by task type/complexity; user picks Cost/Balance/Intelligence).
- **Cautionary tale [secondary]:** agent spawned `Task` subagents on premium models without consent, burning quota — uncontrolled "stronger model" defaults are a real cost hazard (forum thread 165267).

## Cline / Roo Code — per-mode models
- Plan (read-only) vs Act (execution) with **different models per mode** (`planModeApiProvider/model`, `actModeApiProvider/model`) + separate thinking budgets; hot-swaps API handler mid-task. Example configs: GLM-4.6 plan / Grok act (cost), Opus plan / Sonnet act (quality). Known bug: selections ignored for Claude Code provider (#4733).
- Roo: Code/Architect/Ask/Debug modes, custom modes with YAML prompts + per-mode models/tools.

## Qwen Code CLI — most explicit ensembles
- Hybrid thinking (`enable_thinking`, `/effort` low..max, `thinking_budget`).
- **`/review`: "Multi-agent code review (12 parallel agents at high effort)"** — the most explicit parallel ensemble in any CLI.
- `/btw` side questions: separate API call, **last ~20 messages**, not in main history (isolated consultant); `/plan`; `/model --fast` aux models; `/fork` background agent inheriting conversation.
- — github.com/QwenLM/qwen-code, docs.qwencloud.com/developer-guides/text-generation/thinking

## Others
- **Zed:** parallel threads, each with own agent/model (even external ACP agents), worktree isolation, per-thread model selector — "parallel ensembles + isolated contexts" at the editor level.
- **Windsurf:** Plan mode writes persistent `plan.md`; **a background planning agent continuously refines the long-term plan while the main model works** (dedicated second model for planning); model family split SWE-1.5 / SWE-1-mini / SWE-grep.
- **Continue.dev:** per-role model routing (`roles: chat, edit, apply, autocomplete, embed, rerank, summarize`), review agents comparing diffs vs team rules.
- Goose/Augment/Amazon Q: not verified with primary sources this session.

---

# 3. Literature

## Self-correction: intrinsic (same-model) critique does NOT work
- **Huang et al., "LLMs Cannot Self-Correct Reasoning Yet"** (ICLR 2024, arxiv 2310.01798): GPT-3.5/4/4-Turbo, Llama-2 all *dropped* after 1–2 self-correction rounds (GPT-4 GSM8K 95.5→89.0); correct→incorrect flips dominate; "improvements" in Reflexion/RCI came from oracle labels, Self-Refine from a suboptimal initial prompt; multi-agent debate ≈ self-consistency at equal cost. **Feedback must be external.**
- **Li et al., "Confidence Matters"** (arxiv 2402.12563): self-correction *can* work gated on confidence — **If-or-Else prompting** ("if very confident, maintain; otherwise update") beats critical-prompt baselines (+3.4/+7.6). **Over-criticism is the failure mode:** "find your problems" phrasing flips correct answers wrong; one-stage feedback+update ≈ two-stage; when drafts disagree, a third "decision refinement" pass helps (disagreement detection triggers escalation).
- Tyen et al., "LLMs Cannot Find Reasoning Errors, but Can Correct Them" (2311.08516): models can fix an error once *pointed at it* — the architect/editor split.

## Cross-model consultation: helps, with conditions
- **Zheng et al., "Judging LLM-as-a-Judge"** (NeurIPS 2023, 2306.05685): GPT-4 judges >80% human agreement. **Judge biases: position (65% consistency on swapped answers), verbosity (repetitive-list attack fools 91%), self-enhancement (GPT-4 +10pp, Claude-v1 ~25pp), weak math grading (14/20 failures)**. Mitigations: position swapping, **reference-guided judging** (14/20→3/20), few-shot (65→77.5).
- **Du et al., "Multiagent Debate"** (ICML 2024, 2305.14325): N agents × R rounds improve arithmetic 67→81.8, GSM8K 77→85; saturates ~4 agents; **mixed model types help most** (chatGPT+Bard joint debate beats either alone); debates can converge to confidently-wrong consensus.
- **Khan et al., "Debating with More Persuasive LLMs…"** (ICML 2024, 2402.06782): weak judges supervise strong models via debate (48→76% LLM, 60→88% human); debate > single-expert consultancy; **optimizing a single consultant for persuasiveness makes it MORE misleading**; judges trust **verified quotes** over arguments; word limits + order swapping mitigate biases; symmetric same-model debate ≈ no help.
- **Kenton et al., "Scalable Oversight: Weak LLMs Judging Strong LLMs"** (NeurIPS 2024, 2407.04622): debate > consultancy at scale (~5M calls), but **usually not > direct QA** — second opinions help mainly when the judge *lacks information*, not just when it's weaker; **open consultancy amplifies the strong model's error** when it chose wrong.
- **Elasky et al., "Debate Helps Weak Judges Reward Stronger Models"** (2026 preprint, 2605.27483): on verifiable code: proposer–critic debate lifts judge F1 7–16pp on 3/5 pairings. **A single independent critique ≈ full debate.** Payoff condition: (i) critic's classification accuracy > judge's answer-only accuracy (generator-verifier gap is NOT sufficient); (ii) **judge must verify claims, not summarize them** (non-responder judges' verification collapses 67–82%→16–31% when the critic appears).
- **EAPO** (arxiv 2509.23730): on-demand "consult-expert" action in RL with penalty annealed to zero; **heterogeneous experts essential** (homogeneous ≈ no gain, "redundancy amplification"); parallel > sequential.

## Critique-prompt design takeaways
1. Never let the same model answer AND judge without an external anchor.
2. Verdict formats work: structured findings + file:line citations + correct/incorrect + confidence (Codex).
3. Confidence-gating beats blind criticism; avoid "find your problems" phrasing.
4. Verification beats eloquence: verified quotes > arguments; strict word limits kill verbosity bias.
5. The critic must be better at *judging* than the judge; the judge must verify, not defer.
6. Two-sided adversarial > one-sided consultant (single consultants can become more misleading).
7. Bias checklist for any LLM judge: position, verbosity, self-enhancement, sycophancy, math grading.

---

# 4. Design-pattern taxonomy (which tools use what)

1. **Mode-based plan/act separation** — Codex `/plan`, Cline Plan/Act, Roo modes, Windsurf modes, opencode plan agent, Cursor Plan Mode, Qwen `/plan`, Gemini plan mode. (Grounding: don't edit while reasoning; Huang.)
2. **Role-based dual-model pipelines (architect/editor, planner/executor)** — aider, Cline per-mode models, Roo, Windsurf background planner, Cursor's manual guidance, Qwen `/review`. (Tyen, Khan, EAPO.)
3. **Review as a distinct invocation with its own model** — Codex `/review` + `review_model`, Cursor `/review`, Qwen `/review`, Continue review agents, aider `/architect`. **This is the direct productization of "consult a stronger model."**
4. **Side-chats / isolated consultant contexts** — Codex `/side`, Qwen `/btw` (last 20 msgs), opencode subagents, Cursor side chats, Zed threads. Scoped context: cheaper, prevents main-thread pollution (but Kenton: less information asymmetry = less benefit — scope deliberately).
5. **Small/weak model for meta-tasks, big model for real work** — opencode `small_model`, aider `--weak-model`, Qwen `/model --fast`, Continue roles, Gemini flash-lite internal roles. (Inverse of our pattern.)
6. **Escalation ladders / model chains** — Gemini `modelChains`, opencode variants (Ctrl+T), Cursor Router, Codex `/model`+`/fast`, Qwen `/effort`. (Escalation helps only when the stronger model is genuinely better at the subtask.)
7. **Parallel ensembles** — Qwen `/review` (12 agents), Zed threads, Cursor parallel agents, Du debate. (Heterogeneous priors required; at equal inference cost ≈ self-consistency.)
8. **Iteration loops with verification** — Cline plan→act cycling, Windsurf plan.md (external memory), aider ask→code→test loops, Codex plan→exec→review. (Huang: executor/tests are the reliable external feedback.)

**Cross-cutting caution:** every consult feature inherits judge biases (Zheng); one-sided consultation of a stronger model can amplify its errors (Khan, Kenton); same-model self-consult empirically doesn't work (Huang, Khan). Effective tools add **asymmetry** (different model/capability/information/external verifier) and **isolation**.

---

# 5. Implications for our consult extension

**Status 2026-08-04 — adopted:** A, B, C, E, F, G (implemented). **Rejected:** D (keep the consultant's context lean; the agent passes code itself when needed — auto-attaching files invites over-copying). **Deferred:** H (parallel `models: string[]`), I (`focus: "revise"`).

Our extension vs the field: we're closest to the third-party consult-llm pattern (tool-based, arbitrary provider, isolated proposal) plus advisor philosophy (stronger model at decision points). Our deliberate differences: **isolated context** (advisor gets full transcript — and inherits its framing; ours stays independent), **agent-invoked** (no auto-escalation loops), **explicit proposal** (agent must articulate the design — the "consultant can't see the repo" contract).

Evidence-grounded change ideas, ranked by value/effort:

| # | Idea | Evidence | Effort |
|---|---|---|---|
| A | **Lower output budget.** `MAX_OUTPUT_TOKENS` 24000 → ~8000 (K3 output $15/MTok; advisor-typical 400–700 text tokens + ~1,100 thinking; 2048 cap → ~7× cheaper, no quality loss). Keep reasoning-trace cap. | Claude advisor cost data | trivial |
| B | **Verbosity cap + confidence gating in system prompt.** Hard cap (~600 words: "every sentence must earn its place" is already there — make it explicit); rate each concern high/medium/low confidence; explicitly allowed to say "sound, no significant issues" — don't manufacture criticism. | Li (over-criticism flips correct→wrong), Zheng (verbosity bias), advisor output norms | trivial |
| C | **Prompt caching.** Pass stable `sessionId`/`cacheRetention` to `streamSimple` so the fixed system prompt hits cacheRead ($0.3/MTok vs $3). Verify opencode.ai endpoint honors it first. Worthwhile at ≥3 consults/conversation. | Claude advisor caching advice | small |
| D | **`attach` param — give the consultant file context.** Optional `attach: string[]` (paths/globs); extension reads files (size-capped, e.g. 50KB total) and inlines into `context`. Directly answers Kenton: consultation helps when the judge lacks information — our consultant is capability-strong but info-poor; Claude's advisor is info-rich. Input is cheap. | Kenton (asymmetry), consult-llm (file context), Codex review (diff context) | medium |
| E | **Parseable verdict line.** Consultant ends with `VERDICT: sound\|workable\|wrong (confidence 0–1)` so the agent can branch on it. | Codex structured verdict; Khan (verdict formats) | trivial |
| F | **Question-the-premise instruction.** Add to system prompt: "If the proposal's framing is wrong, say so first." Counteracts framing inheritance / consultancy amplification of errors. | Khan, Kenton (open consultancy amplifies strong-model errors) | trivial |
| G | **Agent-side guidelines.** promptGuidelines additions: (1) treat the result as *claims to verify* against the repo, not truth — especially before acting on recommendations; (2) don't consult for trivial/reversible decisions or before you have a concrete proposal (early consultation correlates with *worse* outcomes). | Elasky (judge must verify), Claude nudge data (−3–4pp early nudges) | trivial |
| H | **`models: string[]` parallel consult (phase 2).** Run 2 heterogeneous models, return both verdicts + disagreement. Cost doubles; evidence says heterogeneity is what makes it pay (same-model ensembles ≈ no gain). | Du (mixed types best), EAPO (heterogeneous essential), Qwen `/review` | larger |
| I | **`focus: "revise"` variant (phase 2).** Aider-style: instead of reviewing, return an improved proposal. | aider architect/editor, Tyen (correct-if-pointed-at) | medium |

Already-good decisions validated by the research: isolated context (avoids framing bias, per advisor critiques + Khan/Kenton), agent-invoked (no auto-loop over-calling; Cursor's quota-burn cautionary tale), explicit model+reasoning params (escalation ladder pattern), focus modes (role-based pipeline pattern).

---

## Source index

**Claude Code:** code.claude.com/docs/en/advisor · /commands · /interactive-mode (btw) · platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool · claude.com/blog/the-advisor-strategy · github.com/anthropics/claude-code CHANGELOG + issues #56178 #45964 #63880 #67744 #30531 · [secondary] vincentschmalbach.com (env flag, cost test) · mejba.me (loops, compaction, framing) · HN 48260621 · third-party: github.com/raine/consult-llm, github.com/agent-sh/consult

**Tools:** gemini-cli docs + defaultModelConfigs.ts · developers.openai.com/codex (reference, features, cookbook) · aider.chat (modes, architect, options) · opencode.ai (agents, tui, models) + PR #6839, issue #16207 · cursor.com (context, prompting, cloud-agents) + forum 165267 [secondary] · docs.cline.bot (plan-and-act) + deepwiki [secondary] · github.com/QwenLM/qwen-code + docs.qwencloud.com · zed.dev/docs/ai/parallel-agents · docs.windsurf.com (cascade modes) · betterstack/digitalapplied for Continue [secondary]

**Literature:** arxiv 2310.01798 (Huang, ICLR'24) · 2402.12563 (Li) · 2306.05685 (Zheng, NeurIPS'23) · 2305.14325 (Du, ICML'24) · 2402.06782 (Khan, ICML'24) · 2407.04622 (Kenton, NeurIPS'24) · 2605.27483 (Elasky, preprint) · 2509.23730 (EAPO) · 2311.08516 (Tyen, referenced)
