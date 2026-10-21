/**
 * lib/exposure — how much of a tool the model sees.
 *
 * A tool registered `direct` is declared in every request, so its description
 * and guidelines are prompt cost. `deferred` and `codemode` keep it callable
 * from a codemode script (`tools.<name>(…)`) without declaring it; `deferred`
 * is the quietest, because codemode's own description does not list it either.
 *
 * Why a variable and not a key in each extension's config file: exposure is a
 * property of the whole session (the minimal profile runs every tool this way),
 * and one value cannot drift across four files. Service settings stay where
 * they were — `gmail.json`, `calendar.json`.
 */

export type ToolExposure = "direct" | "codemode" | "deferred" | "hidden";

const EXPOSURES: readonly ToolExposure[] = ["direct", "codemode", "deferred", "hidden"];

/**
 * Exposure for this package's tools. Unset means `direct`, which is pi's own
 * default and what the daily profile uses. An unknown value is a hard error:
 * a typo would otherwise silently leave the tools declared, and the profile
 * would look minimal while costing the same prompt.
 */
export function toolExposure(): ToolExposure {
	const raw = process.env.PI_TOOL_EXPOSURE?.trim();
	if (!raw) return "direct";
	const match = EXPOSURES.find((value) => value === raw);
	if (!match) {
		throw new Error(
			`PI_TOOL_EXPOSURE=${JSON.stringify(raw)} is not a tool exposure — use one of ${EXPOSURES.join(", ")}`,
		);
	}
	return match;
}
