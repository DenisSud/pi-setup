/**
 * web-search — the `web_search` discovery tool for pi, backed by a local SearXNG.
 *
 *   web_search → GET http://127.0.0.1:8888/search?q=...&format=json
 *
 * This tool finds sources: it returns titles, URLs and snippets, nothing more.
 * Reading a page is the agent's job, with the right tool for the page:
 *   - `curl` in bash for static HTML, JSON, or an API
 *   - the `agent-browser` skill when the page needs JS, interaction (forms,
 *     logins, clicks), a screenshot, or DOM/console/network inspection
 *
 * Replaces the Ollama cloud API version (hourly rate limits broke parallel
 * agents). SearXNG is self-hosted and quota-free; see nixos-config
 * modules/web-search.nix for the service. Override the instance with
 * SEARXNG_BASE_URL (default http://127.0.0.1:8888).
 *
 * Reliability choices:
 *   - at most 3 concurrent SearXNG queries per process (agent search fan-out
 *     must not hammer the upstream engines past their block thresholds)
 *   - every request gets a timeout and a clean, actionable error
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { toolExposure } from "../../lib/exposure.ts";

const DEFAULT_SEARX_BASE = "http://127.0.0.1:8888";
const SEARCH_TIMEOUT_MS = 20_000;
const MAX_CONCURRENT_SEARCHES = 3;
const MAX_RESULTS_LIMIT = 10;

interface SearchResult {
	title: string;
	url: string;
	content: string;
	engine?: string;
}

type UnresponsiveEngine = [string, string];

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

// ── TUI helpers ───────────────────────────────────────────────────────────

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ── extension ─────────────────────────────────────────────────────────────

export default function webSearchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		exposure: toolExposure(),
		description:
			"Search the web for current information using a local SearXNG instance. Returns source links with titles and snippets — discovery only, it does not fetch pages. Use it for current events, docs lookups, and anything past your knowledge cutoff, then read the promising sources with curl (static HTML/JSON) or the agent-browser skill (JS-rendered or interactive pages).",
		promptGuidelines: [
			"Use `web_search` to find sources, then read them with a purpose-built tool: `curl` in bash for static HTML, JSON, or APIs; the `agent-browser` skill for JS-rendered pages, logged-in views, or anything needing clicks, forms, screenshots, or DOM/console inspection.",
		],
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
			if (context.isError) {
				text.setText(
					theme.fg("error", result.content[0]?.type === "text" ? result.content[0].text : "web_search failed"),
				);
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
			// pi marks a tool error only when execute throws; an `isError` field on
			// a returned result is ignored. Let failures propagate with their text.
			const maxResults = clampCount(params.max_results);
			const { results, unresponsive } = await withSearchSlot(() =>
				searxSearch(params.query, maxResults, params.time_range, signal),
			);

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
}
