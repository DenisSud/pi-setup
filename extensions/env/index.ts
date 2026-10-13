/**
 * env — load ~/.pi/agent/env.json into the pi process environment.
 *
 * One machine-local file for the values the agent's shell commands and
 * extensions need (service keys, passwords), instead of cluttering
 * settings.json:
 *
 *   {
 *     "JELLYFIN_API_KEY": "…",
 *     "GMAIL_APP_PASSWORD": "…",
 *     "MEM0_PI_KEY": "…",
 *     "COUCHDB_USER": "${USER}"
 *   }
 *
 * ${VAR} and ${VAR:-fallback} interpolate the ambient environment; scalars are
 * coerced to strings. Values are injected into the pi process at load time, so
 * every bash command inherits them, and extensions read them with
 * `process.env`.
 *
 * This file holds secrets in plain text: keep it mode 600. A file readable by
 * anyone else gets a warning at session start.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CONFIG_FILE = "env.json";
/** Only names bash and friends accept; anything else would be unreachable. */
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INTERPOLATION = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

type LoadOutcome =
	| { kind: "ok"; path: string; vars: Record<string, string>; problems: string[] }
	| { kind: "missing"; path: string }
	| { kind: "unreadable"; path: string; error: string };

export function configPath(): string {
	return process.env.PI_ENV_CONFIG ?? join(homedir(), ".pi", "agent", CONFIG_FILE);
}

function interpolate(value: string): string {
	return value.replace(INTERPOLATION, (_match, name: string, fallback: string | undefined) => {
		const found = process.env[name];
		return found !== undefined ? found : (fallback ?? "");
	});
}

function isScalar(value: unknown): value is string | number | boolean {
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** Read and validate the file without touching process.env. */
export function loadEnv(path: string): LoadOutcome {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing", path };
		return { kind: "unreadable", path, error: (err as Error).message };
	}

	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		return { kind: "unreadable", path, error: `invalid JSON: ${(err as Error).message}` };
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { kind: "unreadable", path, error: "the top level must be a JSON object" };
	}

	const vars: Record<string, string> = {};
	const problems: string[] = [];
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!VAR_NAME.test(key)) {
			problems.push(`${JSON.stringify(key)} is not a valid variable name — skipped`);
			continue;
		}
		if (!isScalar(value)) {
			problems.push(`${key} must be a string, number or boolean — skipped`);
			continue;
		}
		const resolved = interpolate(String(value));
		if (!resolved) {
			problems.push(`${key} resolves to an empty value — skipped`);
			continue;
		}
		vars[key] = resolved;
	}

	if ((statSync(path).mode & 0o077) !== 0) {
		problems.push(`${path} is readable by other users — chmod 600 it`);
	}

	return { kind: "ok", path, vars, problems };
}

export default function envExtension(pi: ExtensionAPI) {
	const outcome = (() => {
		try {
			return loadEnv(configPath());
		} catch (err) {
			return { kind: "unreadable", path: configPath(), error: (err as Error).message } as LoadOutcome;
		}
	})();

	const names = outcome.kind === "ok" ? Object.keys(outcome.vars) : [];
	if (outcome.kind === "ok") Object.assign(process.env, outcome.vars);

	// Problems are reported once per session, and only from a session with a UI:
	// a missing file is normal in fleet deployments that carry the values in the
	// environment instead.
	let reported = false;
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		if (reported || !ctx.hasUI) return;
		reported = true;
		if (outcome.kind === "unreadable") {
			ctx.ui.notify(`env: cannot use ${outcome.path} — ${outcome.error}; variables are NOT set`, "error");
			return;
		}
		if (outcome.kind === "missing") {
			ctx.ui.notify(`env: no ${outcome.path} — no variables were set`, "warning");
			return;
		}
		if (outcome.problems.length > 0) {
			ctx.ui.notify(`env: ${outcome.problems.join("; ")}`, "warning");
		}
	});

	// Names only: the values are visible in the file itself, and this output
	// goes to a terminal that may be shared or recorded.
	pi.registerCommand("env", {
		description: "List the variables loaded from env.json (names only)",
		handler: async (_args, ctx: ExtensionContext) => {
			if (outcome.kind !== "ok") {
				ctx.ui.notify(`env: ${outcome.path} — ${outcome.kind}`, "warning");
				return;
			}
			const body =
				names.length === 0
					? `env: ${outcome.path} defines no variables`
					: `env: ${names.length} variable${names.length === 1 ? "" : "s"} from ${outcome.path}\n  ${names.join("\n  ")}`;
			ctx.ui.notify(body, "info");
		},
	});
}
