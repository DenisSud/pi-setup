/**
 * web-search — Ollama web search + fetch tools for pi
 *
 * Registers the `web_search` and `web_fetch` tools, exposing Ollama's web
 * search REST API (https://docs.ollama.com/web-search) directly:
 *
 *   POST https://ollama.com/api/web_search  { query, max_results }
 *   POST https://ollama.com/api/web_fetch   { url }
 *
 * Replaces `@ollama/pi-web-search` (which routes through a local Ollama
 * daemon's experimental endpoints) — this extension works on any machine,
 * no daemon required.
 *
 * Auth: the key is resolved fresh on EVERY call (resolveOllamaApiKey()):
 *   1. "ollama-web" entry in ~/.pi/agent/auth.json, read from disk via pi's
 *      readStoredCredential(). pi's ModelRegistry snapshots auth.json once
 *      at startup (AuthStorage.reload() runs only in the constructor), so
 *      keys added or rotated mid-session are invisible to
 *      getApiKeyForProvider — and a registered $OLLAMA_API_KEY env fallback
 *      then silently resolves a stale env key (the 401 bug this fixed).
 *      The fresh read keeps credential edits live without a session restart.
 *   2. OLLAMA_API_KEY environment variable (via ctx.modelRegistry, which
 *      also honors runtime key overrides).
 * An `ollama-web` pseudo-provider (zero models — never in model pickers) is
 * still registered so pi shows the provider as configured when only the env
 * var is set; the tools never go through it for resolution.
 *
 * TUI: renderCall shows the query/url while running; renderResult shows a
 * one-line summary when collapsed and the full results when expanded
 * (ctrl+e toggles).
 *
 * ptc: `web_search` is also registered for programmatic calling
 * (extensions/ptc) — search fan-out is the benchmark-proven fit for running
 * tool calls in code. The ptc binding returns the structured results
 * ({ query, results: [{title,url,content}] }); the direct tool returns the
 * formatted prose.
 */

import { readStoredCredential, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { registerPtcTool } from "../ptc/registry.ts";

/** Pseudo-provider id the Ollama API key is stored under. */
export const OLLAMA_AUTH_PROVIDER = "ollama-web";
/** Ollama web search API base. */
const API_BASE = "https://ollama.com/api";
/** API-enforced bounds on search result count. */
const MAX_RESULTS_LIMIT = 10;

interface SearchResult {
	title: string;
	url: string;
	content: string;
}

interface FetchResult {
	title: string;
	content: string;
	links: string[];
}

type OllamaError = { error?: string };

function errMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

/** Minimal model-registry surface the fallback path needs (satisfied by pi's ctx). */
interface SearchCtx {
	modelRegistry?: {
		getApiKeyForProvider(id: string): Promise<string | undefined>;
	};
}

/**
 * Resolve the Ollama API key for one call: fresh auth.json read first (see
 * header — pi's registry snapshots auth.json at startup, so mid-session key
 * edits are invisible to getApiKeyForProvider), then pi's standard
 * resolution (env fallback via OLLAMA_API_KEY, runtime overrides). Never
 * throws: an unreadable/missing auth.json falls through to the registry.
 * Template values ("!cmd", "$VAR") in the stored key are skipped here so
 * pi's resolver handles them.
 */
async function resolveOllamaApiKey(ctx: SearchCtx | undefined): Promise<string | undefined> {
	const stored = readStoredCredential(OLLAMA_AUTH_PROVIDER);
	if (stored?.type === "api_key" && stored.key && !stored.key.startsWith("!") && !stored.key.includes("$")) {
		return stored.key;
	}
	return (await ctx?.modelRegistry?.getApiKeyForProvider(OLLAMA_AUTH_PROVIDER)) ?? undefined;
}

const UNAUTHORIZED_HINT =
	`Create one at https://ollama.com/settings/keys and update the ` +
	`"${OLLAMA_AUTH_PROVIDER}" entry in ~/.pi/agent/auth.json (applies ` +
	`immediately, no restart needed). If OLLAMA_API_KEY is set in your ` +
	`shell, make sure it is current — it is the fallback when no stored ` +
	`entry exists.`;

/**
 * Shared search core: resolve auth, call the API, return structured results.
 * Throws Error with a clean, actionable message on any failure (used both by
 * the direct tool's errorResult and as a rejected promise inside ptc programs).
 */
async function ollamaSearch(query: string, maxResults: number, signal: AbortSignal | undefined, ctx: unknown): Promise<SearchResult[]> {
	let apiKey: string | undefined;
	try {
		apiKey = await resolveOllamaApiKey(ctx as SearchCtx | undefined);
	} catch (err) {
		throw new Error(`web_search: failed to resolve the Ollama API key: ${errMessage(err)}`);
	}
	if (!apiKey) {
		throw new Error(
			`web_search: no Ollama API key configured. Either set the OLLAMA_API_KEY environment variable, ` +
				`or add an "${OLLAMA_AUTH_PROVIDER}" entry to ~/.pi/agent/auth.json: ` +
				`{"${OLLAMA_AUTH_PROVIDER}": {"type": "api_key", "key": "<key from https://ollama.com/settings/keys>"}}.`,
		);
	}

	let data: { results: SearchResult[] };
	try {
		const response = await fetch(`${API_BASE}/web_search`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({ query, max_results: maxResults }),
			signal,
		});
		if (!response.ok) {
			const errText = (await response.text().catch(() => "")).slice(0, 500);
			if (response.status === 401) {
				throw new Error(`web_search: unauthorized (401) — the Ollama API key is missing or invalid. ${UNAUTHORIZED_HINT}`);
			}
			throw new Error(`web_search: API error (status ${response.status}): ${errText || response.statusText}`);
		}
		data = (await response.json()) as { results: SearchResult[] };
	} catch (err) {
		if (signal?.aborted) throw new Error("web_search: aborted.");
		if (err instanceof Error && err.message.startsWith("web_search:")) throw err; // already formatted
		throw new Error(`web_search: request failed: ${errMessage(err)}`);
	}
	return data.results ?? [];
}

/** Truncate for collapsed one-line display. */
function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export default function webSearchExtension(pi: ExtensionAPI) {
	// Register the auth-only pseudo-provider so pi shows "ollama-web" as
	// configured when only OLLAMA_API_KEY is set. `api`/`baseUrl` are required
	// by the config form but never used: the provider declares no models, so
	// it can't be selected for chat, and the tools resolve the key themselves.
	pi.registerProvider(OLLAMA_AUTH_PROVIDER, {
		name: "Ollama (web search)",
		api: "openai-completions",
		baseUrl: API_BASE,
		apiKey: "$OLLAMA_API_KEY",
		models: [],
	});

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web for real-time information using Ollama's web search API. Returns titles, URLs, and content snippets. Use for current events, docs lookups, and anything past your knowledge cutoff.",
		parameters: Type.Object({
			query: Type.String({ description: "The search query to execute" }),
			max_results: Type.Optional(
				Type.Number({
					description: "Maximum number of search results to return (default: 5, max: 10)",
					default: 5,
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
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const errorResult = (text: string): {
				content: { type: "text"; text: string }[];
				details: Record<string, never>;
				isError: true;
			} => ({ content: [{ type: "text", text }], details: {} as Record<string, never>, isError: true });

			const maxResults = Math.min(MAX_RESULTS_LIMIT, Math.max(1, Math.round(params.max_results ?? 5)));

			let results: SearchResult[];
			try {
				results = await ollamaSearch(params.query, maxResults, signal, ctx);
			} catch (err) {
				return errorResult(errMessage(err));
			}

			const formatted =
				results
					.map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.content}`)
					.join("\n\n") || "No results found.";

			return {
				content: [{ type: "text", text: formatted }],
				details: {
					query: params.query,
					resultCount: results.length,
					results,
				},
			};
		},
	});

	// ptc binding: structured results for search fan-out inside programs.
	// Signature documents the binding contract; behavior docs stay in the
	// web_search tool description (single source of truth).
	registerPtcTool(
		"web_search",
		async (args, ctx) => {
			const query = String(args.query ?? "");
			if (!query) throw new Error("web_search: query is required");
			const maxResults = Math.min(MAX_RESULTS_LIMIT, Math.max(1, Math.round(Number(args.max_results ?? 5))));
			const results = await ollamaSearch(query, maxResults, undefined, ctx);
			return { query, results };
		},
		{ signature: "{ query, max_results? } → { query, results: {title,url,content}[] }" },
	);

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch and extract text content from a web page URL using Ollama's web fetch API. Returns the page title, main content, and links found on the page. Use to read pages surfaced by web_search.",
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
			const details = result.details as { url?: string; title?: string; content?: string; links?: string[] } | undefined;

			if (isPartial) {
				text.setText(theme.fg("warning", `Fetching ${truncate(details?.url ?? "", 80)}…`));
				return text;
			}
			if (result.isError) {
				text.setText(theme.fg("error", result.content[0]?.type === "text" ? result.content[0].text : "web_fetch failed"));
				return text;
			}

			const linkCount = details?.links?.length ?? 0;
			let content = theme.fg("success", "✓ ") + theme.fg("toolTitle", details?.title || "Fetched page");
			content += theme.fg("dim", ` — ${linkCount} link${linkCount === 1 ? "" : "s"}`);
			if (!expanded || !details?.content) {
				text.setText(content);
				return text;
			}
			content += `\n  ${theme.fg("default", details.content)}`;
			if (details.links?.length) {
				content += `\n  ${theme.fg("dim", "Links:")}`;
				for (const link of details.links.slice(0, 10)) {
					content += `\n    ${theme.fg("dim", "- " + link)}`;
				}
			}
			text.setText(content);
			return text;
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const errorResult = (text: string): {
				content: { type: "text"; text: string }[];
				details: Record<string, never>;
				isError: true;
			} => ({ content: [{ type: "text", text }], details: {} as Record<string, never>, isError: true });

			// ── resolve the API key (fresh auth.json read, env fallback) ────
			let apiKey: string | undefined;
			try {
				apiKey = await resolveOllamaApiKey(ctx);
			} catch (err) {
				return errorResult(`web_fetch: failed to resolve the Ollama API key: ${errMessage(err)}`);
			}
			if (!apiKey) {
				return errorResult(
					`web_fetch: no Ollama API key configured. Either set the OLLAMA_API_KEY environment variable, ` +
						`or add an "${OLLAMA_AUTH_PROVIDER}" entry to ~/.pi/agent/auth.json: ` +
						`{"${OLLAMA_AUTH_PROVIDER}": {"type": "api_key", "key": "<key from https://ollama.com/settings/keys>"}}.`,
				);
			}

			// ── call the web fetch API ──────────────────────────────────────
			let data: FetchResult;
			try {
				const response = await fetch(`${API_BASE}/web_fetch`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${apiKey}`,
					},
					body: JSON.stringify({ url: params.url }),
					signal,
				});
				if (!response.ok) {
					let apiError = "";
					try {
						const body = (await response.json()) as OllamaError;
						apiError = body.error ?? "";
					} catch {
						// non-JSON error body — fall through
					}
					if (response.status === 401) {
						return errorResult(`web_fetch: unauthorized (401) — the Ollama API key is missing or invalid. ${UNAUTHORIZED_HINT}`);
					}
					return errorResult(
						`web_fetch: API error (status ${response.status}): ${apiError || response.statusText}`,
					);
				}
				data = (await response.json()) as FetchResult;
			} catch (err) {
				if (signal?.aborted) return errorResult("web_fetch: aborted.");
				return errorResult(`web_fetch: request failed: ${errMessage(err)}`);
			}

			const links = data.links ?? [];
			const formatted = [
				`Title: ${data.title}`,
				"",
				"Content:",
				data.content,
				"",
				`Links found: ${links.length}`,
				...links.slice(0, 10).map((l) => `  - ${l}`),
			].join("\n");

			return {
				content: [{ type: "text", text: formatted }],
				details: {
					url: params.url,
					title: data.title,
					content: data.content,
					links,
				},
			};
		},
	});
}
