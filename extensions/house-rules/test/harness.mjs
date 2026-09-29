/**
 * Harness tests for the house-rules extension.
 *
 * Drives the registered hooks against a stubbed ExtensionAPI: the rules file is
 * read on session_start and appended on before_agent_start, and an unreadable
 * file is reported instead of silently dropping the rules.
 *
 * Run: ./test/run.sh harness   (no network)
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import createExtension from "../index.ts";

// ── tiny test runner ──────────────────────────────────────────────────────

const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
	tests.push({ name, fn });
}

function assert(cond, msg) {
	if (!cond) throw new Error(msg || "assertion failed");
}

/** Capture the hooks the extension registers. */
function loadExtension() {
	const hooks = { session_start: [], before_agent_start: [] };
	const pi = {
		on(event, handler) {
			hooks[event] ??= [];
			hooks[event].push(handler);
		},
	};
	createExtension(pi);
	return hooks;
}

function fakeContext() {
	const notifications = [];
	return {
		notifications,
		hasUI: true,
		ui: { notify: (message, level) => notifications.push({ message, level }) },
	};
}

const REAL_RULES = process.env.PI_HOUSE_RULES;
const tmp = mkdtempSync(join(tmpdir(), "house-rules-test-"));

function withRulesFile(content) {
	const file = join(tmp, "RULES.md");
	writeFileSync(file, content, "utf8");
	process.env.PI_HOUSE_RULES = file;
	return file;
}

async function appendPrompt(hooks) {
	const ctx = fakeContext();
	for (const h of hooks.session_start) await h({}, ctx);
	let prompt = "BASE";
	for (const h of hooks.before_agent_start) {
		const result = await h({ systemPrompt: prompt });
		if (result?.systemPrompt) prompt = result.systemPrompt;
	}
	return { prompt, ctx };
}

// ── tests ─────────────────────────────────────────────────────────────────

test("appends the rules file to the system prompt", async () => {
	withRulesFile("# Rules\n\n- never print secrets\n");
	const { prompt } = await appendPrompt(loadExtension());
	assert(prompt.startsWith("BASE"), `keeps the base prompt: ${prompt.slice(0, 40)}`);
	assert(prompt.includes("## House rules"), "adds a House rules heading");
	assert(prompt.includes("never print secrets"), "includes the file content");
});

test("real rules file (the repo's global/AGENTS.md) is readable", async () => {
	delete process.env.PI_HOUSE_RULES;
	const { prompt, ctx } = await appendPrompt(loadExtension());
	assert(prompt.includes("## House rules"), "adds the heading");
	assert(prompt.includes("Bitwarden"), "contains the secrets section");
	assert(ctx.notifications.length === 0, "no warning for a readable file");
});

test("missing file: no append, one UI notification", async () => {
	process.env.PI_HOUSE_RULES = join(tmp, "does-not-exist.md");
	const { prompt, ctx } = await appendPrompt(loadExtension());
	assert(prompt === "BASE", `prompt untouched: ${prompt}`);
	assert(ctx.notifications.length === 1, `one notification: ${ctx.notifications.length}`);
	assert(ctx.notifications[0].level === "error", "reported as an error");
	assert(ctx.notifications[0].message.includes("without the base rules"), ctx.notifications[0].message);
});

test("empty file counts as missing", async () => {
	withRulesFile("   \n");
	const { prompt, ctx } = await appendPrompt(loadExtension());
	assert(prompt === "BASE", "no empty House rules block");
	assert(ctx.notifications.length === 1, "warned once");
});

test("rules are re-read on each session_start", async () => {
	const hooks = loadExtension();
	withRulesFile("first version");
	const first = await appendPrompt(hooks);
	assert(first.prompt.includes("first version"), "first read");
	withRulesFile("second version");
	const second = await appendPrompt(hooks);
	assert(second.prompt.includes("second version"), "picks up edits");
	assert(!second.prompt.includes("first version"), "no stale copy");
});

// ── run ───────────────────────────────────────────────────────────────────

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

rmSync(tmp, { recursive: true, force: true });
if (REAL_RULES === undefined) delete process.env.PI_HOUSE_RULES;
else process.env.PI_HOUSE_RULES = REAL_RULES;

console.log(`\n${passed}/${tests.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
