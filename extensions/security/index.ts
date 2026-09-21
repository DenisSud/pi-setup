/**
 * security — secrets profiles, output redaction, credential-store guards.
 *
 * The model never handles secret values. It asks for a named profile and
 * the profile's credentials are injected as environment variables into
 * exactly one command:
 *
 *   bash { command: 'curl -H "Authorization: token $FORGEJO_TOKEN" …', secrets: "forgejo" }
 *   ptc  → await secrets_sh({ profile: "forgejo", command: 'curl …' })
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
import { createBashToolDefinition, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { registerPtcTool } from "../ptc/registry.ts";
import { loadConfig, type SecurityConfig } from "./config.ts";
import { checkToolInput } from "./guard.ts";
import { resolveAll, resolveProfile } from "./rbw.ts";
import { Redactor, redactDeep } from "./redact.ts";

const PTC_OUTPUT_CAP = 50_000;

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export default function security(pi: ExtensionAPI) {
	const redactor = new Redactor();
	let config: SecurityConfig | null = null;
	let configError: string | null = null;
	let warned = false;

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

	pi.on("tool_call", (event) => {
		let cfg: SecurityConfig;
		try {
			cfg = getConfig();
		} catch {
			return;
		}
		const reason = checkToolInput(event.toolName, event.input as Record<string, unknown>, cfg.guard);
		if (reason) return { block: true, reason };
	});

	// ── bash override: one extra optional `secrets` parameter ────────────

	const proto = createBashToolDefinition(process.cwd());
	const bashParameters = Type.Object({
		...proto.parameters.properties,
		secrets: Type.Optional(
			Type.String({
				description:
					"Secrets profile name. Injects that profile's credentials as environment variables for this command; reference them as $NAME.",
			}),
		),
	});

	pi.registerTool({
		...proto,
		description:
			proto.description +
			' Pass `secrets: "<profile>"` to run the command with that secrets profile\'s credentials injected as environment variables; use $NAME references inside the command. Secret values in output appear as «redacted:NAME».',
		promptGuidelines: [
			...(proto.promptGuidelines ?? []),
			"Never fetch, echo, or copy credential values. Pass the bash tool's `secrets` parameter with a profile name (ptc programs: `secrets_sh`) and reference names like $FORGEJO_TOKEN in the command; output containing a secret value is replaced with «redacted:NAME».",
		],
		parameters: bashParameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { secrets, ...rest } = params as { secrets?: string; command: string; timeout?: number };
			const stock = createBashToolDefinition(ctx.cwd);
			if (!secrets) return stock.execute(toolCallId, rest as never, signal, onUpdate, ctx);

			const env = await resolveProfile(getConfig(), secrets);
			redactor.addEnv(env);
			const tool = createBashToolDefinition(ctx.cwd, {
				spawnHook: (context) => ({ ...context, env: { ...context.env, ...env } }),
			});
			return tool.execute(toolCallId, rest as never, signal, onUpdate, ctx);
		},
	});

	// ── ptc binding ──────────────────────────────────────────────────────

	registerPtcTool(
		"secrets_sh",
		async (args, ctx) => {
			const profile = String(args.profile ?? "");
			const command = String(args.command ?? "");
			if (!profile) throw new Error("secrets_sh: profile is required");
			if (!command) throw new Error("secrets_sh: command is required");
			const env = await resolveProfile(getConfig(), profile);
			redactor.addEnv(env);

			const cwd = typeof (ctx as { cwd?: unknown } | undefined)?.cwd === "string" ? (ctx as { cwd: string }).cwd : process.cwd();
			const timeoutMs = Number(args.timeout_ms) > 0 ? Number(args.timeout_ms) : 60_000;
			let output = "";
			const { exitCode } = await createLocalBashOperations().exec(command, cwd, {
				env: { ...process.env, ...env },
				timeout: timeoutMs,
				onData: (chunk) => {
					output += chunk.toString();
				},
			});
			const redacted = redactor.redact(output);
			const capped = redacted.length > PTC_OUTPUT_CAP ? `${redacted.slice(0, PTC_OUTPUT_CAP)}\n…[truncated]` : redacted;
			return { output: capped, code: exitCode };
		},
		{
			signature:
				"{ profile, command, timeout_ms? } → { output, code } — runs the command with the profile's credentials in env; output is redacted",
		},
	);

}
