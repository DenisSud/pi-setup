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
 * Auth: the extension registers an `ollama-web` pseudo-provider (zero
 * models — never shows up in model pickers) with the standard pi-ai api-key
 * auth. Resolution order is pi's built-in one:
 *   1. stored credential: "ollama-web" entry in ~/.pi/agent/auth.json,
 *      e.g. "ollama-web": { "type": "api_key", "key": "<key>" }
 *   2. environment: OLLAMA_API_KEY
 * Both resolve through ctx.modelRegistry.getProviderAuth("ollama-web") —
 * the same auth path pi uses for real providers (verified: stored
 * credential wins, env is the fallback; see pi-ai auth/helpers.js).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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

export default function webSearchExtension(pi: ExtensionAPI) {
	// Register the auth-only pseudo-provider so getProviderAuth("ollama-web")
	// resolves the key the standard way (stored credential → env fallback).
	// `api`/`baseUrl` are required by the config form but never used: the
	// provider declares no models, so it can't be selected for chat.
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
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const errorResult = (text: string): {
				content: { type: "text"; text: string }[];
				details: Record<string, never>;
				isError: true;
			} => ({ content: [{ type: "text", text }], details: {} as Record<string, never>, isError: true });

			const maxResults = Math.min(MAX_RESULTS_LIMIT, Math.max(1, Math.round(params.max_results ?? 5)));

			// ── resolve the API key the way pi resolves provider auth ───────
			let apiKey: string | undefined;
			try {
				const auth = await ctx.modelRegistry.getProviderAuth(OLLAMA_AUTH_PROVIDER);
				apiKey = auth?.auth?.apiKey;
			} catch (err) {
				return errorResult(`web_search: failed to resolve the Ollama API key: ${errMessage(err)}`);
			}
			if (!apiKey) {
				return errorResult(
					`web_search: no Ollama API key configured. Either set the OLLAMA_API_KEY environment variable, ` +
						`or add an "${OLLAMA_AUTH_PROVIDER}" entry to ~/.pi/agent/auth.json: ` +
						`{"${OLLAMA_AUTH_PROVIDER}": {"type": "api_key", "key": "<key from https://ollama.com/settings/keys>"}}.`,
				);
			}

			// ── call the web search API ─────────────────────────────────────
			let data: { results: SearchResult[] };
			try {
				const response = await fetch(`${API_BASE}/web_search`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${apiKey}`,
					},
					body: JSON.stringify({ query: params.query, max_results: maxResults }),
					signal,
				});
				if (!response.ok) {
					const errText = (await response.text().catch(() => "")).slice(0, 500);
					if (response.status === 401) {
						return errorResult(
							`web_search: unauthorized (401) — the Ollama API key is missing or invalid. ` +
								`Create one at https://ollama.com/settings/keys and update the ` +
								`"${OLLAMA_AUTH_PROVIDER}" entry in ~/.pi/agent/auth.json or OLLAMA_API_KEY.`,
						);
					}
					return errorResult(
						`web_search: API error (status ${response.status}): ${errText || response.statusText}`,
					);
				}
				data = (await response.json()) as { results: SearchResult[] };
			} catch (err) {
				if (signal?.aborted) return errorResult("web_search: aborted.");
				return errorResult(`web_search: request failed: ${errMessage(err)}`);
			}

			const results = data.results ?? [];
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

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch and extract text content from a web page URL using Ollama's web fetch API. Returns the page title, main content, and links found on the page. Use to read pages surfaced by web_search.",
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch and extract content from" }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const errorResult = (text: string): {
				content: { type: "text"; text: string }[];
				details: Record<string, never>;
				isError: true;
			} => ({ content: [{ type: "text", text }], details: {} as Record<string, never>, isError: true });

			// ── resolve the API key the way pi resolves provider auth ───────
			let apiKey: string | undefined;
			try {
				const auth = await ctx.modelRegistry.getProviderAuth(OLLAMA_AUTH_PROVIDER);
				apiKey = auth?.auth?.apiKey;
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
						return errorResult(
							`web_fetch: unauthorized (401) — the Ollama API key is missing or invalid. ` +
								`Create one at https://ollama.com/settings/keys and update the ` +
								`"${OLLAMA_AUTH_PROVIDER}" entry in ~/.pi/agent/auth.json or OLLAMA_API_KEY.`,
						);
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
