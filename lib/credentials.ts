/**
 * lib/credentials — credentials come from the process environment.
 *
 * The `pi-env` extension (npm:pi-env) copies the `"env"` block of
 * ~/.pi/agent/settings.json into process.env when pi starts, so a secret is
 * one flat variable read instead of a vault lookup. Consequence to accept:
 * anything with the same user can read that file — it is a convenience
 * boundary, not a sandbox.
 *
 * A missing variable is a hard error, and it names what to set: silent empty
 * credentials would surface later as a confusing 401 from the server.
 */

/** Env file read by pi-env; only used for the error message. */
const ENV_SOURCE = 'the "env" block of ~/.pi/agent/settings.json (pi-env)';

/**
 * Read `names` from the environment. Throws listing every missing one, so a
 * half-configured profile fails loudly on the first use, not on the first
 * request.
 */
export function requireEnvVars(names: readonly string[], subject: string): Record<string, string> {
	const env: Record<string, string> = {};
	const missing: string[] = [];
	for (const name of names) {
		const value = process.env[name]?.trim();
		if (value) env[name] = value;
		else missing.push(name);
	}
	if (missing.length > 0) {
		throw new Error(`${subject}: ${missing.join(", ")} not set — add ${missing.length === 1 ? "it" : "them"} to ${ENV_SOURCE}`);
	}
	return env;
}
