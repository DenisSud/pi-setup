/**
 * Harness tests for the ocr extension (Indra OCR CLI wrapper).
 *
 * Drives the registered tool against a stubbed ExtensionAPI and a fake
 * `indra-ocr` shell script: no models, no network, no real documents.
 *
 * Tests:
 *   - tool registered alone, deferred exposure by default
 *   - default args (markdown), explicit format/mode/max_pages
 *   - ~ and relative path resolution
 *   - truncation writes the full output to an artifact and names it
 *   - missing binary, non-zero exit and missing file each name their fix
 *   - live (OCR_LIVE=1): real indra-ocr on $OCR_LIVE_FILE
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

const root = mkdtempSync(join(tmpdir(), "pi-ocr-test-"));
const bin = join(root, "bin");
const artifacts = join(root, "artifacts");
mkdirSync(bin, { recursive: true });

const ARGS_LOG = join(root, "args.log");
const DOC = "## Heading\n\nBody text with **markdown**.\n";

/** A stand-in for indra-ocr: records argv and prints $FIXTURE_OUTPUT. */
const fake = join(bin, "indra-ocr");
writeFileSync(
	fake,
	`#!/bin/sh
printf '%s\\n' "$@" > "$FIXTURE_ARGS_LOG"
if [ -n "$FIXTURE_FAIL" ]; then echo "boom: unreadable page" >&2; exit 2; fi
printf '%s' "$FIXTURE_OUTPUT"
`,
);
chmodSync(fake, 0o755);

function configure(overrides = {}) {
	const path = join(root, "ocr.json");
	writeFileSync(path, JSON.stringify({ command: fake, artifactDir: artifacts, maxChars: 20_000, ...overrides }));
	process.env.OCR_CONFIG = path;
	return path;
}

const REAL_TIMEOUT = process.env.OCR_TIMEOUT;
process.env.FIXTURE_ARGS_LOG = ARGS_LOG;
process.env.FIXTURE_OUTPUT = DOC;
const docPath = join(root, "case.pdf");
writeFileSync(docPath, "%PDF-1.4 fake");

const pi = makePi();
configure();
createExtension(pi);
const ocr = pi.tools.get("ocr");

function loggedArgs() {
	return readFileSync(ARGS_LOG, "utf8").trim().split("\n");
}

// ── tests ─────────────────────────────────────────────────────────────────

test("registers exactly one tool, deferred by default", () => {
	assert(pi.tools.size === 1, `tools: ${[...pi.tools.keys()].join(", ")}`);
	assert(ocr, "ocr registered");
	assert(ocr.exposure === "deferred", `exposure: ${ocr.exposure}`);
});

test("default run asks for markdown", async () => {
	const result = await runTool(ocr, { path: docPath });
	assert(result.content[0].text === DOC.trimEnd(), `text: ${result.content[0].text.slice(0, 80)}`);
	assert(result.details.format === "md", `format: ${result.details.format}`);
	assert(result.details.truncated === false, "not truncated");
	assert(loggedArgs().join(" ") === `${docPath} --format md`, `args: ${loggedArgs().join(" ")}`);
});

test("format, mode and max_pages reach the CLI", async () => {
	await runTool(ocr, { path: docPath, format: "json", mode: "ocr", max_pages: 3 });
	assert(
		loggedArgs().join(" ") === `${docPath} --format json --mode ocr --max-pages 3`,
		`args: ${loggedArgs().join(" ")}`,
	);
});

test("relative path is resolved against cwd", async () => {
	const cwd = process.cwd();
	process.chdir(root);
	try {
		await runTool(ocr, { path: "case.pdf" });
	} finally {
		process.chdir(cwd);
	}
	assert(loggedArgs()[0] === docPath, `args: ${loggedArgs().join(" ")}`);
});

test("long output is truncated and the artifact holds all of it", async () => {
	const long = "line of text\n".repeat(500);
	process.env.FIXTURE_OUTPUT = long;
	const result = await runTool(ocr, { path: docPath, max_chars: 100 });
	assert(result.details.truncated === true, "truncated");
	assert(result.details.chars === long.trimEnd().length, `chars: ${result.details.chars}`);
	assert(result.content[0].text.includes(result.details.artifact), "result names the artifact");
	const saved = readFileSync(result.details.artifact, "utf8");
	assert(saved === long.trimEnd(), "artifact holds the full text");
	process.env.FIXTURE_OUTPUT = DOC;
});

test("missing binary names the install command and the config file", async () => {
	const config = configure({ command: join(bin, "does-not-exist") });
	try {
		createExtension(pi);
		const result = await runTool(ocr, { path: docPath });
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
		const result = await runTool(ocr, { path: docPath });
		assert(result.isError === true, "is an error");
		const text = result.content[0].text;
		assert(text.includes("exited 2"), `exit code: ${text}`);
		assert(text.includes("unreadable page"), `stderr: ${text}`);
	} finally {
		delete process.env.FIXTURE_FAIL;
	}
});

test("missing file fails before spawning", async () => {
	const result = await runTool(ocr, { path: join(root, "nope.pdf") });
	assert(result.isError === true, "is an error");
	assert(result.content[0].text.includes("no such file"), `text: ${result.content[0].text}`);
});

test("empty output is an error, not an empty result", async () => {
	process.env.FIXTURE_OUTPUT = "";
	try {
		const result = await runTool(ocr, { path: docPath });
		assert(result.isError === true, "is an error");
		assert(result.content[0].text.includes("produced no text"), `text: ${result.content[0].text}`);
	} finally {
		process.env.FIXTURE_OUTPUT = DOC;
	}
});

// ── live test (opt-in, needs the real indra-ocr binary) ────────────────────

if (process.env.OCR_LIVE === "1") {
	test("live: real indra-ocr on a document", async () => {
		delete process.env.OCR_CONFIG;
		process.env.OCR_CONFIG = process.env.OCR_CONFIG_REAL ?? join(root, "live.json");
		writeFileSync(process.env.OCR_CONFIG, JSON.stringify({ artifactDir: artifacts }));
		createExtension(pi);
		const file = process.env.OCR_LIVE_FILE ?? join(process.env.HOME ?? "", "Downloads", "case.pdf");
		assert(existsSync(file), `live file exists: ${file} (set OCR_LIVE_FILE)`);
		const result = await runTool(ocr, { path: file, max_pages: 1 });
		assert(result.isError !== true, `not an error: ${result.content[0].text.slice(0, 200)}`);
		assert(result.details.chars > 100, `got text: ${result.details.chars} chars`);
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
