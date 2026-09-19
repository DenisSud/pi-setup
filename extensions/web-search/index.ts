/**
 * web-search — web_search + web_fetch tools for pi, backed by a local SearXNG
 *
 *   web_search → GET http://127.0.0.1:8888/search?q=...&format=json
 *   web_fetch  → direct fetch + system extraction tools:
 *                  HTML → trafilatura --markdown (fallback: pandoc)
 *                  PDF  → pdftotext
 *
 * Replaces the Ollama cloud API version (hourly rate limits broke parallel
 * agents). SearXNG is self-hosted and quota-free; see nixos-config
 * modules/web-search.nix for the service and the trafilatura/poppler deps.
 * Override the instance with SEARXNG_BASE_URL (default http://127.0.0.1:8888).
 *
 * Reliability choices:
 *   - at most 3 concurrent SearXNG queries per process (agent search fan-out
 *     must not hammer the upstream engines past their block thresholds)
 *   - every subprocess gets a timeout, an output cap, and a clean error
 *   - extraction failures fall back (trafilatura → pandoc) instead of erroring
 *
 * Ceiling: no JS execution — pages that render client-side return only their
 * static HTML (often empty). Add a Playwright/Chromium DOM fallback when
 * JS-rendered pages start to matter; do not start with screenshots.
 *
 * ptc: `web_search` is registered for programmatic calling (extensions/ptc) —
 * search fan-out is the benchmark-proven fit for running tool calls in code.
 */

import { spawn } from "node:child_process";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { registerPtcTool } from "../ptc/registry.ts";

const DEFAULT_SEARX_BASE = "http://127.0.0.1:8888";
const SEARCH_TIMEOUT_MS = 20_000;
const MAX_CONCURRENT_SEARCHES = 3;
const MAX_RESULTS_LIMIT = 10;

const FETCH_TIMEOUT_MS = 30_000;
const FETCH_MAX_BYTES = 8 * 1024 * 1024; // give up on huge bodies
const EXTRACT_TIMEOUT_MS = 25_000;
const EXTRACT_MAX_BYTES = 16 * 1024 * 1024; // subprocess stdout cap
const MAX_CONTENT_CHARS = 120_000; // keep a fetched page from drowning the context
const USER_AGENT =
	"Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";

interface SearchResult {
	title: string;
	url: string;
	content: string;
	engine?: string;
}

type UnresponsiveEngine = [string, string];

interface FetchResult {
	title: string;
	content: string;
	url: string;
	method: "trafilatura" | "pandoc" | "pdftotext" | "text";
	truncated: boolean;
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function searxBase(): string {
	const configured = process.env.SEARXNG_BASE_URL?.trim();
	return (configured || DEFAULT_SEARX_BASE).replace(/\/+$/, "");
}

function timeoutSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
	const timeout = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

function clampCount(value: number | undefined): number {
	return Math.min(MAX_RESULTS_LIMIT, Math.max(1, Math.round(value ?? 5)));
}

// ── search concurrency gate (per pi process) ──────────────────────────────

let activeSearches = 0;
const searchWaiters: (() => void)[] = [];

async function withSearchSlot<T>(fn: () => Promise<T>): Promise<T> {
	if (activeSearches >= MAX_CONCURRENT_SEARCHES) {
		await new Promise<void>((resolve) => searchWaiters.push(resolve));
	}
	activeSearches++;
	try {
		return await fn();
	} finally {
		activeSearches--;
		searchWaiters.shift()?.();
	}
}

// ── SearXNG search ────────────────────────────────────────────────────────

interface SearxResponse {
	results?: Array<{ title?: string; url?: string; content?: string; engine?: string }>;
	unresponsive_engines?: UnresponsiveEngine[];
}

async function searxSearch(
	query: string,
	maxResults: number,
	timeRange: string | undefined,
	signal: AbortSignal | undefined,
): Promise<{ results: SearchResult[]; unresponsive: UnresponsiveEngine[] }> {
	const base = searxBase();
	const url = new URL(`${base}/search`);
	url.searchParams.set("q", query);
	url.searchParams.set("format", "json");
	if (timeRange) url.searchParams.set("time_range", timeRange);

	let response: Response;
	try {
		response = await fetch(url, {
			headers: { accept: "application/json" },
			signal: timeoutSignal(signal, SEARCH_TIMEOUT_MS),
		});
	} catch (err) {
		if (signal?.aborted) throw new Error("web_search: aborted.");
		if (err instanceof Error && err.name === "TimeoutError") {
			throw new Error(`web_search: SearXNG timed out after ${SEARCH_TIMEOUT_MS / 1000}s at ${base}.`);
		}
		throw new Error(
			`web_search: cannot reach SearXNG at ${base} (${errMessage(err)}). ` +
				`Enable it via nixos-config modules/web-search.nix (services.searx), or set SEARXNG_BASE_URL.`,
		);
	}
	if (!response.ok) {
		const body = (await response.text().catch(() => "")).slice(0, 300);
		throw new Error(`web_search: SearXNG error ${response.status}: ${body || response.statusText}`);
	}

	let data: SearxResponse;
	try {
		data = (await response.json()) as SearxResponse;
	} catch (err) {
		throw new Error(`web_search: SearXNG returned invalid JSON: ${errMessage(err)}`);
	}

	const results: SearchResult[] = [];
	for (const item of data.results ?? []) {
		if (!item.url) continue;
		results.push({
			title: item.title || item.url,
			url: item.url,
			content: item.content || "",
			engine: item.engine,
		});
		if (results.length >= maxResults) break;
	}
	return { results, unresponsive: data.unresponsive_engines ?? [] };
}

// ── subprocess helper (stdin → stdout, timed, capped) ─────────────────────

interface RunResult {
	stdout: string;
	ok: boolean;
	error?: string;
}

function runWithInput(command: string, args: string[], input: string | Buffer, timeoutMs: number): Promise<RunResult> {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
		} catch (err) {
			resolve({ stdout: "", ok: false, error: errMessage(err) });
			return;
		}

		const chunks: Buffer[] = [];
		let size = 0;
		let settled = false;
		let failure: string | undefined;

		const finish = (ok: boolean, error?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ stdout: Buffer.concat(chunks).toString("utf-8"), ok, error });
		};

		const timer = setTimeout(() => {
			failure = `${command} timed out after ${Math.round(timeoutMs / 1000)}s`;
			child.kill("SIGKILL");
		}, timeoutMs);

		child.stdout.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > EXTRACT_MAX_BYTES) {
				failure = `${command} output exceeded ${EXTRACT_MAX_BYTES / 1024 / 1024}MB`;
				child.kill("SIGKILL");
				return;
			}
			chunks.push(chunk);
		});
		child.stderr.on("data", () => {}); // diagnostics only; failure surfaced via exit
		child.on("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "ENOENT") {
				finish(false, `${command} is not installed (nixos-config modules/web-search.nix provides it)`);
			} else {
				finish(false, errMessage(err));
			}
		});
		child.on("close", (code) => {
			if (failure) finish(false, failure);
			else if (code === 0) finish(true);
			else finish(false, `${command} exited with code ${code}`);
		});

		child.stdin.on("error", () => {}); // e.g. EPIPE when the child dies early
		child.stdin.end(input);
	});
}

// ── web_fetch extraction ──────────────────────────────────────────────────

/** Trafilatura YAML frontmatter: title + body after the closing ---. */
function splitFrontmatter(text: string): { title?: string; body: string } {
	if (!text.startsWith("---\n")) return { body: text };
	const end = text.indexOf("\n---", 3);
	if (end === -1) return { body: text };
	const header = text.slice(4, end);
	const body = text.slice(end + 4).replace(/^\n+/, "");
	const title = header.match(/^title:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, "");
	return { title, body };
}

function htmlTitle(html: string): string | undefined {
	const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	if (!match) return undefined;
	const text = match[1]
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
	return text || undefined;
}

async function extractHtml(html: string, url: string): Promise<{ title: string; content: string; method: "trafilatura" | "pandoc" }> {
	const traf = await runWithInput("trafilatura", ["--markdown", "--links", "--with-metadata"], html, EXTRACT_TIMEOUT_MS);
	if (traf.ok) {
		const { title, body } = splitFrontmatter(traf.stdout);
		if (body.trim().length > 0) {
			return { title: title || htmlTitle(html) || url, content: body.trim(), method: "trafilatura" };
		}
	}
	// Fallback: pandoc converts the full page (noisy, but never empty on real HTML).
	const pandoc = await runWithInput("pandoc", ["-f", "html", "-t", "gfm", "--wrap=none"], html, EXTRACT_TIMEOUT_MS);
	if (pandoc.ok && pandoc.stdout.trim().length > 0) {
		return { title: htmlTitle(html) || url, content: pandoc.stdout.trim(), method: "pandoc" };
	}
	const detail = traf.error ?? pandoc.error ?? "no extractable content";
	throw new Error(`web_fetch: could not extract content (${detail})`);
}

async function extractPdf(bytes: Buffer): Promise<string> {
	const pdf = await runWithInput("pdftotext", ["-", "-"], bytes, EXTRACT_TIMEOUT_MS);
	if (!pdf.ok) throw new Error(`web_fetch: PDF extraction failed (${pdf.error})`);
	return pdf.stdout.trim();
}

function pdfTitle(url: string): string {
	const name = new URL(url).pathname.split("/").pop() ?? "";
	return decodeURIComponent(name).replace(/\.pdf$/i, "") || url;
}

async function fetchAndExtract(url: string, signal: AbortSignal | undefined): Promise<FetchResult> {
	let response: Response;
	try {
		response = await fetch(url, {
			redirect: "follow",
			headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.5" },
			signal: timeoutSignal(signal, FETCH_TIMEOUT_MS),
		});
	} catch (err) {
		if (signal?.aborted) throw new Error("web_fetch: aborted.");
		if (err instanceof Error && err.name === "TimeoutError") {
			throw new Error(`web_fetch: timeout after ${FETCH_TIMEOUT_MS / 1000}s fetching ${url}`);
		}
		throw new Error(`web_fetch: request failed for ${url}: ${errMessage(err)}`);
	}
	if (!response.ok) {
		throw new Error(`web_fetch: ${response.status} ${response.statusText} for ${url}`);
	}

	const finalUrl = response.url || url;
	const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
	const bytes = Buffer.from(await response.arrayBuffer());
	if (bytes.length > FETCH_MAX_BYTES) {
		throw new Error(`web_fetch: body larger than ${FETCH_MAX_BYTES / 1024 / 1024}MB (${bytes.length} bytes) for ${url}`);
	}

	let title: string;
	let content: string;
	let method: FetchResult["method"];

	if (contentType.includes("pdf") || finalUrl.toLowerCase().endsWith(".pdf")) {
		title = pdfTitle(finalUrl);
		content = await extractPdf(bytes);
		method = "pdftotext";
	} else if (contentType.includes("html") || contentType.includes("xml")) {
		const extracted = await extractHtml(bytes.toString("utf-8"), finalUrl);
		title = extracted.title;
		content = extracted.content;
		method = extracted.method;
	} else if (contentType.startsWith("text/") || contentType.includes("json")) {
		title = finalUrl;
		content = bytes.toString("utf-8").trim();
		method = "text";
	} else {
		throw new Error(`web_fetch: unsupported content type "${contentType || "unknown"}" for ${url}`);
	}

	if (!content) throw new Error(`web_fetch: no readable content at ${url}`);
	const truncated = content.length > MAX_CONTENT_CHARS;
	if (truncated) content = `${content.slice(0, MAX_CONTENT_CHARS)}\n\n[truncated at ${MAX_CONTENT_CHARS} chars]`;
	return { title, content, url: finalUrl, method, truncated };
}

// ── TUI helpers ───────────────────────────────────────────────────────────

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ── extension ─────────────────────────────────────────────────────────────

export default function webSearchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web for real-time information using a local SearXNG instance. Returns titles, URLs, and content snippets. Use for current events, docs lookups, and anything past your knowledge cutoff.",
		parameters: Type.Object({
			query: Type.String({ description: "The search query to execute" }),
			max_results: Type.Optional(
				Type.Number({
					description: "Maximum number of search results to return (default: 5, max: 10)",
					default: 5,
				}),
			),
			time_range: Type.Optional(
				Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")], {
					description: "Only return results from this period (optional)",
				}),
			),
		}),
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			let content = theme.fg("toolTitle", theme.bold("Web Search "));
			content += theme.fg("accent", `"${truncate(args.query ?? "", 80)}"`);
			if (args.max_results !== undefined) content += theme.fg("dim", ` (max ${args.max_results})`);
			text.setText(content);
			return text;
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const details = result.details as
				| { query?: string; resultCount?: number; results?: SearchResult[] }
				| undefined;

			if (isPartial) {
				text.setText(theme.fg("warning", `Searching the web for "${truncate(details?.query ?? "", 80)}"…`));
				return text;
			}
			if (result.isError) {
				text.setText(theme.fg("error", result.content[0]?.type === "text" ? result.content[0].text : "web_search failed"));
				return text;
			}

			const count = details?.resultCount ?? 0;
			let content = theme.fg("success", "✓ ") + theme.fg("toolTitle", `${count} result${count === 1 ? "" : "s"}`);
			content += theme.fg("dim", ` for "${truncate(details?.query ?? "", 80)}"`);
			if (!expanded || !details?.results?.length) {
				text.setText(content);
				return text;
			}
			for (const r of details.results) {
				content += `\n  ${theme.fg("accent", r.title)}\n  ${theme.fg("dim", r.url)}\n  ${theme.fg("default", truncate(r.content.replace(/\n/g, " "), 200))}`;
			}
			text.setText(content);
			return text;
		},
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const errorResult = (text: string) => ({
				content: [{ type: "text" as const, text }],
				details: {} as Record<string, never>,
				isError: true as const,
			});

			const maxResults = clampCount(params.max_results);
			let results: SearchResult[];
			let unresponsive: UnresponsiveEngine[];
			try {
				({ results, unresponsive } = await withSearchSlot(() =>
					searxSearch(params.query, maxResults, params.time_range, signal),
				));
			} catch (err) {
				return errorResult(errMessage(err));
			}

			const formatted =
				results
					.map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.content}`)
					.join("\n\n") || "No results found.";

			return {
				content: [{ type: "text" as const, text: formatted }],
				details: {
					query: params.query,
					resultCount: results.length,
					results,
					unresponsive: unresponsive.map(([engine, reason]) => `${engine}: ${reason}`),
				},
			};
		},
	});

	// ptc binding: structured results for search fan-out inside programs.
	// Signature documents the binding contract; behavior docs stay in the
	// web_search tool description (single source of truth).
	registerPtcTool(
		"web_search",
		async (args) => {
			const query = String(args.query ?? "");
			if (!query) throw new Error("web_search: query is required");
			const maxResults = clampCount(Number(args.max_results));
			const timeRange = typeof args.time_range === "string" ? args.time_range : undefined;
			const { results, unresponsive } = await withSearchSlot(() =>
				searxSearch(query, maxResults, timeRange, undefined),
			);
			return {
				query,
				results: results.map(({ title, url, content }) => ({ title, url, content })),
				unresponsive_engines: unresponsive,
			};
		},
		{ signature: "{ query, max_results?, time_range? } → { query, results: {title,url,content}[], unresponsive_engines: [string,string][] }" },
	);

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch and extract the main text of a web page as Markdown. Handles HTML (trafilatura) and PDFs (pdftotext). Returns the page title and content. Use to read pages surfaced by web_search.",
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch and extract content from" }),
		}),
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			let content = theme.fg("toolTitle", theme.bold("Web Fetch "));
			content += theme.fg("accent", truncate(args.url ?? "", 100));
			text.setText(content);
			return text;
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const details = result.details as
				| { url?: string; title?: string; content?: string; truncated?: boolean }
				| undefined;

			if (isPartial) {
				text.setText(theme.fg("warning", `Fetching ${truncate(details?.url ?? "", 80)}…`));
				return text;
			}
			if (result.isError) {
				text.setText(theme.fg("error", result.content[0]?.type === "text" ? result.content[0].text : "web_fetch failed"));
				return text;
			}

			let content = theme.fg("success", "✓ ") + theme.fg("toolTitle", details?.title || "Fetched page");
			content += theme.fg("dim", ` (${details?.content?.length ?? 0} chars${details?.truncated ? ", truncated" : ""})`);
			if (!expanded || !details?.content) {
				text.setText(content);
				return text;
			}
			content += `\n  ${theme.fg("default", details.content)}`;
			text.setText(content);
			return text;
		},
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const errorResult = (text: string) => ({
				content: [{ type: "text" as const, text }],
				details: {} as Record<string, never>,
				isError: true as const,
			});

			let result: FetchResult;
			try {
				result = await fetchAndExtract(params.url, signal);
			} catch (err) {
				return errorResult(errMessage(err));
			}

			const formatted = [`Title: ${result.title}`, "", "Content:", result.content].join("\n");

			return {
				content: [{ type: "text" as const, text: formatted }],
				details: {
					url: result.url,
					title: result.title,
					content: result.content,
					method: result.method,
					truncated: result.truncated,
				},
			};
		},
	});
}
