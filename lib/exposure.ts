/**
 * lib/exposure — how much of a tool the model sees.
 *
 * A tool registered `direct` is declared in every request, so its description
 * and guidelines are prompt cost. `deferred` and `codemode` keep it callable
 * from a codemode script (`tools.<name>(…)`) without declaring it; `deferred`
 * is the quietest, because codemode's own description does not list it either.
 *
 * Why a variable and not a key in each extension's config file: exposure is a
 * property of the whole session (every tool in this package ships this way),
 * and one value cannot drift across four files. Service settings stay where
 * they were — `gmail.json`, `calendar.json`.
 */

export type ToolExposure = "direct" | "codemode" | "deferred" | "hidden";

const EXPOSURES: readonly ToolExposure[] = ["direct", "codemode", "deferred", "hidden"];

/**
 * Exposure for this package's tools. Unset means `deferred`: the tools are
 * called from codemode scripts and never declared, which is the whole point of
 * this package. `PI_TOOL_EXPOSURE=direct` declares them in every request
 * (pi's own default) for a session that should not need a script. An unknown
 * value is a hard error: a typo would otherwise silently pick one of the two,
 * and the session would look script-only while costing a full prompt.
 */
export function toolExposure(): ToolExposure {
	const raw = process.env.PI_TOOL_EXPOSURE?.trim();
	if (!raw) return "deferred";
	const match = EXPOSURES.find((value) => value === raw);
	if (!match) {
		throw new Error(
			`PI_TOOL_EXPOSURE=${JSON.stringify(raw)} is not a tool exposure — use one of ${EXPOSURES.join(", ")}`,
		);
	}
	return match;
}
