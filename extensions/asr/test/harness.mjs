/**
 * Harness tests for the asr extension (pi-asr / Parakeet TDT 0.6B v3 wrapper).
 *
 * Drives the registered tool against a stubbed ExtensionAPI and a fake
 * `pi-asr` shell script: no model, no audio decoding, no network.
 *
 * Tests:
 *   - tool registered alone, deferred exposure by default
 *   - plain run passes the path and the chunk size
 *   - timestamps: JSON mode is parsed into utterances and duration
 *   - ~ and relative path resolution
 *   - truncation writes the full transcript to an artifact and names it
 *   - missing binary, non-zero exit, missing file and bad JSON name their fix
 *   - live (ASR_LIVE=1): real pi-asr on $ASR_LIVE_FILE
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

function makePi() {
	const tools = new Map();
	return {
		registerTool: (def) => tools.set(def.name, def),
		registerProvider: () => {},
		on: () => {},
		tools,
	};
}

async function runTool(tool, params, { signal } = {}) {
	let result;
	try {
		result = await tool.execute("call-1", params, signal, undefined, undefined);
	} catch (err) {
		return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], details: {}, isError: true };
	}
	if ("isError" in result) throw new Error("execute returned `isError` — pi ignores that field; throw instead");
	return result;
}

// ── fixtures ──────────────────────────────────────────────────────────────

const root = mkdtempSync(join(tmpdir(), "pi-asr-test-"));
const bin = join(root, "bin");
const artifacts = join(root, "artifacts");
mkdirSync(bin, { recursive: true });

const ARGS_LOG = join(root, "args.log");
const PLAIN = "Привет, это проверка связи.\nOkay, we can start.\n";
const SEGMENTS = {
	path: "fixture.mp3",
	duration: 41.5,
	text: "Привет, это проверка связи. Okay, we can start.",
	segments: [
		{ start: 0.4, end: 3.1, text: "Привет, это проверка связи." },
		{ start: 4.2, end: 6.0, text: "Okay, we can start." },
	],
};

/** A stand-in for pi-asr: records argv and prints $FIXTURE_OUTPUT. */
const fake = join(bin, "pi-asr");
writeFileSync(
	fake,
	`#!/bin/sh
printf '%s\\n' "$@" > "$FIXTURE_ARGS_LOG"
if [ -n "$FIXTURE_FAIL" ]; then echo "boom: unreadable stream" >&2; exit 2; fi
printf '%s' "$FIXTURE_OUTPUT"
`,
);
chmodSync(fake, 0o755);

function configure(overrides = {}) {
	const path = join(root, "asr.json");
	writeFileSync(path, JSON.stringify({ command: fake, artifactDir: artifacts, maxChars: 40_000, ...overrides }));
	process.env.ASR_CONFIG = path;
	return path;
}

process.env.FIXTURE_ARGS_LOG = ARGS_LOG;
process.env.FIXTURE_OUTPUT = PLAIN;
const audioPath = join(root, "voice-note.mp3");
writeFileSync(audioPath, "not really an mp3");

const pi = makePi();
configure();
createExtension(pi);
const transcribe = pi.tools.get("transcribe");

function loggedArgs() {
	return readFileSync(ARGS_LOG, "utf8").trim().split("\n");
}

// ── tests ─────────────────────────────────────────────────────────────────

test("registers exactly one tool, deferred by default", () => {
	assert(pi.tools.size === 1, `tools: ${[...pi.tools.keys()].join(", ")}`);
	assert(transcribe, "transcribe registered");
	assert(transcribe.exposure === "deferred", `exposure: ${transcribe.exposure}`);
});

test("plain run passes the path and the default chunk size", async () => {
	const result = await runTool(transcribe, { path: audioPath });
	assert(result.content[0].text === PLAIN.trimEnd(), `text: ${result.content[0].text.slice(0, 80)}`);
	assert(result.details.truncated === false, "not truncated");
	assert(loggedArgs().join(" ") === `${audioPath} --chunk-seconds 30`, `args: ${loggedArgs().join(" ")}`);
});

test("chunkSeconds from the config reaches the CLI", async () => {
	configure({ chunkSeconds: 12 });
	createExtension(pi);
	try {
		await runTool(pi.tools.get("transcribe"), { path: audioPath });
		assert(loggedArgs().join(" ") === `${audioPath} --chunk-seconds 12`, `args: ${loggedArgs().join(" ")}`);
	} finally {
		configure();
		createExtension(pi);
	}
});

test("timestamps asks for JSON and keeps the utterances", async () => {
	process.env.FIXTURE_OUTPUT = JSON.stringify(SEGMENTS);
	try {
		const result = await runTool(transcribe, { path: audioPath, timestamps: true });
		assert(loggedArgs()[1] === "--json", `args: ${loggedArgs().join(" ")}`);
		const body = JSON.parse(result.content[0].text);
		assert(body.segments.length === 2, `segments: ${body.segments.length}`);
		assert(body.text === SEGMENTS.text, `text: ${body.text}`);
		assert(result.details.segments === 2, `details.segments: ${result.details.segments}`);
		assert(result.details.duration === 41.5, `details.duration: ${result.details.duration}`);
	} finally {
		process.env.FIXTURE_OUTPUT = PLAIN;
	}
});

test("relative path is resolved against cwd", async () => {
	const cwd = process.cwd();
	process.chdir(root);
	try {
		await runTool(transcribe, { path: "voice-note.mp3" });
	} finally {
		process.chdir(cwd);
	}
	assert(loggedArgs()[0] === audioPath, `args: ${loggedArgs().join(" ")}`);
});

test("long transcript is truncated and the artifact holds all of it", async () => {
	const long = "utterance of speech\n".repeat(500);
	process.env.FIXTURE_OUTPUT = long;
	try {
		const result = await runTool(transcribe, { path: audioPath, max_chars: 100 });
		assert(result.details.truncated === true, "truncated");
		assert(result.details.chars === long.trimEnd().length, `chars: ${result.details.chars}`);
		assert(result.content[0].text.includes(result.details.artifact), "result names the artifact");
		const saved = readFileSync(result.details.artifact, "utf8");
		assert(saved === long.trimEnd(), "artifact holds the full transcript");
	} finally {
		process.env.FIXTURE_OUTPUT = PLAIN;
	}
});

test("missing binary names the install command and the config file", async () => {
	const config = configure({ command: join(bin, "does-not-exist") });
	try {
		createExtension(pi);
		const result = await runTool(pi.tools.get("transcribe"), { path: audioPath });
		assert(result.isError === true, "is an error");
		const text = result.content[0].text;
		assert(text.includes("nix profile install"), `names nix install: ${text}`);
		assert(text.includes(config), `names the config path: ${text}`);
	} finally {
		configure();
		createExtension(pi);
	}
});

test("non-zero exit reports the exit code and stderr", async () => {
	process.env.FIXTURE_FAIL = "1";
	try {
		const result = await runTool(transcribe, { path: audioPath });
		assert(result.isError === true, "is an error");
		const text = result.content[0].text;
		assert(text.includes("exited 2"), `exit code: ${text}`);
		assert(text.includes("unreadable stream"), `stderr: ${text}`);
	} finally {
		delete process.env.FIXTURE_FAIL;
	}
});

test("missing file fails before spawning", async () => {
	const result = await runTool(transcribe, { path: join(root, "nope.mp3") });
	assert(result.isError === true, "is an error");
	assert(result.content[0].text.includes("no such file"), `text: ${result.content[0].text}`);
});

test("empty output is an error, not an empty transcript", async () => {
	process.env.FIXTURE_OUTPUT = "";
	try {
		const result = await runTool(transcribe, { path: audioPath });
		assert(result.isError === true, "is an error");
		assert(result.content[0].text.includes("no speech"), `text: ${result.content[0].text}`);
	} finally {
		process.env.FIXTURE_OUTPUT = PLAIN;
	}
});

test("non-JSON output with timestamps names the command setting", async () => {
	process.env.FIXTURE_OUTPUT = "pi-asr: something else entirely";
	try {
		const result = await runTool(transcribe, { path: audioPath, timestamps: true });
		assert(result.isError === true, "is an error");
		assert(result.content[0].text.includes('"command"'), `text: ${result.content[0].text}`);
	} finally {
		process.env.FIXTURE_OUTPUT = PLAIN;
	}
});

// ── live test (opt-in, needs the real pi-asr binary) ───────────────────────

if (process.env.ASR_LIVE === "1") {
	test("live: real pi-asr on an audio file", async () => {
		delete process.env.ASR_CONFIG;
		process.env.ASR_CONFIG = join(root, "live.json");
		writeFileSync(process.env.ASR_CONFIG, JSON.stringify({ artifactDir: artifacts }));
		createExtension(pi);
		const file = process.env.ASR_LIVE_FILE ?? "";
		assert(file && existsSync(file), `live file exists: ${file} (set ASR_LIVE_FILE)`);
		const result = await runTool(pi.tools.get("transcribe"), { path: file });
		assert(result.isError !== true, `not an error: ${result.content[0].text.slice(0, 200)}`);
		assert(result.details.chars > 20, `got text: ${result.details.chars} chars`);
		console.log(`        transcript: ${result.content[0].text.replace(/\n/g, " ").slice(0, 160)}`);
	});

	test("live: timestamps mode returns utterances with times", async () => {
		const file = process.env.ASR_LIVE_FILE ?? "";
		const result = await runTool(pi.tools.get("transcribe"), { path: file, timestamps: true });
		assert(result.isError !== true, `not an error: ${result.content[0].text.slice(0, 200)}`);
		const body = JSON.parse(result.content[0].text);
		assert(body.segments.length > 0, "at least one utterance");
		assert(typeof body.segments[0].start === "number", `start: ${body.segments[0].start}`);
		assert(body.duration > 0, `duration: ${body.duration}`);
	});
}

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
console.log(`\n${passed}/${tests.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
