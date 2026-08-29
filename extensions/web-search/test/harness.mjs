/**
 * Harness tests for the web-search extension.
 *
 * Drives the registered tools directly with a stubbed ExtensionAPI +
 * modelRegistry. Network calls go to globalThis.fetch, which is mocked —
 * no real requests unless the live test is opted in.
 *
 * Tests:
 *   - pseudo-provider registration (auth wiring exists)
 *   - no auth                   → clean error with setup instructions
 *   - auth resolution throws    → clean error
 *   - search success            → formatted results + details
 *   - search empty results      → "No results found."
 *   - max_results default/clamp → 5 default, clamped to [1, 10]
 *   - search 401                → key guidance in the error
 *   - search 500                → status + body in the error
 *   - fetch success             → title/content/links formatted
 *   - fetch 401                 → key guidance in the error
 *   - network failure           → clean "request failed" error
 *   - abort                     → "aborted" error
 *   - live (WEB_SEARCH_LIVE=1, WEB_SEARCH_KEY=...): real ollama.com call
 *
 * Run: node test/harness.mjs   (Node >= 23.6, native TS type stripping)
 * Requires node_modules symlinks set up by run.sh.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import createExtension, { OLLAMA_AUTH_PROVIDER } from "../index.ts";

// ── isolated agent dir ──────────────────────────────────────────────────
// The extension reads ~/.pi/agent/auth.json fresh on every call (the auth
// fix). PI_CODING_AGENT_DIR redirects getAgentDir() to a temp dir so tests
// never touch the real credentials and can simulate mid-session auth edits.
const AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-web-search-test-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
const AUTH_PATH = join(AGENT_DIR, "auth.json");
process.on("exit", () => rmSync(AGENT_DIR, { recursive: true, force: true }));

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

function makePi() {
	const tools = new Map();
	const providers = new Map();
	return {
		registerTool: (def) => tools.set(def.name, def),
		registerProvider: (id, config) => providers.set(id, config),
		on: () => {},
		tools,
		providers,
	};
}

function makeRegistry({ auth = "test-key", authError } = {}) {
	return {
		getApiKeyForProvider: async (id) => {
			if (authError) throw authError;
			if (id === OLLAMA_AUTH_PROVIDER) return auth;
			return undefined;
		},
	};
}

const REAL_FETCH = globalThis.fetch;
const SAMPLE_RESULTS = {
	results: [
		{ title: "First", url: "https://example.com/1", content: "First content" },
		{ title: "Second", url: "https://example.com/2", content: "Second content" },
	],
};
function mockFetch(handler) {
	globalThis.fetch = async (input, init) => handler(String(input), init);
}
// restore after each test even on failure
const origTest = test;
test = (name, fn) =>
	origTest(name, async () => {
		try {
			await fn();
		} finally {
			globalThis.fetch = REAL_FETCH;
		}
	});

// ── registration ──────────────────────────────────────────────────────────

const pi = makePi();
createExtension(pi);
const search = pi.tools.get("web_search");
const fetchTool = pi.tools.get("web_fetch");
assert(search, "web_search tool registered");
assert(fetchTool, "web_fetch tool registered");

test("registers ollama-web pseudo-provider with env key auth", () => {
	const config = pi.providers.get(OLLAMA_AUTH_PROVIDER);
	assert(config, "provider registered");
	assert(config.apiKey === "$OLLAMA_API_KEY", `apiKey config: ${config.apiKey}`);
	assert(Array.isArray(config.models) && config.models.length === 0, "no models (never a chat provider)");
});

async function runTool(tool, params, { registry, signal } = {}) {
	const ctx = { modelRegistry: registry ?? makeRegistry(), cwd: "/tmp" };
	return tool.execute("call-1", params, signal, undefined, ctx);
}

// ── auth ──────────────────────────────────────────────────────────────────

test("no auth → clean error with setup instructions", async () => {
	const result = await runTool(search, { query: "x" }, { registry: makeRegistry({ auth: "" }) });
	assert(result.isError === true, "isError");
	assert(/OLLAMA_API_KEY/.test(result.content[0].text), "mentions env var");
	assert(/ollama-web/.test(result.content[0].text), "mentions auth.json provider id");
	assert(/ollama\.com\/settings\/keys/.test(result.content[0].text), "points at key creation");
});

test("auth resolution throws → clean error", async () => {
	const result = await runTool(
		search,
		{ query: "x" },
		{ registry: makeRegistry({ authError: new Error("credential store read failed") }) },
	);
	assert(result.isError === true, "isError");
	assert(/credential store read failed/.test(result.content[0].text), "includes cause");
});

// ── fresh auth.json reads (the 401 regression: pi snapshots auth.json at
//    startup, so mid-session key edits must be picked up per call) ────────

function writeAuth(key) {
	writeFileSync(AUTH_PATH, JSON.stringify({ [OLLAMA_AUTH_PROVIDER]: { type: "api_key", key } }));
}

test("key added to auth.json mid-session works without restart", async () => {
	let captured;
	mockFetch(async (_url, init) => {
		captured = { init };
		return { ok: true, status: 200, json: async () => SAMPLE_RESULTS };
	});
	try {
		// session started before the key existed: registry snapshot has nothing
		const before = await runTool(search, { query: "x" }, { registry: makeRegistry({ auth: "" }) });
		assert(before.isError === true, "no key anywhere → clean error");

		writeAuth("fresh-key");
		const after = await runTool(search, { query: "x" }, { registry: makeRegistry({ auth: "" }) });
		assert(after.isError !== true, `works without restart: ${after.content[0].text}`);
		assert(captured.init.headers.Authorization === "Bearer fresh-key", "fresh key used");
	} finally {
		rmSync(AUTH_PATH, { force: true });
	}
});

test("rotated auth.json key wins over stale registry snapshot", async () => {
	let captured;
	mockFetch(async (_url, init) => {
		captured = { init };
		return { ok: true, status: 200, json: async () => SAMPLE_RESULTS };
	});
	try {
		writeAuth("rotated-key");
		await runTool(search, { query: "x" }, { registry: makeRegistry({ auth: "stale-key" }) });
		assert(captured.init.headers.Authorization === "Bearer rotated-key", "rotated key beats registry snapshot");
	} finally {
		rmSync(AUTH_PATH, { force: true });
	}
});

test("template keys in auth.json are skipped — registry resolves them", async () => {
	let captured;
	mockFetch(async (_url, init) => {
		captured = { init };
		return { ok: true, status: 200, json: async () => SAMPLE_RESULTS };
	});
	try {
		writeAuth("$OLLAMA_API_KEY");
		await runTool(search, { query: "x" }, { registry: makeRegistry({ auth: "registry-key" }) });
		assert(captured.init.headers.Authorization === "Bearer registry-key", "registry path used for templates");
	} finally {
		rmSync(AUTH_PATH, { force: true });
	}
});

// ── web_search ────────────────────────────────────────────────────────────


test("search success → formatted results + details", async () => {
	let captured;
	mockFetch(async (url, init) => {
		captured = { url, init, body: JSON.parse(init.body) };
		return {
			ok: true,
			status: 200,
			json: async () => SAMPLE_RESULTS,
		};
	});
	const result = await runTool(search, { query: "what is ollama?" });
	assert(result.isError !== true, `not an error: ${result.content[0].text}`);
	assert(captured.url === "https://ollama.com/api/web_search", `url: ${captured.url}`);
	assert(captured.init.headers.Authorization === "Bearer test-key", "bearer auth header");
	assert(captured.body.query === "what is ollama?", "query in body");
	assert(captured.body.max_results === 5, "default max_results");
	assert(result.content[0].text.includes("1. First") && result.content[0].text.includes("URL: https://example.com/1"), "formatted");
	assert(result.details.resultCount === 2, "resultCount");
	assert(result.details.results[0].title === "First", "raw results in details");
});

test("search empty results → No results found.", async () => {
	mockFetch(async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) }));
	const result = await runTool(search, { query: "x" });
	assert(result.isError !== true, "not an error");
	assert(result.content[0].text === "No results found.", `text: ${result.content[0].text}`);
	assert(result.details.resultCount === 0, "resultCount 0");
});

test("max_results defaults to 5, clamped to [1, 10]", async () => {
	const bodies = [];
	mockFetch(async (_url, init) => {
		bodies.push(JSON.parse(init.body));
		return { ok: true, status: 200, json: async () => ({ results: [] }) };
	});
	await runTool(search, { query: "x" });
	await runTool(search, { query: "x", max_results: 99 });
	await runTool(search, { query: "x", max_results: 0 });
	await runTool(search, { query: "x", max_results: 3.7 });
	assert(bodies[0].max_results === 5, `default: ${bodies[0].max_results}`);
	assert(bodies[1].max_results === 10, `clamped high: ${bodies[1].max_results}`);
	assert(bodies[2].max_results === 1, `clamped low: ${bodies[2].max_results}`);
	assert(bodies[3].max_results === 4, `rounded: ${bodies[3].max_results}`);
});

test("search 401 → key guidance in the error", async () => {
	mockFetch(async () => ({ ok: false, status: 401, statusText: "Unauthorized", text: async () => "unauthorized" }));
	const result = await runTool(search, { query: "x" });
	assert(result.isError === true, "isError");
	assert(/unauthorized \(401\)/.test(result.content[0].text), `message: ${result.content[0].text}`);
	assert(/settings\/keys/.test(result.content[0].text), "key creation hint");
});

test("search 500 → status + body in the error", async () => {
	mockFetch(async () => ({
		ok: false,
		status: 500,
		statusText: "Internal Server Error",
		text: async () => "backend exploded",
	}));
	const result = await runTool(search, { query: "x" });
	assert(result.isError === true, "isError");
	assert(/status 500/.test(result.content[0].text) && /backend exploded/.test(result.content[0].text), `message: ${result.content[0].text}`);
});

// ── web_fetch ─────────────────────────────────────────────────────────────

test("fetch success → title/content/links formatted", async () => {
	let captured;
	mockFetch(async (url, init) => {
		captured = { url, body: JSON.parse(init.body) };
		return {
			ok: true,
			status: 200,
			json: async () => ({
				title: "Example",
				content: "Page body here",
				links: ["https://example.com/a", "https://example.com/b"],
			}),
		};
	});
	const result = await runTool(fetchTool, { url: "https://example.com" });
	assert(result.isError !== true, `not an error: ${result.content[0].text}`);
	assert(captured.url === "https://ollama.com/api/web_fetch", `url: ${captured.url}`);
	assert(captured.body.url === "https://example.com", "url in body");
	const text = result.content[0].text;
	assert(text.includes("Title: Example") && text.includes("Page body here"), "title + content");
	assert(text.includes("Links found: 2") && text.includes("  - https://example.com/a"), "links listed");
	assert(result.details.title === "Example" && result.details.links.length === 2, "details");
});

test("fetch caps listed links at 10 but reports full count", async () => {
	const many = Array.from({ length: 25 }, (_, i) => `https://example.com/${i}`);
	mockFetch(async () => ({ ok: true, status: 200, json: async () => ({ title: "t", content: "c", links: many }) }));
	const result = await runTool(fetchTool, { url: "https://example.com" });
	assert(result.isError !== true, "not an error");
	assert(result.content[0].text.includes("Links found: 25"), "full count");
	assert(!result.content[0].text.includes("https://example.com/24"), "only 10 links listed");
});

test("fetch 401 → key guidance in the error", async () => {
	mockFetch(async () => ({ ok: false, status: 401, statusText: "Unauthorized" }));
	const result = await runTool(fetchTool, { url: "https://example.com" });
	assert(result.isError === true, "isError");
	assert(/unauthorized \(401\)/.test(result.content[0].text), `message: ${result.content[0].text}`);
});

test("fetch error body with error field is surfaced", async () => {
	mockFetch(async () => ({
		ok: false,
		status: 400,
		statusText: "Bad Request",
		json: async () => ({ error: "invalid url" }),
	}));
	const result = await runTool(fetchTool, { url: "not-a-url" });
	assert(result.isError === true, "isError");
	assert(/invalid url/.test(result.content[0].text), `message: ${result.content[0].text}`);
});

// ── failure modes ─────────────────────────────────────────────────────────

test("network failure → clean request-failed error", async () => {
	mockFetch(async () => {
		throw new Error("fetch failed: ECONNREFUSED");
	});
	const result = await runTool(search, { query: "x" });
	assert(result.isError === true, "isError");
	assert(/request failed/.test(result.content[0].text), `message: ${result.content[0].text}`);
});

test("abort → aborted error", async () => {
	const controller = new AbortController();
	mockFetch(async (_url, init) => {
		assert(init.signal.aborted === false, "signal starts live");
		controller.abort();
		const e = new Error("This operation was aborted");
		e.name = "AbortError";
		throw e;
	});
	const result = await runTool(search, { query: "x" }, { signal: controller.signal });
	assert(result.isError === true, "isError");
	assert(/aborted/.test(result.content[0].text), `message: ${result.content[0].text}`);
});

// ── live (opt-in) ─────────────────────────────────────────────────────────

test("live ollama.com search + fetch (opt-in)", async () => {
	if (!process.env.WEB_SEARCH_LIVE) {
		console.log("  skip  (set WEB_SEARCH_LIVE=1 and WEB_SEARCH_KEY to run the live test)");
		return;
	}
	const key = process.env.WEB_SEARCH_KEY;
	assert(key, "WEB_SEARCH_KEY required for live test");
	const registry = makeRegistry({ auth: key });

	const s = await runTool(search, { query: "ollama web search api", max_results: 3 }, { registry });
	assert(s.isError !== true, `search not an error: ${s.content[0].text}`);
	assert(s.details.resultCount > 0, "got results");
	console.log(`        search: ${s.details.resultCount} results, first: ${s.details.results[0].url}`);

	const f = await runTool(fetchTool, { url: s.details.results[0].url }, { registry });
	assert(f.isError !== true, `fetch not an error: ${f.content[0].text}`);
	assert(f.details.title, "got title");
	console.log(`        fetch: "${f.details.title}" (${f.details.links?.length ?? 0} links)`);
});

runTests();
