/**
 * security/config — profiles config loading and validation.
 *
 * A "secrets profile" is a named bundle of environment variables, each
 * pointing at a Bitwarden vault item/field. The config holds references,
 * never values. All values are resolved through `rbw` at run time.
 *
 * Config file: ~/.pi/agent/security.json (override with PI_SECURITY_CONFIG).
 *
 *   {
 *     "profiles": {
 *       "jellyfin": {
 *         "description": "Jellyfin API token (http://localhost:8096)",
 *         "vars": {
 *           "JELLYFIN_API_KEY": { "item": "Jellyfin API", "field": "password" }
 *         }
 *       }
 *     },
 *     "rbw": { "command": "rbw", "timeoutMs": 15000 },
 *     "guard": { "disabled": false, "extraPatterns": [] }
 *   }
 *
 * `field` defaults to "password"; a var value may also be a bare item name
 * string as shorthand for `{ "item": "<name>" }`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

export interface SecretRef {
	item: string;
	field?: string;
	folder?: string;
}

export interface Profile {
	description?: string;
	vars: Record<string, SecretRef>;
}

export interface SecurityConfig {
	profiles: Record<string, Profile>;
	rbw: { command: string; timeoutMs: number };
	guard: { disabled: boolean; extraPatterns: string[] };
}

export const DEFAULT_CONFIG_PATH = join(os.homedir(), ".pi", "agent", "security.json");

export function configPath(): string {
	return process.env.PI_SECURITY_CONFIG || DEFAULT_CONFIG_PATH;
}

function fail(message: string): never {
	throw new Error(`security: invalid config (${message})`);
}

function parseSecretRef(profile: string, env: string, raw: unknown): SecretRef {
	if (typeof raw === "string") {
		if (!raw.trim()) fail(`profiles.${profile}.vars.${env}: item name is empty`);
		return { item: raw.trim() };
	}
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		const ref = raw as Record<string, unknown>;
		if (typeof ref.item !== "string" || !ref.item.trim()) {
			fail(`profiles.${profile}.vars.${env}.item must be a non-empty string`);
		}
		const parsed: SecretRef = { item: ref.item.trim() };
		if (ref.field !== undefined) {
			if (typeof ref.field !== "string" || !ref.field.trim()) fail(`profiles.${profile}.vars.${env}.field must be a string`);
			parsed.field = ref.field.trim();
		}
		if (ref.folder !== undefined) {
			if (typeof ref.folder !== "string" || !ref.folder.trim()) fail(`profiles.${profile}.vars.${env}.folder must be a string`);
			parsed.folder = ref.folder.trim();
		}
		return parsed;
	}
	fail(`profiles.${profile}.vars.${env} must be an item name string or { item, field? } object`);
}

function parseConfig(raw: unknown): SecurityConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("root must be an object");
	const obj = raw as Record<string, unknown>;

	const profiles: Record<string, Profile> = {};
	const rawProfiles = obj.profiles ?? {};
	if (!rawProfiles || typeof rawProfiles !== "object" || Array.isArray(rawProfiles)) fail("profiles must be an object");
	for (const [name, value] of Object.entries(rawProfiles as Record<string, unknown>)) {
		if (!name.trim()) fail("profile names must be non-empty");
		if (!value || typeof value !== "object" || Array.isArray(value)) fail(`profiles.${name} must be an object`);
		const entry = value as Record<string, unknown>;
		const varsRaw = entry.vars;
		if (!varsRaw || typeof varsRaw !== "object" || Array.isArray(varsRaw)) fail(`profiles.${name}.vars must be an object`);
		const vars: Record<string, SecretRef> = {};
		for (const [env, ref] of Object.entries(varsRaw as Record<string, unknown>)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(env)) fail(`profiles.${name}.vars: ${JSON.stringify(env)} is not a valid env var name`);
			vars[env] = parseSecretRef(name, env, ref);
		}
		if (Object.keys(vars).length === 0) fail(`profiles.${name}.vars is empty`);
		const profile: Profile = { vars };
		if (entry.description !== undefined) {
			if (typeof entry.description !== "string") fail(`profiles.${name}.description must be a string`);
			profile.description = entry.description;
		}
		profiles[name] = profile;
	}

	const rbwRaw = (obj.rbw ?? {}) as Record<string, unknown>;
	if (rbwRaw && (typeof rbwRaw !== "object" || Array.isArray(rbwRaw))) fail("rbw must be an object");
	const rbw = {
		command: typeof rbwRaw.command === "string" && rbwRaw.command.trim() ? rbwRaw.command.trim() : "rbw",
		timeoutMs: typeof rbwRaw.timeoutMs === "number" && rbwRaw.timeoutMs > 0 ? rbwRaw.timeoutMs : 15_000,
	};

	const guardRaw = (obj.guard ?? {}) as Record<string, unknown>;
	if (guardRaw && (typeof guardRaw !== "object" || Array.isArray(guardRaw))) fail("guard must be an object");
	const extraPatterns = Array.isArray(guardRaw.extraPatterns) ? guardRaw.extraPatterns.filter((p): p is string => typeof p === "string") : [];
	const guard = {
		disabled: guardRaw.disabled === true,
		extraPatterns,
	};

	return { profiles, rbw, guard };
}

/** Load and validate the config. Missing file is fine (empty profiles). */
export function loadConfig(path = configPath()): SecurityConfig {
	let text: string;
	try {
		text = fs.readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return parseConfig({});
		throw err;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		fail(`${path} is not valid JSON: ${(err as Error).message}`);
	}
	return parseConfig(raw);
}

/** One-line profile list for error messages. */
export function describeProfiles(config: SecurityConfig): string {
	const names = Object.keys(config.profiles);
	if (names.length === 0) return "none configured";
	return names
		.map((name) => {
			const desc = config.profiles[name].description;
			return desc ? `${name} (${desc})` : name;
		})
		.join(", ");
}
