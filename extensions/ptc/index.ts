/**
 * ptc — programmatic tool calling for pi.
 *
 * One tool, one param: `code` (JavaScript, top-level await). The program calls
 * ptc-eligible tools as global async functions with their exact names; each
 * call resolves to the tool's result (structured JSON for the built-ins).
 * Only the program's printed output is returned to the model — intermediate
 * tool results never enter context.
 *
 * Design + decisions: SPEC.md (read before changing contracts here).
 *
 * Mechanics:
 *   - The program runs in a Node child process (same trust level as bash).
 *   - Protocol: JSON lines over the child's stdout/stdin. The child sends
 *     {type:"call", id, name, args}; the parent runs the registered
 *     implementation and answers {id, ok, value|error}. The child sends
 *     {type:"done", ok, output, stderr?, error?} exactly once at the end.
 *   - console.log/error are captured inside the child (never touch the
 *     protocol); `print` is an alias for console.log.
 *   - Hard timeout (PTC_TIMEOUT_MS, default 120 s) and tool-call cap
 *     (PTC_MAX_TOOL_CALLS, default 500) keep runaway programs bounded.
 *   - Output is head+tail capped for the LLM; the full output is written to a
 *     temp file whose path is reported in the result.
 *   - The tool registers in `session_start` so the description can list the
 *     final registry (all extension factories have run by then).
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getPtcTool, listPtcTools } from "./registry.ts";
import "./builtin.ts";

/** Head+tail cap on the text returned to the model (full output → file). */
const LLM_OUTPUT_CHARS = 30_000;

/** Timeout / call cap read at call time so tests (and future settings) can tune per run. */
const timeoutMs = () => Number(process.env.PTC_TIMEOUT_MS) || 120_000;
const maxToolCalls = () => Number(process.env.PTC_MAX_TOOL_CALLS) || 500;

// ── child program assembly ─────────────────────────────────────────────────

/** Child-side prelude: protocol + captured console + global tool bindings. */
function prelude(names: string[]): string {
	return `import { createInterface } from "node:readline";
import { format } from "node:util";

const TOOL_NAMES = ${JSON.stringify(names)};

const __out = [];
const __errOut = [];
const fmt = (v) => (typeof v === "string" ? v : format(v));
console.log = console.info = (...a) => __out.push(a.map(fmt).join(" "));
console.error = console.warn = (...a) => __errOut.push(a.map(fmt).join(" "));
console.debug = console.trace = () => {};
const print = console.log;

let __seq = 0;
const __pending = new Map();
function __send(m) { process.stdout.write(JSON.stringify(m) + "\\n"); }
const __rl = createInterface({ input: process.stdin });
__rl.on("line", (line) => {
  if (!line.trim()) return;
  let m; try { m = JSON.parse(line); } catch { return; }
  const p = __pending.get(m.id);
  if (!p) return;
  __pending.delete(m.id);
  if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error));
});
function __call(name, args) {
  const id = ++__seq;
  return new Promise((resolve, reject) => {
    __pending.set(id, { resolve, reject });
    __send({ type: "call", id, name, args: args ?? {} });
  });
}
for (const n of TOOL_NAMES) globalThis[n] = (args) => __call(n, args);

let __finished = false;
function __finish(ok, err) {
  if (__finished) return;
  __finished = true;
  __send({ type: "done", ok, output: __out.join("\\n"), stderr: __errOut.join("\\n"), error: err ? String(err?.stack ?? err) : undefined });
  process.exit(0);
}
process.on("unhandledRejection", (e) => __finish(false, e));
process.on("uncaughtException", (e) => __finish(false, e));
process.on("uncaughtExceptionMonitor", (e) => __finish(false, e));
globalThis.__ptc_finish = () => __finish(true);
`;
}

function buildProgram(names: string[], code: string): string {
	return (
		prelude(names) +
		"\n// ── user program ──\n" +
		`(async () => {\n${code}\n})()` +
		".then(() => __ptc_finish())" +
		".catch((e) => __finish(false, e));\n"
	);
}

// ── output shaping ──────────────────────────────────────────────────────────

function headTailCap(text: string, cap = LLM_OUTPUT_CHARS): { text: string; capped: boolean } {
	if (text.length <= cap) return { text, capped: false };
	const half = Math.floor(cap / 2);
	const dropped = text.length - cap;
	return {
		text: `${text.slice(0, half)}\n… [${dropped} chars dropped — full output written to file] …\n${text.slice(-half)}`,
		capped: true,
	};
}

// ── the tool ────────────────────────────────────────────────────────────────

interface PtcDone {
	type: "done";
	ok: boolean;
	output: string;
	stderr: string;
	error?: string;
}

function errorResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {}, isError: true as const };
}

async function runProgram(code: string, signal: AbortSignal | undefined, ctx: unknown) {
	const TIMEOUT_MS = timeoutMs();
	const MAX_TOOL_CALLS = maxToolCalls();
	const names = listPtcTools().map((t) => t.name);
	if (names.length === 0) throw new Error("ptc: no tools registered — nothing to call from a program");

	const dir = await mkdtemp(join(tmpdir(), "ptc-"));
	const progPath = join(dir, "program.mjs");
	await writeFile(progPath, buildProgram(names, code));

	const child = spawn(process.execPath, [progPath], {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: dir,
		env: process.env,
	});

	let done: PtcDone | null = null;
	let toolCalls = 0;
	let stderrTail = "";
	const childStdin = child.stdin;
	let settled = false;

	const kill = () => {
		try {
			child.kill("SIGKILL");
		} catch {
			// already dead
		}
	};
	const onAbort = () => kill();
	signal?.addEventListener("abort", onAbort, { once: true });

	const finished = new Promise<PtcDone>((resolve, reject) => {
		const rl = createInterface({ input: child.stdout });
		rl.on("line", (line) => {
			if (!line.trim()) return;
			let msg: (PtcDone | { type: "call"; id: number; name: string; args: Record<string, unknown> }) | null = null;
			try {
				msg = JSON.parse(line);
			} catch {
				return;
			}
			if (!msg) return;
			if (msg.type === "done") {
				done = msg;
				return;
			}
			if (msg.type === "call") {
				if (toolCalls >= MAX_TOOL_CALLS) {
					childStdin.write(
						JSON.stringify({ id: msg.id, ok: false, error: `ptc: tool call limit exceeded (${MAX_TOOL_CALLS})` }) + "\n",
					);
					return;
				}
				toolCalls++;
				const reg = getPtcTool(msg.name);
				if (!reg) {
					childStdin.write(JSON.stringify({ id: msg.id, ok: false, error: `ptc: no tool registered as ${JSON.stringify(msg.name)}` }) + "\n");
					return;
				}
				Promise.resolve()
					.then(() => reg.run(msg.args, ctx))
					.then((value) => {
						childStdin.write(JSON.stringify({ id: msg.id, ok: true, value: value ?? null }) + "\n");
					})
					.catch((err: unknown) => {
						childStdin.write(
							JSON.stringify({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) }) + "\n",
						);
					});
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderrTail = ((stderrTail + chunk.toString()) as string).slice(-4000);
		});
		child.on("error", (err) => {
			settled = true;
			reject(err);
		});
		const watchdog = setTimeout(() => {
			if (settled) return;
			settled = true;
			kill();
			reject(new Error(`ptc: program timed out after ${TIMEOUT_MS} ms`));
		}, TIMEOUT_MS);
		child.on("close", (codeNum) => {
			clearTimeout(watchdog);
			if (settled) return;
			settled = true;
			if (done) return resolve(done);
			if (signal?.aborted) return reject(new Error("ptc: aborted"));
			return reject(
				new Error(`ptc: program exited (code ${codeNum}) without finishing${stderrTail ? `; stderr: ${stderrTail.trim()}` : ""}`),
			);
		});
	});

	try {
		const result = await finished;
		return { result, toolCalls };
	} finally {
		signal?.removeEventListener("abort", onAbort);
		kill();
	}
}

function buildDescription(names: string[]): string {
	const builtinSigs = ["read", "grep", "find"]
		.map((n) => getPtcTool(n)?.signature)
		.filter((s): s is string => Boolean(s));
	const builtinsBlock = builtinSigs.length ? `Built-ins (structured JSON):\n${builtinSigs.map((s) => `- ${s}`).join("\n")}\n` : "";
	const others = names.filter((n) => n !== "read" && n !== "grep" && n !== "find");
	const othersBlock = others.length
		? `Registered tools (args = that tool's input schema; result = whatever the tool returns):\n${others
				.map((n) => {
					const sig = getPtcTool(n)?.signature;
					return `- ${n}${sig ? ` → ${sig}` : ""}`;
				})
				.join("\n")}\n`
		: "";
	return [
		"Run a JavaScript program (top-level await) that calls tools as async functions; the program's printed output (console.log / print) is the result. Intermediate tool results never enter context — filter and aggregate them in code.",
		"",
		builtinsBlock,
		othersBlock,
		"Errors from tools reject the awaited promise — handle or retry them in code. Parallel calls with Promise.all.",
		"Prefer ptc for fan-out, filtering, or many calls; use direct tool calls for single lookups and steps that need judgment between calls.",
	]
		.filter((s) => s !== undefined)
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export default function ptcExtension(pi: ExtensionAPI) {
	pi.on("session_start", () => {
		const names = listPtcTools().map((t) => t.name);
		pi.registerTool({
			name: "ptc",
			label: "PTC",
			description: buildDescription(names),
			promptSnippet: "Run a JS program that calls tools as async functions (fan-out / filter / aggregate in code)",
			promptGuidelines: [
				"Use ptc when a task needs many tool calls whose results can be filtered or aggregated in code (search fan-out, batch lookups, large result sets); use direct tool calls for single lookups and steps that need judgment between calls.",
			],
			parameters: Type.Object({
				code: Type.String({
					description:
						"JavaScript program (top-level await). Available tools are global async functions — see the tool description for exact names and shapes.",
				}),
			}),
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				if (!params.code?.trim()) return errorResult("ptc: `code` is empty");
				try {
					const { result, toolCalls } = await runProgram(params.code, signal, ctx);
					const raw = result.ok
						? result.output
						: `${result.output}${result.output ? "\n\n" : ""}Program error: ${result.error ?? "unknown error"}${
								result.stderr ? `\nProgram stderr:\n${result.stderr}` : ""
							}`;
					const { text, capped } = headTailCap(raw);
					let fullOutputPath: string | undefined;
					if (capped) {
						fullOutputPath = join(tmpdir(), `ptc-output-${Date.now()}.txt`);
						await writeFile(fullOutputPath, raw).catch(() => undefined);
					}
					if (result.stderr && result.ok) {
						// Program succeeded but printed to stderr — surface a tail so the model isn't blind to warnings.
						const tail = result.stderr.length > 2000 ? `…${result.stderr.slice(-2000)}` : result.stderr;
						return {
							content: [{ type: "text" as const, text: `${text}\n\nProgram stderr:\n${tail}` }],
							details: { ok: true, toolCalls, outputChars: raw.length, fullOutputPath },
						};
					}
					if (!result.ok) {
						return { content: [{ type: "text" as const, text }], details: { ok: false, toolCalls }, isError: true as const };
					}
					return { content: [{ type: "text" as const, text }], details: { ok: true, toolCalls, outputChars: raw.length, fullOutputPath } };
				} catch (err) {
					const msg = err instanceof Error ? err.message : format(err);
					return errorResult(msg);
				}
			},
		});
	});
}
