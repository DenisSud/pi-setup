/**
 * Harness tests for the web-search extension (SearXNG).
 *
 * Drives the registered tool directly against a stubbed ExtensionAPI and a
 * mocked globalThis.fetch. No network, no system extractors.
 *
 * Tests:
 *   - tool registered, and nothing else (reading pages is not this extension's job)
 *   - search success / max_results clamp / time_range / empty / API error /
 *     unreachable / abort
 *   - live (WEB_SEARCH_LIVE=1): real local SearXNG search
 *
 * Run: ./test/run.sh harness      (no network)
 *      ./test/run.sh live         (needs the local SearXNG service)
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import createExtension from "../index.ts";

// The extension reads this per call; keep it fake so the search tests never
// depend on a running instance. The live test sets it back.
const REAL_BASE = process.env.SEARXNG_BASE_URL;
process.env.SEARXNG_BASE_URL = "http://searx.test";

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

const REAL_FETCH = globalThis.fetch;
const REAL_PATH = process.env.PATH;

function mockFetch(handler) {
	globalThis.fetch = async (input, init) => handler(String(input), init);
}

function restoreEnv() {
	globalThis.fetch = REAL_FETCH;
	process.env.PATH = REAL_PATH;
}

function which(command) {
	for (const dir of (process.env.PATH ?? "").split(":")) {
		const candidate = join(dir, command);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
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
		// pi's contract: execute errors are signaled by throwing, and pi wraps
		// the thrown message into this result shape (isError: true, no details).
		return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], details: {}, isError: true };
	}
	if ("isError" in result) throw new Error("execute returned `isError` — pi ignores that field; throw instead");
	return result;
}

// ── fixtures ──────────────────────────────────────────────────────────────

const SEARX_RESPONSE = {
	results: [
		{ title: "First", url: "https://example.com/1", content: "First content", engine: "google cse" },
		{ title: "Second", url: "https://example.com/2", content: "Second content", engine: "bing" },
	],
	unresponsive_engines: [["duckduckgo", "CAPTCHA"]],
};

function makeResponse({ url = "https://example.com/page", body = "", contentType = "text/html", status = 200 }) {
	const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf-8");
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: status === 200 ? "OK" : "Error",
		url,
		headers: new Headers({ "content-type": contentType }),
		arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
		text: async () => bytes.toString("utf-8"),
		json: async () => JSON.parse(bytes.toString("utf-8")),
	};
}

// ── registration ──────────────────────────────────────────────────────────

const pi = makePi();
createExtension(pi);
const search = pi.tools.get("web_search");

test("registers web_search and nothing else", () => {
	assert(search, "web_search tool registered");
	assert(pi.tools.size === 1, `only one tool registered: ${[...pi.tools.keys()].join(", ")}`);
});

// ── web_search ────────────────────────────────────────────────────────────

test("search success → formatted results + details", async () => {
	let captured;
	mockFetch(async (url) => {
		captured = url;
		return makeResponse({ body: JSON.stringify(SEARX_RESPONSE), contentType: "application/json" });
	});
	const result = await runTool(search, { query: "what is searxng?" });
	assert(result.isError !== true, `not an error: ${result.content[0].text}`);
	const parsed = new URL(captured);
	assert(parsed.origin === "http://searx.test" && parsed.pathname === "/search", `url: ${captured}`);
	assert(parsed.searchParams.get("q") === "what is searxng?", "query param");
	assert(parsed.searchParams.get("format") === "json", "json format");
	assert(result.content[0].text.includes("1. First") && result.content[0].text.includes("URL: https://example.com/1"), "formatted");
	assert(result.details.resultCount === 2, "resultCount");
	assert(result.details.results[1].title === "Second", "raw results in details");
	assert(result.details.unresponsive[0] === "duckduckgo: CAPTCHA", "unresponsive engines surfaced in details");
});

test("search max_results: default 5, clamped to 10", async () => {
	const many = { results: Array.from({ length: 12 }, (_, i) => ({ title: `R${i}`, url: `https://example.com/${i}`, content: "" })) };
	mockFetch(async () => makeResponse({ body: JSON.stringify(many), contentType: "application/json" }));
	const def = await runTool(search, { query: "x" });
	assert(def.details.resultCount === 5, `default: ${def.details.resultCount}`);
	const high = await runTool(search, { query: "x", max_results: 50 });
	assert(high.details.resultCount === 10, `clamped: ${high.details.resultCount}`);
});

test("search time_range → time_range param", async () => {
	let captured;
	mockFetch(async (url) => {
		captured = new URL(url);
		return makeResponse({ body: JSON.stringify(SEARX_RESPONSE), contentType: "application/json" });
	});
	await runTool(search, { query: "x", time_range: "week" });
	assert(captured.searchParams.get("time_range") === "week", `time_range: ${captured.searchParams.get("time_range")}`);
});

test("search empty results → No results found.", async () => {
	mockFetch(async () => makeResponse({ body: JSON.stringify({ results: [] }), contentType: "application/json" }));
	const result = await runTool(search, { query: "x" });
	assert(result.isError !== true, "not an error");
	assert(result.content[0].text === "No results found.", `text: ${result.content[0].text}`);
});

test("search results without a url are dropped", async () => {
	mockFetch(async () =>
		makeResponse({
			body: JSON.stringify({ results: [{ title: "No URL", content: "x" }, { title: "Kept", url: "https://example.com/k", content: "y" }] }),
			contentType: "application/json",
		}),
	);
	const result = await runTool(search, { query: "x" });
	assert(result.details.resultCount === 1, `count: ${result.details.resultCount}`);
	assert(result.details.results[0].title === "Kept", "kept the one with a url");
});

test("search API error → status in clean error", async () => {
	mockFetch(async () => makeResponse({ body: "boom", contentType: "text/plain", status: 503 }));
	const result = await runTool(search, { query: "x" });
	assert(result.isError === true, "isError");
	assert(/503/.test(result.content[0].text), `mentions status: ${result.content[0].text}`);
});

test("search unreachable → SearXNG setup hint", async () => {
	mockFetch(async () => {
		throw new TypeError("fetch failed");
	});
	const result = await runTool(search, { query: "x" });
	assert(result.isError === true, "isError");
	assert(/cannot reach SearXNG/.test(result.content[0].text), `message: ${result.content[0].text}`);
	assert(/web-search\.nix/.test(result.content[0].text), "points at the nixos module");
});

test("search invalid JSON → clean error", async () => {
	mockFetch(async () => makeResponse({ body: "<html>not json</html>", contentType: "application/json" }));
	const result = await runTool(search, { query: "x" });
	assert(result.isError === true, "isError");
	assert(/invalid JSON/.test(result.content[0].text), `message: ${result.content[0].text}`);
});

test("search abort → aborted error", async () => {
	const controller = new AbortController();
	controller.abort();
	mockFetch(async () => {
		throw Object.assign(new Error("aborted"), { name: "AbortError" });
	});
	const result = await runTool(search, { query: "x" }, { signal: controller.signal });
	assert(result.isError === true, "isError");
	assert(/aborted/.test(result.content[0].text), `message: ${result.content[0].text}`);
});

test("search concurrency gate: 4 parallel searches still return", async () => {
	mockFetch(async () => makeResponse({ body: JSON.stringify(SEARX_RESPONSE), contentType: "application/json" }));
	const results = await Promise.all(Array.from({ length: 4 }, (_, i) => runTool(search, { query: `q${i}` })));
	assert(results.every((r) => r.details.resultCount === 2), "all four resolved");
});

// ── live test (opt-in, needs the local SearXNG service) ───────────────────

if (process.env.WEB_SEARCH_LIVE === "1") {
	test("live: real SearXNG search", async () => {
		process.env.SEARXNG_BASE_URL = REAL_BASE ?? "http://127.0.0.1:8888";
		const result = await runTool(search, { query: "python typing module", max_results: 3 });
		assert(result.isError !== true, `not an error: ${result.content[0].text}`);
		assert(result.details.resultCount > 0, `got results: ${result.content[0].text.slice(0, 200)}`);
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
	} finally {
		restoreEnv();
	}
}
console.log(`\n${passed}/${tests.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
