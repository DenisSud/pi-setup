/**
 * security/rbw — resolve secret refs through the rbw CLI.
 *
 * rbw keeps the Bitwarden vault decrypted in its own agent process
 * (like ssh-agent) after a single `rbw unlock`. Every read here is a
 * subprocess call whose stdout never leaves this module except as an
 * env var handed to a child process.
 */
import { execFile } from "node:child_process";
import type { SecurityConfig, SecretRef } from "./config.ts";
import { describeProfiles } from "./config.ts";

const MAX_BUFFER = 1024 * 1024;

function rbwArgs(ref: SecretRef): string[] {
	// NOTE: do NOT pass `--raw` — in rbw that means JSON output, not the plain
	// value. `get --field <field>` prints just the field value.
	const args = ["get"];
	if (ref.folder) args.push("--folder", ref.folder);
	args.push("--field", ref.field ?? "password", ref.item);
	return args;
}

function run(config: SecurityConfig, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			config.rbw.command,
			args,
			{ timeout: config.rbw.timeoutMs, maxBuffer: MAX_BUFFER, encoding: "utf8" },
			(err, stdout, stderr) => {
				if (err) {
					const detail = (stderr || err.message || "").trim();
					const hint = /lock/i.test(detail) ? " (run `rbw unlock`)" : "";
					reject(new Error(`rbw ${args[0]} failed for ${JSON.stringify(args[args.length - 1])}: ${detail}${hint}`));
					return;
				}
				resolve(stdout);
			},
		);
	});
}

/** Fetch one field value; rbw prints the value plus one trailing newline. */
export async function rbwGet(config: SecurityConfig, ref: SecretRef): Promise<string> {
	let value = await run(config, rbwArgs(ref));
	if (value.endsWith("\n")) value = value.slice(0, -1);
	if (value.endsWith("\r")) value = value.slice(0, -1);
	if (!value) {
		throw new Error(
			`rbw returned an empty value for item ${JSON.stringify(ref.item)} field ${JSON.stringify(ref.field ?? "password")} — check the item and field names`,
		);
	}
	return value;
}

/**
 * Resolve a profile to an env map. Throws with the available profile
 * names when the name is unknown, so the model can retry usefully.
 */
export async function resolveProfile(config: SecurityConfig, name: string): Promise<Record<string, string>> {
	const profile = config.profiles[name];
	if (!profile) {
		throw new Error(`unknown secrets profile ${JSON.stringify(name)} — available: ${describeProfiles(config)}`);
	}
	const env: Record<string, string> = {};
	for (const [envName, ref] of Object.entries(profile.vars)) {
		env[envName] = await rbwGet(config, ref);
	}
	return env;
}

/** Resolve every profile; failures are reported per profile. Sequential —
 * parallel reads can open several pinentry prompts at once when locked. */
export async function resolveAll(
	config: SecurityConfig,
): Promise<{ env: Record<string, string>; failures: { profile: string; error: string }[] }> {
	const env: Record<string, string> = {};
	const failures: { profile: string; error: string }[] = [];
	for (const name of Object.keys(config.profiles)) {
		try {
			Object.assign(env, await resolveProfile(config, name));
		} catch (err) {
			failures.push({ profile: name, error: err instanceof Error ? err.message : String(err) });
		}
	}
	return { env, failures };
}
