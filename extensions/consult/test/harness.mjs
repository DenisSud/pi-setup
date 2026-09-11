/**
 * Harness tests for the consult extension.
 *
 * Drives the extension's registered tool directly with a stubbed
 * ExtensionAPI + modelRegistry. Streaming goes through pi-ai's REAL
 * openai-completions implementation (EventStream, SSE parsing, usage
 * accounting): the consult extension streams via pi-ai's compat entrypoint
 * (the ``streamSimple`` global the extension loader maps the pi-ai root
 * import to), which dispatches by model.api through the api registry. Fake
 * tests install a fake api provider for "openai-completions" into that
 * registry, so everything except credential storage is the real request
 * path; the live test leaves the registry untouched (builtin provider).
 *
 * Tests:
 *   - provider missing          → clean error
 *   - model not found           → error listing available models
 *   - no auth                   → clean error
 *   - fake stream (no network)  → answer + reasoning + usage + cost composed
 *   - fake stream provider error → isError result with errorMessage
 *   - fake stream aborted       → "aborted" result
 *   - live (CONSULT_LIVE=1, CONSULT_KEY=sk-...): real glm-5.3 call, ~$0.01
 *
 * Run: node test/harness.mjs   (Node >= 23.6, native TS type stripping)
 * Requires node_modules symlinks set up by run.sh.
 */

import createExtension from "../index.ts";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getApiProvider, registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";

// ── tiny test runner ──────────────────────────────────────────────────────

const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
	tests.push({ name, fn });
}

async function runTests() {
	for (const t of tests) {
		try {
			await t.fn();
			passed++;
			console.log(`  ok    ${t.name}`);
		} catch (err) {
			failed++;
			console.error(`  FAIL  ${t.name}`);
			console.error(`        ${String(err.message).split("\n").slice(0, 8).join("\n        ")}`);
		}
	}
	console.log(`\n${passed}/${tests.length} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
}

function assert(cond, msg) {
	if (!cond) throw new Error(msg || "assertion failed");
}

// ── fixtures ──────────────────────────────────────────────────────────────

const DEEPSEEK_V4_PRO = {
	id: "kimi-k3",
	name: "DeepSeek V4 Pro",
	api: "openai-completions",
	provider: "opencode-go",
	baseUrl: "https://opencode.ai/zen/go/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
	contextWindow: 1000000,
	maxTokens: 131072,
};

function makeRegistry({ provider, model = DEEPSEEK_V4_PRO, listed, auth = { ok: true, apiKey: "sk-test-key" } }) {
	return {
		getAll: () => (provider ? (listed ?? (model ? [model] : [DEEPSEEK_V4_PRO])) : []),
		find: () => model,
		getApiKeyAndHeaders: async () => auth,
	};
}
function fakeProvider(streamFactory) {
	return {
		streamSimple: (model, context, options) => streamFactory(model, context, options),
	};
}

// The extension streams via pi-ai compat's api registry, dispatching on
// model.api. Fake tests register a fake "openai-completions" provider there
// (replacing the builtin registration), which is exactly the hook the
// extension loader exposes to extensions. unregisterApiProviders() removes
// the entry outright and compat only (re)registers builtins at module load,
// so uninstalling must restore the captured pre-install provider object
// (same identity ⇒ the builtin-vs-fake check in compat's dispatch still
// works).
const FAKE_SOURCE = "consult-test-fake";
let savedApiProvider;
function installFakeApi(streamFactory) {
	savedApiProvider = getApiProvider("openai-completions");
	registerApiProvider(
		{
			api: "openai-completions",
			stream: () => {
				throw new Error("stream() not used by consult");
			},
			streamSimple: streamFactory,
		},
		FAKE_SOURCE,
	);
}
function uninstallFakeApi() {
	unregisterApiProviders(FAKE_SOURCE);
	if (savedApiProvider !== undefined) registerApiProvider(savedApiProvider);
}

function makePi() {
	const tools = new Map();
	return {
		registerTool: (def) => tools.set(def.name, def),
		on: () => {},
		tools,
	};
}

const pi = makePi();
createExtension(pi);
const tool = pi.tools.get("consult");
assert(tool, "consult tool registered");

async function runTool(params, { registry, signal, onUpdate } = {}) {
	const ctx = { modelRegistry: registry ?? makeRegistry({ provider: fakeProvider(() => {}) }), cwd: "/tmp" };
	return tool.execute("call-1", params, signal, onUpdate, ctx);
}

// ── tests ─────────────────────────────────────────────────────────────────

test("provider missing → clean error", async () => {
	const result = await runTool({ proposal: "x" }, { registry: makeRegistry({ provider: undefined }) });
	assert(result.isError === true, "isError");
	assert(/not registered/.test(result.content[0].text), `message: ${result.content[0].text}`);
});

test("model not found → error lists available models", async () => {
	const registry = makeRegistry({ provider: fakeProvider(() => {}), model: null });
	const result = await runTool({ proposal: "x", model: "nonexistent-model" }, { registry });
	assert(result.isError === true, "isError");
	assert(/nonexistent-model/.test(result.content[0].text), "names the requested model");
	assert(/kimi-k3/.test(result.content[0].text), "lists available models");
});

test("no auth → clean error", async () => {
	const result = await runTool(
		{ proposal: "x" },
		{
			registry: makeRegistry({
				provider: fakeProvider(() => {}),
				auth: { ok: false, error: 'No API key found for "opencode-go"' },
			}),
		},
	);
	assert(result.isError === true, "isError");
	assert(/API key/.test(result.content[0].text), `message: ${result.content[0].text}`);
});

test("fake stream → answer, reasoning, usage, cost composed; static system prompt; focus in user message", async () => {
	const partial = { role: "assistant", content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const finalMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "The proposal couples X and Y; consider decoupling." },
			{ type: "text", text: "## Verdict\nWorkable with changes.\n\n## Key concerns\n..." },
		],
		api: "openai-completions",
		provider: "opencode-go",
		model: "kimi-k3",
		usage: { input: 1200, output: 800, cacheRead: 500, cacheWrite: 0, reasoning: 500 },
		stopReason: "stop",
		timestamp: Date.now(),
	};
	let captured;
	installFakeApi((model, context, options) => {
		captured = { systemPrompt: context.systemPrompt, userText: context.messages[0].content[0].text, options };
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial });
			stream.push({ type: "thinking_delta", contentIndex: 0, delta: "The proposal couples ", partial });
			stream.push({ type: "text_delta", contentIndex: 1, delta: "## Verdict\nWorkable ", partial });
			stream.push({ type: "text_delta", contentIndex: 1, delta: "with changes.\n\n## Key concerns\n...", partial });
			stream.push({ type: "done", reason: "stop", message: finalMessage });
			stream.end();
		});
		return stream;
	});

	try {
		const updates = [];
		const result = await runTool(
			{ proposal: "P", context: "C", question: "Q?", focus: "risks", reasoning: "max" },
			{ registry: makeRegistry({ provider: fakeProvider(() => {}) }), onUpdate: (u) => updates.push(u.content[0].text) },
		);

		assert(result.isError !== true, "not an error");
		assert(result.content[0].text === "## Verdict\nWorkable with changes.\n\n## Key concerns\n...", "answer text");
		assert(result.details.reasoning.includes("decoupling"), "reasoning trace present");
		assert(result.details.usage.input === 1200 && result.details.usage.reasoning === 500, "usage");
		assert(result.details.usage.cacheRead === 500, "cacheRead usage recorded");
		const expectedCost = (1200 * 0.435 + 800 * 0.87 + 500 * 0.003625) / 1e6;
		assert(Math.abs(result.details.costUsd - expectedCost) < 1e-9, `cost ${result.details.costUsd}`);
		assert(result.details.focus === "risks", "focus recorded");
		assert(updates.length >= 2, `progress updates streamed (${updates.length})`);

		// system prompt must be fully static (prefix-cache friendly): verdict line, caps, no focus interpolation
		assert(captured.systemPrompt.includes("VERDICT: sound | workable | wrong"), "parseable verdict line");
		assert(captured.systemPrompt.includes("under 600 words"), "verbosity cap");
		assert(captured.systemPrompt.includes("manufacture criticism"), "confidence gating");
		assert(!captured.systemPrompt.includes("## Focus"), "system prompt has no per-call focus");
		// focus instruction lives in the user message instead
		assert(captured.userText.includes("## Focus") && captured.userText.includes("Focus: risks"), "focus in user message");
		assert(captured.userText.includes("## Proposal") && captured.userText.includes("## Question"), "proposal/question present");
		assert(captured.options.maxTokens === undefined, `no output cap set, got ${captured.options.maxTokens}`);
	} finally {
		uninstallFakeApi();
	}
});

test("fake stream provider error → isError with errorMessage", async () => {
	installFakeApi(() => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const failed = {
				role: "assistant",
				content: [],
				api: "openai-completions",
				provider: "opencode-go",
				model: "kimi-k3",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "error",
				errorMessage: "Provider returned an error stop reason",
				timestamp: Date.now(),
			};
			stream.push({ type: "error", reason: "error", error: failed });
			stream.end();
		});
		return stream;
	});
	try {
		const result = await runTool({ proposal: "P" }, { registry: makeRegistry({ provider: fakeProvider(() => {}) }) });
		assert(result.isError === true, "isError");
		assert(/error stop reason/.test(result.content[0].text), `message: ${result.content[0].text}`);
	} finally {
		uninstallFakeApi();
	}
});

test("fake stream aborted → aborted result", async () => {
	const controller = new AbortController();
	installFakeApi(() => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const failed = {
				role: "assistant",
				content: [],
				api: "openai-completions",
				provider: "opencode-go",
				model: "kimi-k3",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "aborted",
				timestamp: Date.now(),
			};
			stream.push({ type: "error", reason: "aborted", error: failed });
			stream.end();
		});
		return stream;
	});
	controller.abort();
	try {
		const result = await runTool(
			{ proposal: "P" },
			{ registry: makeRegistry({ provider: fakeProvider(() => {}) }), signal: controller.signal },
		);
		assert(result.isError === true, "isError");
		assert(/aborted/.test(result.content[0].text), `message: ${result.content[0].text}`);
	} finally {
		uninstallFakeApi();
	}
});

test("live glm-5.3 consult (opt-in)", async () => {
	if (!process.env.CONSULT_LIVE) {
		console.log("  skip  (set CONSULT_LIVE=1 and CONSULT_KEY to run the live test)");
		return;
	}
	const key = process.env.CONSULT_KEY;
	assert(key, "CONSULT_KEY required for live test");
	const opts = {
		proposal:
			"I plan to train a JEPA world model on 64x64 grid observations with a single shared encoder, no EMA, SIGReg anti-collapse, and an AdaLN-Zero predictor.",
		question: "Is this architecture sound, and what is the biggest risk?",
		reasoning: "low",
	};
	// calls the builtin opencode-go provider via pi-ai compat (real SSE path); no fake registered
	const r1 = await runTool(opts, {
		registry: makeRegistry({ provider: fakeProvider(() => {}), auth: { ok: true, apiKey: key } }),
	});
	assert(r1.isError !== true, `not an error: ${r1.content[0].text}`);
	assert(r1.content[0].text.length > 50, "substantial answer");
	assert(r1.details.usage?.input > 0, "usage present");
	assert(typeof r1.details.costUsd === "number" && r1.details.costUsd > 0, "cost computed");
	console.log(
		`  live #1: $${r1.details.costUsd.toFixed(4)}  in=${r1.details.usage.input}  out=${r1.details.usage.output}  cacheRead=${r1.details.usage.cacheRead}`,
	);
	// call 2: identical static system prompt should hit the prefix cache
	const r2 = await runTool(
		{ ...opts, proposal: opts.proposal + " (second pass, different proposal text)" },
		{ registry: makeRegistry({ provider: fakeProvider(() => {}), auth: { ok: true, apiKey: key } }) },
	);
	assert(r2.isError !== true, `2nd call not an error: ${r2.content[0].text}`);
	console.log(
		`  live #2: $${r2.details.costUsd.toFixed(4)}  in=${r2.details.usage.input}  out=${r2.details.usage.output}  cacheRead=${r2.details.usage.cacheRead}`,
	);
	assert(r2.details.usage.cacheRead > 0, `prefix cache should hit on 2nd call, got cacheRead=${r2.details.usage.cacheRead}`);
	console.log(`        answer head: ${r1.content[0].text.slice(0, 120).replace(/\n/g, " ")}…`);
});

runTests();
