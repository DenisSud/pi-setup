/**
 * Harness tests for the web-search extension (SearXNG + system extractors).
 *
 * Drives the registered tools directly against a stubbed ExtensionAPI and a
 * mocked globalThis.fetch. The extraction tests run the REAL trafilatura /
 * pandoc / pdftotext binaries (run.sh wraps node in a nix shell when they are
 * not on PATH) — PATH is manipulated per test to force each branch.
 *
 * Tests:
 *   - tools + ptc binding registered
 *   - search success / max_results clamp / time_range / empty / API error /
 *     unreachable / abort
 *   - HTML extraction (trafilatura), pandoc fallback, missing-extractor error
 *   - PDF extraction (pdftotext)
 *   - text/plain passthrough + truncation, unsupported content type
 *   - live (WEB_SEARCH_LIVE=1): real local SearXNG search + real page fetch
 *
 * Run: ./test/run.sh harness      (no network)
 *      ./test/run.sh live         (needs the local SearXNG service)
 */

import { existsSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import createExtension from "../index.ts";
import { listPtcTools } from "../../ptc/registry.ts";

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

const ARTICLE_HTML = `<!doctype html><html><head><title>Test Article</title></head>
<body><header><nav>Home About Contact</nav></header>
<article><h1>Test Article</h1>
<p>SearXNG is a free internet metasearch engine which aggregates results from various search services and databases.</p>
<p>Agents retrieve apples from the orchard every autumn, and the distinctive sentence about zebras is written here so the test can find it.</p>
</article><footer>Copyright 2026</footer></body></html>`;

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

/** Minimal one-page PDF with a Helvetica text line. */
function makePdf(text) {
	const objects = {
		1: "<< /Type /Catalog /Pages 2 0 R >>",
		2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		3: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		4: `<< /Length ${`BT /F1 18 Tf 72 720 Td (${text}) Tj ET`.length} >>\nstream\nBT /F1 18 Tf 72 720 Td (${text}) Tj ET\nendstream`,
		5: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	};
	let pdf = "%PDF-1.4\n";
	const offsets = {};
	for (let i = 1; i <= 5; i++) {
		offsets[i] = pdf.length;
		pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
	}
	const xref = pdf.length;
	pdf += "xref\n0 6\n0000000000 65535 f \n";
	for (let i = 1; i <= 5; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
	pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(pdf, "latin1");
}

// ── registration ──────────────────────────────────────────────────────────

const pi = makePi();
createExtension(pi);
const search = pi.tools.get("web_search");
const fetchTool = pi.tools.get("web_fetch");

test("registers web_search, web_fetch, and the ptc binding", () => {
	assert(search, "web_search tool registered");
	assert(fetchTool, "web_fetch tool registered");
	assert(
		listPtcTools().some((t) => t.name === "web_search"),
		"web_search registered for ptc",
	);
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

// ── web_fetch: HTML ───────────────────────────────────────────────────────

test("fetch HTML → trafilatura markdown extraction", async () => {
	mockFetch(async () => makeResponse({ body: ARTICLE_HTML }));
	const result = await runTool(fetchTool, { url: "https://example.com/article" });
	assert(result.isError !== true, `not an error: ${result.content[0].text}`);
	assert(result.details.method === "trafilatura", `method: ${result.details.method}`);
	assert(result.details.title === "Test Article", `title: ${result.details.title}`);
	assert(result.details.content.includes("distinctive sentence about zebras"), "article body extracted");
	assert(!result.details.content.includes("Home About Contact"), "nav stripped");
	assert(result.content[0].text.startsWith("Title: Test Article"), "formatted text");
});

test("fetch HTML → pandoc fallback when trafilatura is unavailable", async () => {
	const pandocPath = which("pandoc");
	assert(pandocPath, "pandoc must be on PATH for the fallback test");
	const dir = mkdtempSync(join(tmpdir(), "pi-web-search-bin-"));
	symlinkSync(pandocPath, join(dir, "pandoc"));
	process.env.PATH = dir;
	mockFetch(async () => makeResponse({ body: ARTICLE_HTML }));
	const result = await runTool(fetchTool, { url: "https://example.com/article" });
	assert(result.isError !== true, `not an error: ${result.content[0].text}`);
	assert(result.details.method === "pandoc", `method: ${result.details.method}`);
	assert(/zebras/.test(result.details.content), "pandoc content present");
});

test("fetch HTML → missing extractors give an actionable error", async () => {
	process.env.PATH = "/nonexistent";
	mockFetch(async () => makeResponse({ body: ARTICLE_HTML }));
	const result = await runTool(fetchTool, { url: "https://example.com/article" });
	assert(result.isError === true, "isError");
	assert(/not installed|no extractable content/.test(result.content[0].text), `message: ${result.content[0].text}`);
});

// ── web_fetch: PDF + plain text ───────────────────────────────────────────

test("fetch PDF → pdftotext extraction", async () => {
	mockFetch(async () =>
		makeResponse({
			url: "https://example.com/paper.pdf",
			body: makePdf("PDF fixture sentence about zebras."),
			contentType: "application/pdf",
		}),
	);
	const result = await runTool(fetchTool, { url: "https://example.com/paper.pdf" });
	assert(result.isError !== true, `not an error: ${result.content[0].text}`);
	assert(result.details.method === "pdftotext", `method: ${result.details.method}`);
	assert(/zebras/.test(result.details.content), `content: ${result.details.content}`);
});

test("fetch text/plain → passthrough with truncation cap", async () => {
	mockFetch(async () => makeResponse({ url: "https://example.com/big.txt", body: "a".repeat(130_000), contentType: "text/plain" }));
	const result = await runTool(fetchTool, { url: "https://example.com/big.txt" });
	assert(result.isError !== true, `not an error: ${result.content[0].text}`);
	assert(result.details.method === "text", `method: ${result.details.method}`);
	assert(result.details.truncated === true, "truncated flag");
	assert(result.details.content.endsWith("[truncated at 120000 chars]"), "truncation marker");
});

test("fetch unsupported content type → clean error", async () => {
	mockFetch(async () => makeResponse({ body: "binary", contentType: "application/octet-stream" }));
	const result = await runTool(fetchTool, { url: "https://example.com/blob" });
	assert(result.isError === true, "isError");
	assert(/unsupported content type/.test(result.content[0].text), `message: ${result.content[0].text}`);
});

test("fetch HTTP error status → clean error", async () => {
	mockFetch(async () => makeResponse({ status: 404 }));
	const result = await runTool(fetchTool, { url: "https://example.com/missing" });
	assert(result.isError === true, "isError");
	assert(/404/.test(result.content[0].text), `message: ${result.content[0].text}`);
});

// ── live test (opt-in, needs the local SearXNG service) ───────────────────

if (process.env.WEB_SEARCH_LIVE === "1") {
	test("live: real SearXNG search", async () => {
		process.env.SEARXNG_BASE_URL = REAL_BASE ?? "http://127.0.0.1:8888";
		const result = await runTool(search, { query: "python typing module", max_results: 3 });
		assert(result.isError !== true, `not an error: ${result.content[0].text}`);
		assert(result.details.resultCount > 0, `got results: ${result.content[0].text.slice(0, 200)}`);
	});
	test("live: real page fetch", async () => {
		const result = await runTool(fetchTool, { url: "https://example.com/" });
		assert(result.isError !== true, `not an error: ${result.content[0].text}`);
		assert(result.details.content.includes("documentation examples"), `content: ${result.details.content.slice(0, 200)}`);
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
