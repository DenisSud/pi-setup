/**
 * consult — a "second opinion" tool for pi (Claude Code's consult-opus pattern)
 *
 * Registers the `consult` tool: the main agent can ask a frontier model
 * (kimi-k3 via the opencode-go provider, by default) to review a design,
 * architecture, or plan before committing to it.
 *
 * Usage posture: neutral. The prompt guidelines describe when consult is
 * useful and how to use it well — no frequency hype, no gatekeeping (no
 * "only for big decisions" / "don't waste inference" phrasing either).
 * Keep the copy matter-of-fact when editing.
 *
 * Design:
 *   - The consulted model is fully independent: it sees only the proposal,
 *     context, and question the agent passes. No repo, no session history.
 *   - Calls go through pi's own provider stack (pi-ai): model and auth are
 *     resolved from the live model registry facade (ctx.modelRegistry), and
 *     the request streams through pi-ai's compat entrypoint — which the
 *     extension loader maps the pi-ai root import to — so SSE parsing,
 *     reasoning_content extraction, and usage accounting are not
 *     reimplemented.
 *   - Live progress is streamed via onUpdate; Esc aborts the request through
 *     the tool signal.
 *   - The result returns the final answer as tool content, plus the model's
 *     reasoning trace, token usage, and estimated cost in details so the
 *     agent can judge both the advice and the price.
 *
 * Cost: kimi-k3 on opencode-go (see opencode.ai/zen for current pricing).
 * A typical consult runs $0.005–0.03. The system
 * prompt is fully static and marked for caching (explicit cache_control
 * opt-in, since the catalog does not declare cacheControlFormat for
 * kimi-k3), so repeated consults hit the endpoint's prefix cache at
 * the cacheRead rate. Default reasoning effort is
 * "high"; use "max" for the strongest critique (slower), "low" for cheap
 * quick sanity checks.
 *
 * Config: provider/model are resolved from the pi model registry, so no
 * hardcoded endpoints or keys. Override the consulted model per call with
 * the `model` parameter (any text model on the provider).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";

/** Provider hosting the consultant model. */
const PROVIDER = "opencode-go";
/** Default consultant model. */
const DEFAULT_MODEL = "kimi-k3";

/** Throttle for live progress updates (ms). */
const UPDATE_THROTTLE_MS = 300;
/** Answer preview length shown in progress updates (chars). */
const ANSWER_PREVIEW_CHARS = 3000;

/** Per-focus instruction appended to the USER message (not the system prompt —
 *  the system prompt must stay static so repeated consults hit the endpoint's
 *  prefix cache: cacheRead $0.3/MTok vs $3/MTok input). */
const FOCUS_PROMPTS: Record<string, string> = {
	"critical-review":
		"Focus: a general critical review — what is wrong, what is risky, what is overcomplicated, and what to change.",
	alternatives:
		"Focus: alternatives. Propose and compare concrete alternative approaches; for each, state the trade-off versus the proposal and say which you would pick and why.",
	risks:
		"Focus: risks and failure modes. What breaks first, what degrades silently, what is hard to recover from, and what edge cases are missing.",
	implementation:
		"Focus: implementation. How to structure the work, what to build first, common pitfalls, and what to test.",
	validation:
		"Focus: validation. Is this plan sound and ready to execute? What must be verified or decided before committing?",
};

/**
 * The consultant system prompt. Fully static — no per-call interpolation — so
 * the endpoint's prefix cache (cacheRead) covers it across all consults.
 * The consulted model must be told it has no access to the repo — otherwise it
 * will fabricate knowledge of files it never saw.
 */
function buildSystemPrompt(): string {
	return `You are a principal engineer acting as an external consultant. An AI coding agent asked you to review a proposal. You cannot see its codebase or conversation — you work only from what it sends you, and where the proposal references things you cannot inspect, say that you are assuming.

Give a direct, honest assessment. No sycophancy. If the proposal's framing itself is wrong — wrong goal, wrong constraint, false premise — say so first. Do not manufacture criticism: if the proposal is fundamentally sound, say so plainly. Only flag issues you are genuinely confident are real, and rate each concern's confidence (high/medium/low) that it is a real problem.

Hard cap: respond in under 600 words. Dense; every sentence must earn its place. Do not restate the proposal.

Respond in Markdown:
1. **Verdict** — one or two sentences: sound / workable with changes / wrong.
2. **Key concerns** — the most important problems, ordered by severity, each with a confidence rating (high/medium/low).
3. **What's right** — what should stay as-is.
4. **Recommendations** — concrete changes in order of impact. Prefer the simplest approach that still meets the goals; explicitly call out where the proposal is more complex than needed.
5. **Open questions** — what the requester must verify or decide before proceeding.

End with a single parseable line, nothing after it: VERDICT: sound | workable | wrong (confidence 0–1)`;
}

/** Assemble the user message from the optional parts. */
function buildUserText(proposal: string, context?: string, question?: string, focus?: string): string {
	const parts: string[] = [];
	parts.push(`## Proposal\n\n${proposal}`);
	if (context?.trim()) parts.push(`## Context\n\n${context.trim()}`);
	if (question?.trim()) parts.push(`## Question\n\n${question.trim()}`);
	const focusLine = focus && FOCUS_PROMPTS[focus];
	if (focusLine) parts.push(`## Focus\n\n${focusLine}`);
	return parts.join("\n\n");
}

function errMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

export default function consultExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "consult",
		label: "Consult",
		description:
			"Ask a frontier model (kimi-k3) for expert feedback on a design, architecture, or plan. It stress-tests the proposal, surfaces risks, and suggests simpler alternatives. The consulted model sees only what you pass in — it has no access to the repo or conversation, so include the full proposal text and any relevant code/constraints.",
		promptSnippet:
			"Consult a frontier model (kimi-k3) for expert feedback on a design, architecture, or plan",
		promptGuidelines: [
			"Use consult when you need a second opinion from a much stronger model before committing: validating an architecture, stress-testing a design decision, choosing between alternatives, stuck on a recurring error, or before declaring consequential work done.",
			"A concrete proposal helps, but it does not need to be polished — describe the design as precisely as you can, including what is still undecided; the consultant can still flag wrong constraints and missing risks.",
			"Pass the full proposal (paste the actual design, not a summary) and put constraints, prior decisions, and relevant code snippets into the context parameter yourself — the consulted model cannot see the repo or conversation.",
			"Treat the result as claims to verify against the repo, not ground truth. Ask one specific question via the question parameter, and pick focus and reasoning to match the stakes: low for a cheap sanity check, max for a deep critique.",
		],
		parameters: Type.Object({
			proposal: Type.String({
				description:
					"The idea, design, or architecture to review. Paste the actual proposal (or describe it precisely) — the consulted model has no other way to see it.",
			}),
			context: Type.Optional(
				Type.String({
					description:
						"Additional context the consulted model should consider: relevant code snippets, constraints, trade-offs already considered, prior decisions.",
				}),
			),
			question: Type.Optional(
				Type.String({
					description:
						"A specific question to answer, e.g. 'Is this the right abstraction?', 'What are the risks?', 'Is there a simpler approach?'. Omit for a general critical review.",
				}),
			),
			focus: Type.Optional(
				Type.Union(
					(["critical-review", "alternatives", "risks", "implementation", "validation"] as const).map((v) =>
						Type.Literal(v, {
							description: {
								"critical-review": "General critical review (default)",
								alternatives: "Propose and compare alternative approaches",
								risks: "Focus on failure modes, risks, and edge cases",
								implementation: "Focus on how to implement it",
								validation: "Is the plan sound and ready to execute?",
							}[v],
						}),
					),
				),
				{ description: "What kind of feedback to get (default: critical-review)" },
			),
			model: Type.Optional(
				Type.String({
					description: `Model to consult on the "${PROVIDER}" provider. Defaults to "${DEFAULT_MODEL}".`,
				}),
			),
			reasoning: Type.Optional(
				Type.Union(
					(["low", "high", "max"] as const).map((v) =>
						Type.Literal(v, {
							description: {
								low: "Cheap and fast, shallow review",
								high: "Balanced depth and cost (default)",
								max: "Deepest critique, slowest and most expensive",
							}[v],
						}),
					),
				),
				{ description: "Thinking effort for the consulted model (default: high)" },
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return runConsult(
				ctx,
				{
					proposal: params.proposal,
					context: params.context,
					question: params.question,
					focus: params.focus,
					model: params.model,
					reasoning: params.reasoning,
				},
				signal,
				onUpdate,
			);
		},
	});
}

interface ConsultParams {
	proposal: string;
	context?: string;
	question?: string;
	focus?: string;
	model?: string;
	reasoning?: string;
}

async function runConsult(
	ctx: ExtensionContext,
	params: ConsultParams,
	signal: AbortSignal | undefined,
	onUpdate: ((update: { content: { type: "text"; text: string }[] }) => void) | undefined,
): Promise<{
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
	isError?: boolean;
}> {
	const errorResult = (text: string, details: Record<string, unknown> = {}) => ({
		content: [{ type: "text", text }],
		details,
		isError: true,
	});

	// ── resolve provider + model from pi's live registry ─────────────────
	const allModels = ctx.modelRegistry.getAll();
	if (!allModels.some((m) => m.provider === PROVIDER)) {
		return errorResult(
			`consult: provider "${PROVIDER}" is not registered in this pi setup. Check models.json / the model catalog.`,
		);
	}
	const requested = params.model ?? DEFAULT_MODEL;
	const model = ctx.modelRegistry.find(PROVIDER, requested);
	if (!model) {
		const available = allModels
			.filter((m) => m.provider === PROVIDER && m.input?.includes("text"))
			.map((m) => m.id)
			.join(", ");
		return errorResult(
			`consult: model "${requested}" not found on provider "${PROVIDER}". Available text models: ${available}`,
		);
	}

	// ── resolve auth the way pi does ─────────────────────────────────────
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		return errorResult(`consult: failed to resolve auth for "${PROVIDER}": ${auth.error}`, {
			model: model.id,
			provider: PROVIDER,
		});
	}
	const { apiKey, headers } = auth;
	if (!apiKey) {
		return errorResult(
			`consult: no API key configured for provider "${PROVIDER}". Configure it in auth.json or via the provider login flow.`,
			{ model: model.id, provider: PROVIDER },
		);
	}

	// ── prompt caching ──────────────────────────────────────────────────
	// The system prompt is static, and with cacheControlFormat: "anthropic"
	// pi-ai marks it with cache_control so the endpoint caches the prefix
	// across consults (cacheRead $0.004/MTok vs $0.44/MTok input). The catalog
	// does not declare cacheControlFormat for kimi-k3, so opt in by
	// cloning the model; if a future catalog entry declares it, use the model
	// as-is.
	const cachedModel = model.compat?.cacheControlFormat
		? model
		: { ...model, compat: { ...(model.compat ?? {}), cacheControlFormat: "anthropic" } };

	// ── build the consult prompt ─────────────────────────────────────────
	const reasoning = (params.reasoning ?? "high") as "low" | "high" | "max";
	const streamOptions: SimpleStreamOptions = {
		signal: signal ?? undefined,
		apiKey,
		headers,
		reasoning,
		cacheRetention: "short",
	};

	onUpdate?.({ content: [{ type: "text", text: `Consulting ${model.id} (${reasoning} effort)…` }] });

	let answer = "";
	let thinking = "";
	let lastPush = 0;
	const pushProgress = () => {
		const preview = answer
			? `${answer.slice(0, ANSWER_PREVIEW_CHARS)}${answer.length > ANSWER_PREVIEW_CHARS ? "…" : ""}`
			: `${model.id} is thinking… (${thinking.length} chars so far)`;
		onUpdate?.({ content: [{ type: "text", text: preview }] });
	};

	// ── stream through pi-ai's real provider path ────────────────────────
	try {
		const stream = streamSimple(
			cachedModel,
			{
				systemPrompt: buildSystemPrompt(),
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: buildUserText(params.proposal, params.context, params.question, params.focus) }],
					},
				],
			},
			streamOptions,
		);

		for await (const event of stream) {
			if (event.type === "text_delta") answer += event.delta;
			else if (event.type === "thinking_delta") thinking += event.delta;
			const now = Date.now();
			if (now - lastPush > UPDATE_THROTTLE_MS) {
				lastPush = now;
				pushProgress();
			}
		}

		const result = await stream.result();

		if (result.stopReason === "error" || result.stopReason === "aborted") {
			if (signal?.aborted) {
				return errorResult("consult: aborted.", { model: model.id, provider: PROVIDER, stopReason: result.stopReason });
			}
			return errorResult(
				`consult: the model returned an error: ${result.errorMessage ?? result.stopReason}`,
				{ model: model.id, provider: PROVIDER, stopReason: result.stopReason },
			);
		}

		const contentText = result.content
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("\n")
			.trim();
		const thinkingText = result.content
			.filter((b): b is { type: "thinking"; thinking: string } => b.type === "thinking")
			.map((b) => b.thinking)
			.join("\n")
			.trim();

		const finalAnswer = contentText || answer.trim();
		if (!finalAnswer) {
			return errorResult("consult: the model returned an empty answer.", {
				model: model.id,
				provider: PROVIDER,
				stopReason: result.stopReason,
			});
		}

		const usage = result.usage;
		const costUsd =
			usage && model.cost
				? (usage.input * (model.cost.input ?? 0) +
						usage.output * (model.cost.output ?? 0) +
						usage.cacheRead * (model.cost.cacheRead ?? 0)) /
					1_000_000
				: undefined;

		return {
			content: [{ type: "text", text: finalAnswer }],
			details: {
				model: model.id,
				provider: PROVIDER,
				focus: params.focus ?? "critical-review",
				reasoning: thinkingText,
				usage: usage
					? {
							input: usage.input,
							output: usage.output,
							cacheRead: usage.cacheRead,
							cacheWrite: usage.cacheWrite,
							reasoning: usage.reasoning,
						}
					: undefined,
				costUsd,
				truncated: result.stopReason === "length",
				stopReason: result.stopReason,
			},
		};
	} catch (err) {
		if (signal?.aborted) {
			return errorResult("consult: aborted.", { model: model.id, provider: PROVIDER });
		}
		return errorResult(`consult: request failed: ${errMessage(err)}`, { model: model.id, provider: PROVIDER });
	}
}
