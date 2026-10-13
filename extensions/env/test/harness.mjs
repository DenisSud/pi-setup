/**
 * Harness tests for the env extension (env.json → process.env).
 *
 * Drives the factory against a stubbed ExtensionAPI and temp files. The
 * extension reads the path at load time, so each test points PI_ENV_CONFIG at
 * its own file and calls the factory again. No network, no real secrets.
 *
 * Tests:
 *   - scalars are applied; numbers and booleans are coerced
 *   - ${VAR} and ${VAR:-fallback} interpolation
 *   - invalid names / non-scalars / empty values are skipped with a warning
 *   - malformed JSON is reported and sets nothing
 *   - a missing file warns (fleet deployments carry the values in the env)
 *   - a group/world-readable file warns
 *   - /env lists names, never values
 *
 * Run: ./test/run.sh harness
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import createExtension from "../index.ts";

const TMP = mkdtempSync(join(tmpdir(), "env-harness-"));
const SAVED_PATH = process.env.PI_ENV_CONFIG;
/** Variables the tests set in the ambient environment; restored at the end. */
const TOUCHED = new Set(["HARNESS_AMBIENT", "HARNESS_FALLBACK", "HARNESS_ONE", "HARNESS_NUMBER"]);

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

function assertEqual(actual, expected, msg) {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a !== b) throw new Error(`${msg || "not equal"}: ${a} !== ${b}`);
}

function makePi() {
	const commands = new Map();
	const handlers = new Map();
	return {
		registerCommand: (name, def) => commands.set(name, def),
		on: (event, fn) => {
			const list = handlers.get(event) ?? [];
			list.push(fn);
			handlers.set(event, list);
		},
		commands,
		handlers,
	};
}

function makeCtx(hasUI = true) {
	const notifications = [];
	const ctx = {
		hasUI,
		cwd: TMP,
		ui: { notify: (text, level) => notifications.push({ text, level }), theme: { fg: (_color, text) => text } },
	};
	return { ctx, notifications };
}

/** Write a config file, point PI_ENV_CONFIG at it and load the extension. */
function load(content, { mode = 0o600, file = "env.json" } = {}) {
	const path = join(TMP, file);
	writeFileSync(path, content, { mode });
	chmodSync(path, mode);
	process.env.PI_ENV_CONFIG = path;
	const pi = makePi();
	createExtension(pi);
	return pi;
}

function notifyOnce(pi) {
	const { ctx, notifications } = makeCtx();
	for (const fn of pi.handlers.get("session_start") ?? []) fn({}, ctx);
	return notifications;
}

// ── tests ─────────────────────────────────────────────────────────────────

test("applies string, number and boolean values", () => {
	const pi = load(
		JSON.stringify({
			HARNESS_ONE: "value",
			HARNESS_NUMBER: 8080,
			HARNESS_BOOL: true,
			HARNESS_EMPTY_STRING: "",
			"bad-name": "nope",
			HARNESS_OBJECT: { nested: true },
		}),
	);
	assertEqual(process.env.HARNESS_ONE, "value");
	assertEqual(process.env.HARNESS_NUMBER, "8080", "number coerced");
	assertEqual(process.env.HARNESS_BOOL, "true", "boolean coerced");
	assertEqual(process.env.HARNESS_EMPTY_STRING, undefined, "empty value skipped");
	assertEqual(process.env["bad-name"], undefined, "invalid name skipped");
	assertEqual(process.env.HARNESS_OBJECT, undefined, "non-scalar skipped");

	const warnings = notifyOnce(pi);
	assertEqual(warnings.length, 1, "one warning for the skipped keys");
	assert(warnings[0].text.includes("HARNESS_EMPTY_STRING"), warnings[0].text);
	assert(warnings[0].text.includes('"bad-name"'), warnings[0].text);
	assert(warnings[0].text.includes("HARNESS_OBJECT"), warnings[0].text);
});

test("interpolates ${VAR} and ${VAR:-fallback}", () => {
	process.env.HARNESS_AMBIENT = "ambient-value";
	const pi = load(
		JSON.stringify({
			HARNESS_ONE: "${HARNESS_AMBIENT}",
			HARNESS_TWO: "${HARNESS_AMBIENT}-suffix",
			HARNESS_THREE: "${HARNESS_MISSING:-fallback}",
			HARNESS_FOUR: "${HARNESS_MISSING_ENTIRELY}",
		}),
	);
	assertEqual(process.env.HARNESS_ONE, "ambient-value");
	assertEqual(process.env.HARNESS_TWO, "ambient-value-suffix");
	assertEqual(process.env.HARNESS_THREE, "fallback");
	assertEqual(process.env.HARNESS_FOUR, undefined, "unresolved without fallback is skipped");
	const warnings = notifyOnce(pi);
	assertEqual(warnings[0].text.includes("HARNESS_FOUR"), true, warnings[0].text);
});

test("missing file → warning, nothing set", () => {
	process.env.PI_ENV_CONFIG = join(TMP, "does-not-exist.json");
	const pi = makePi();
	createExtension(pi);
	const notifications = notifyOnce(pi);
	assertEqual(notifications.length, 1);
	assertEqual(notifications[0].level, "warning");
	assert(notifications[0].text.includes("does-not-exist.json"), notifications[0].text);
});

test("malformed JSON → error, nothing set", () => {
	const pi = load("{ not json");
	const notifications = notifyOnce(pi);
	assertEqual(notifications.length, 1);
	assertEqual(notifications[0].level, "error");
	assert(notifications[0].text.includes("invalid JSON"), notifications[0].text);
});

test("array top level → error", () => {
	const pi = load('["nope"]');
	const notifications = notifyOnce(pi);
	assertEqual(notifications[0].level, "error");
	assert(notifications[0].text.includes("JSON object"), notifications[0].text);
});

test("group/world-readable file → permission warning", () => {
	const pi = load(JSON.stringify({ HARNESS_ONE: "value" }), { mode: 0o644 });
	assertEqual(process.env.HARNESS_ONE, "value", "values still apply");
	const notifications = notifyOnce(pi);
	assertEqual(notifications.length, 1, "exactly the permission warning");
	assert(notifications[0].text.includes("chmod 600"), notifications[0].text);
});

test("a healthy file warns about nothing", () => {
	const pi = load(JSON.stringify({ HARNESS_ONE: "value" }));
	assertEqual(notifyOnce(pi).length, 0);
});

test("/env lists names and never values", async () => {
	const pi = load(JSON.stringify({ HARNESS_ONE: "super-secret", HARNESS_TWO: "also-secret" }));
	const { ctx, notifications } = makeCtx();
	await pi.commands.get("env").handler("", ctx);
	assertEqual(notifications.length, 1);
	const text = notifications[0].text;
	assert(text.includes("HARNESS_ONE") && text.includes("HARNESS_TWO"), text);
	assert(!text.includes("super-secret") && !text.includes("also-secret"), `leaked a value: ${text}`);
});

test("no UI → no notifications, values still applied", () => {
	const pi = load(JSON.stringify({ HARNESS_ONE: "value" }));
	const { ctx, notifications } = makeCtx(false);
	for (const fn of pi.handlers.get("session_start") ?? []) fn({}, ctx);
	assertEqual(notifications.length, 0);
	assertEqual(process.env.HARNESS_ONE, "value");
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

for (const name of TOUCHED) delete process.env[name];
delete process.env.HARNESS_BOOL;
delete process.env.HARNESS_TWO;
delete process.env.HARNESS_THREE;
delete process.env.HARNESS_FOUR;
delete process.env.HARNESS_EMPTY_STRING;
delete process.env.HARNESS_OBJECT;
if (SAVED_PATH === undefined) delete process.env.PI_ENV_CONFIG;
else process.env.PI_ENV_CONFIG = SAVED_PATH;
rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed}/${tests.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
