/**
 * Harness tests for the ptc extension.
 *
 * Drives the registered `ptc` tool directly with a stubbed ExtensionAPI,
 * exactly like the consult harness. Real child-process execution, real
 * registry, real built-ins (read/grep/find against temp files) — no network,
 * no model.
 *
 * Tests:
 *   - registry basics            → list/get, idempotent re-register
 *   - registration timing        → description built at session_start lists all tools
 *   - fan-out + Promise.all      → parallel read of two files, aggregated in code
 *   - grep structured + filter   → matches filtered/counted inside the program
 *   - find                       → regex path matching, type filter
 *   - unknown tool               → clean error naming the tool
 *   - tool error propagation     → read ENOENT rejects inside the program
 *   - program error              → isError with the stack, output preserved
 *   - timeout                    → PTC_TIMEOUT_MS honored, isError
 *   - output cap                 → head+tail cap + full output file written
 *   - web_search registration    → present in registry via the web-search extension (no network)
 *
 * Run: node test/harness.mjs   (Node >= 23.6, native TS type stripping)
 * Requires node_modules symlinks set up by run.sh.
 */

import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import createPtc from "../index.ts";
import { listPtcTools, getPtcTool, registerPtcTool } from "../registry.ts";
import createWebSearch from "../../web-search/index.ts";

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

// ── stub ExtensionAPI (mirrors consult harness) ───────────────────────────

function stubPi() {
	const tools = new Map();
	const handlers = {};
	return {
		registerTool(def) {
			tools.set(def.name, def);
		},
		registerProvider() {},
		on(event, fn) {
			handlers[event] = fn;
		},
		tools,
		handlers,
	};
}

/** Load ptc + web-search into one stub pi, fire session_start, return the ptc tool. */
async function setup() {
	const pi = stubPi();
	createWebSearch(pi); // registers web_search/web_fetch direct tools + ptc binding
	createPtc(pi);
	await pi.handlers.session_start({}, {});
	const ptc = pi.tools.get("ptc");
	assert(ptc, "ptc tool registered at session_start");
	return { pi, ptc };
}

/** Execute a program and return the tool result object. */
function runTool(ptc, code, signal) {
	return ptc.execute("test-call-id", { code }, signal, undefined, { modelRegistry: {} });
}

let dir;

// ── tests ─────────────────────────────────────────────────────────────────

test("registry: list/get/idempotent re-register", async () => {
	const before = listPtcTools().length;
	registerPtcTool("__probe", () => 1);
	assert(getPtcTool("__probe"), "probe registered");
	registerPtcTool("__probe", () => 2); // must not throw (reload safety)
	assert(listPtcTools().length === before + 1, "idempotent: no duplicate entry");
});

test("session_start: description lists every registered tool", async () => {
	const { ptc } = await setup();
	const desc = ptc.description;
	for (const name of ["read", "grep", "find", "web_search"]) {
		assert(desc.includes(name), `description mentions ${name}`);
	}
	assert(desc.includes("console.log"), "description states output convention");
	assert(desc.includes("general-purpose"), "description positions ptc as general-purpose JS");
	assert(
		ptc.promptGuidelines.some((g) => g.includes("direct tool calls")),
		"guidelines state when to prefer direct tool calls",
	);
});

test("fan-out: Promise.all reads two files, program aggregates", async () => {
	const { ptc } = await setup();
	const a = join(dir, "a.txt");
	const b = join(dir, "b.txt");
	await writeFile(a, "alpha\nbeta\n");
	await writeFile(b, "gamma\ndelta\n");
	const res = await runTool(
		ptc,
		`const [x, y] = await Promise.all([read({ path: ${JSON.stringify(a)} }), read({ path: ${JSON.stringify(b)} })]);
print(JSON.stringify({ lens: [x.content.length, y.content.length], trunc: x.truncated || y.truncated, lines: x.total_lines + y.total_lines }));`,
	);
	assert(!res.isError, `no error: ${res.content[0].text}`);
	const parsed = JSON.parse(res.content[0].text);
	assert(parsed.lens.join(",") === "11,12", `lengths 11,12 — got ${parsed.lens}`);
	assert(parsed.lines === 4, `4 total lines — got ${parsed.lines}`);
});

test("grep: structured matches, filtered in code", async () => {
	const { ptc } = await setup();
	await writeFile(join(dir, "log1.txt"), "INFO ok\nERROR bad1\nINFO fine\nERROR bad2\n");
	await writeFile(join(dir, "log2.txt"), "ERROR bad3\n");
	const res = await runTool(
		ptc,
		`const g = await grep({ pattern: "ERROR", path: ${JSON.stringify(dir)} });
print(JSON.stringify({ total: g.total_matches, errors: g.matches.map(m => m.text.split(" ")[1]) }));`,
	);
	assert(!res.isError, `no error: ${res.content[0].text}`);
	const parsed = JSON.parse(res.content[0].text);
	assert(parsed.total === 3, `3 matches — got ${parsed.total}`);
	assert(JSON.stringify(parsed.errors) === JSON.stringify(["bad1", "bad2", "bad3"]), `texts — got ${JSON.stringify(parsed.errors)}`);
});

test("find: regex on relative paths, type filter", async () => {
	const { ptc } = await setup();
	await mkdir(join(dir, "sub"), { recursive: true });
	await writeFile(join(dir, "sub", "x.py"), "print(1)\n");
	await writeFile(join(dir, "x.py"), "print(2)\n");
	const res = await runTool(
		ptc,
		`const f = await find({ pattern: String.raw\`\.py$\`, path: ${JSON.stringify(dir)} });
const d = await find({ pattern: "sub", path: ${JSON.stringify(dir)}, type: "dir" });
print(JSON.stringify({ files: f.paths.sort(), dirs: d.paths }));`,
	);
	assert(!res.isError, `no error: ${res.content[0].text}`);
	const parsed = JSON.parse(res.content[0].text);
	assert(JSON.stringify(parsed.files) === JSON.stringify(["sub/x.py", "x.py"]), `files — got ${JSON.stringify(parsed.files)}`);
	assert(JSON.stringify(parsed.dirs) === JSON.stringify(["sub"]), `dirs — got ${JSON.stringify(parsed.dirs)}`);
});

test("unknown tool: clean error naming the tool", async () => {
	const { ptc } = await setup();
	const res = await runTool(ptc, `await definitely_not_registered({});`);
	assert(res.isError, "isError");
	assert(res.content[0].text.includes("definitely_not_registered"), `names the tool — got ${res.content[0].text}`);
});

test("tool error propagation: read ENOENT rejects inside the program", async () => {
	const { ptc } = await setup();
	const res = await runTool(
		ptc,
		`try { await read({ path: "/nonexistent/ptc-test-file" }); print("no error"); }
catch (e) { print("caught: " + e.message.slice(0, 30)); }`,
	);
	assert(!res.isError, `program handled it — got ${res.content[0].text}`);
	assert(res.content[0].text.includes("caught: read: no such file"), `error text — got ${res.content[0].text}`);
});

test("program error: isError with stack in the message", async () => {
	const { ptc } = await setup();
	const res = await runTool(ptc, `print("before"); throw new Error("boom");`);
	assert(res.isError, "isError");
	assert(res.content[0].text.includes("before"), "stdout preserved before the error");
	assert(res.content[0].text.includes("boom"), "error message present");
});

test("timeout: PTC_TIMEOUT_MS honored", async () => {
	const { ptc } = await setup();
	process.env.PTC_TIMEOUT_MS = "300";
	try {
		const res = await runTool(ptc, `await new Promise(() => {});`);
		assert(res.isError, "isError");
		assert(res.content[0].text.includes("timed out"), `timeout message — got ${res.content[0].text}`);
	} finally {
		delete process.env.PTC_TIMEOUT_MS;
	}
});

test("output cap: head+tail with full output file", async () => {
	const { ptc } = await setup();
	const res = await runTool(ptc, `print("x".repeat(100000)); print("THE_TAIL_MARKER");`);
	assert(!res.isError, `no error: ${res.content[0].text.slice(0, 200)}`);
	const text = res.content[0].text;
	assert(text.includes("chars dropped"), "cap marker present");
	assert(text.includes("THE_TAIL_MARKER"), "tail preserved");
	const path = res.details.fullOutputPath;
	assert(path, "full output path reported");
	const full = await readFile(path, "utf8");
	assert(full.length === 100000 + 1 + "THE_TAIL_MARKER".length, `full output intact (${full.length})`);
	await rm(path, { force: true });
});

test("web_search ptc binding: registered with signature, runs without network only in shape", async () => {
	const { ptc } = await setup();
	const reg = getPtcTool("web_search");
	assert(reg, "web_search in registry");
	assert(reg.signature.includes("{ query, max_results? }"), "signature documented");
	assert(ptc.description.includes("results: {title,url,content}[]"), "signature rendered into description");
	// No live call: auth is environment-dependent; the fan-out behavior of the
	// runner is already covered by the read/grep/find tests above.
});

// ── fixture setup / run ───────────────────────────────────────────────────

dir = await mkdtemp(join(tmpdir(), "ptc-test-"));
try {
	await runTests();
} finally {
	await rm(dir, { recursive: true, force: true });
}
