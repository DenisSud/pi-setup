/**
 * security — secrets profiles, output redaction, credential-store guards.
 *
 * The model never handles secret values. It asks for a named profile and
 * the profile's credentials are injected as environment variables into
 * exactly one command:
 *
 *   bash { command: 'curl -H "Authorization: token $GITHUB_TOKEN" …', secrets: "github" }
 *
 * Profiles are references (vault item + field) resolved through the `rbw`
 * CLI; see config.ts for the config file shape. On top of that:
 *
 *  - every tool result is scrubbed of registered secret values (and their
 *    base64/hex/URL/JSON encodings), replaced with «redacted:NAME»;
 *  - the provider payload is scrubbed once more right before it leaves
 *    the machine;
 *  - direct store access (`rbw get`, rbw/bitwarden/keyring paths, auth.json)
 *    is blocked by the tool_call guard.
 *
 * This is a policy + redaction boundary, not a sandbox: same-user code can
 * still reach the rbw agent. The guarantee is that raw values don't enter
 * the model's context in normal operation.
 */
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { loadConfig, type SecurityConfig } from "./config.ts";
import { checkToolInput } from "./guard.ts";
import { resolveAll, resolveProfile } from "./rbw.ts";
import { Redactor, redactDeep } from "./redact.ts";

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export default function security(pi: ExtensionAPI) {
	const redactor = new Redactor();
	let config: SecurityConfig | null = null;
	let configError: string | null = null;
	let warned = false;
	let guardWarned = false;

	/** Load once; a broken config surfaces on use instead of killing pi. */
	function getConfig(): SecurityConfig {
		if (configError) throw new Error(configError);
		if (!config) {
			try {
				config = loadConfig();
			} catch (err) {
				configError = errorText(err);
				throw new Error(configError);
			}
		}
		return config;
	}

	function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") {
		if (!ctx.hasUI || warned) return;
		warned = true;
		ctx.ui.notify(message, level);
	}

	/** The guard fails open when its config cannot load (a broken config must not
	 *  brick pi), but it must not do so silently — otherwise tool calls go
	 *  unchecked for the rest of the session with no visible sign. Once per
	 *  session, on stderr as well so print mode sees it. */
	function warnGuardInactive(ctx: ExtensionContext, err: unknown) {
		if (guardWarned) return;
		guardWarned = true;
		const message = `security: guard is INACTIVE — ${errorText(err)}; tool calls are not being checked`;
		process.stderr.write(`${message}\n`);
		notify(ctx, message, "error");
	}

	// Warm the redaction set as soon as a session starts, so values are
	// scrubbed even before the first secrets-using command runs.
	pi.on("session_start", async (_event, ctx) => {
		let cfg: SecurityConfig;
		try {
			cfg = getConfig();
		} catch (err) {
			notify(ctx, errorText(err), "error");
			return;
		}
		const names = Object.keys(cfg.profiles);
		if (names.length === 0) return;
		const { env, failures } = await resolveAll(cfg);
		redactor.addEnv(env);
		if (failures.length === names.length) {
			notify(ctx, `security: no secrets profile could be resolved — ${failures[0].error}`, "warning");
		} else if (failures.length > 0) {
			notify(
				ctx,
				`security: ${failures.length}/${names.length} secrets profile(s) unavailable — ${failures[0].error}`,
				"warning",
			);
		}
	});

	// ── redaction ────────────────────────────────────────────────────────

	pi.on("tool_result", (event) => {
		if (redactor.size === 0) return;
		let changed = false;
		const content = event.content.map((item) => {
			if (item.type !== "text") return item;
			const text = redactor.redact(item.text);
			if (text === item.text) return item;
			changed = true;
			return { ...item, text };
		});
		if (!changed) return;
		return { content };
	});

	// Last net: scrub the serialized provider payload before it is sent.
	pi.on("before_provider_request", (event) => {
		if (redactor.size === 0) return;
		redactDeep(event.payload, redactor);
		return event.payload;
	});

	// ── guards ───────────────────────────────────────────────────────────

	pi.on("tool_call", (event, ctx) => {
		let cfg: SecurityConfig;
		try {
			cfg = getConfig();
		} catch (err) {
			warnGuardInactive(ctx, err);
			return;
		}
		const reason = checkToolInput(event.toolName, event.input as Record<string, unknown>, cfg.guard);
		if (reason) return { block: true, reason };
	});

	// ── bash override: one extra optional `secrets` parameter ────────────

	const proto = createBashToolDefinition(process.cwd());

	// Surface the configured profiles in the prompt copy: the model should pick
	// a profile by name without guessing and reading an error first.
	let profileSummary = "none configured (add profiles to ~/.pi/agent/security.json)";
	let profileNames: string[] = [];
	try {
		const cfg = loadConfig();
		profileNames = Object.keys(cfg.profiles);
		if (profileNames.length > 0) {
			profileSummary = profileNames
				.map((name) => {
					const description = cfg.profiles[name].description;
					return description ? `${name} (${description})` : name;
				})
				.join("; ");
		}
	} catch (err) {
		profileSummary = `unavailable — ${errorText(err)}`;
	}
	const bashParameters = Type.Object({
		...proto.parameters.properties,
		secrets: Type.Optional(
			Type.Union([Type.String(), Type.Null()], {
				description: `Secrets profile name (available: ${profileNames.length > 0 ? profileNames.join(", ") : "none"}). Injects that profile's credentials as environment variables for this command; reference them as $NAME.`,
			}),
		),
	});

	pi.registerTool({
		...proto,
		description:
			proto.description +
			' Pass `secrets: "<profile>"` to run the command with that secrets profile\'s credentials injected as environment variables; use $NAME references inside the command. Secret values in output appear as «redacted:NAME». Available profiles: ' +
			profileSummary +
			".",
		promptGuidelines: [
			...(proto.promptGuidelines ?? []),
			"Never fetch, echo, or copy credential values. Pass the bash tool's `secrets` parameter with a profile name and reference names like $GITHUB_TOKEN in the command; output containing a secret value is replaced with «redacted:NAME».",
		],
		parameters: bashParameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { secrets, ...rest } = params as { secrets?: string | null; command: string; timeout?: number };
			const stock = createBashToolDefinition(ctx.cwd);
			// Models sometimes spell "no profile" as null, "", or the string "null".
			// Treat all of them as the plain command rather than a failed lookup.
			if (secrets === null || secrets === undefined || secrets === "" || secrets === "null" || secrets === "undefined") {
				return stock.execute(toolCallId, rest as never, signal, onUpdate, ctx);
			}

			const env = await resolveProfile(getConfig(), secrets);
			redactor.addEnv(env);
			const tool = createBashToolDefinition(ctx.cwd, {
				spawnHook: (context) => ({ ...context, env: { ...context.env, ...env } }),
			});
			return tool.execute(toolCallId, rest as never, signal, onUpdate, ctx);
		},
	});

}
