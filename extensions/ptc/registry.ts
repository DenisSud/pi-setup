/**
 * ptc registry — the only file other extensions import.
 *
 * `registerPtcTool(name, run, opts?)` opts a tool into programmatic calling:
 * the `ptc` tool exposes it to generated programs as a global async function
 * with that exact name. One line per tool, owned by the extension that owns
 * the tool. No descriptions, no schemas here — the tool's existing docs in
 * the system prompt stay the single source of truth; `opts.signature` is an
 * optional one-line binding contract (args → result shape) for shapes the
 * direct docs don't state.
 *
 * Registration is idempotent (last write wins): extension factories re-run
 * on /reload, and the module cache may or may not be re-evaluated, so a
 * duplicate must never throw.
 */

export type PtcArgs = Record<string, unknown>;
export type PtcRun = (args: PtcArgs, ctx: unknown) => unknown | Promise<unknown>;

export interface PtcRegistration {
	name: string;
	run: PtcRun;
	/** One-line binding contract, e.g. "{ query, max_results? } → { query, results: [...] }". */
	signature?: string;
}

const registry = new Map<string, PtcRegistration>();

export function registerPtcTool(name: string, run: PtcRun, opts?: { signature?: string }): void {
	registry.set(name, { name, run, signature: opts?.signature });
}

export function listPtcTools(): PtcRegistration[] {
	return [...registry.values()];
}

export function getPtcTool(name: string): PtcRegistration | undefined {
	return registry.get(name);
}
