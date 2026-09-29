/**
 * ptc built-ins — script-friendly read/grep/find/sh.
 *
 * These are ptc-owned: they exist only inside ptc programs (not as direct pi
 * tools), so their JSON shapes are documented in the ptc tool description
 * (see index.ts — that is their only documentation). Structured JSON in/out,
 * no prose rendering, truncation always flagged so programs can page.
 *
 * All sizes are chars/bytes caps, not model tokens: the ptc output cap
 * (head+tail) is the final safety net.
 *
 * `sh` is a boilerplate-removal convenience, not a capability addition: a ptc
 * program can already `await import("node:child_process")` and spawn anything
 * (same trust level as the bash tool). It exists because every program that
 * probes the shell re-rolls a try/catch wrapper around execSync, and a
 * hanging command should not stall the whole tool. Never throws on nonzero
 * exit — exit status is data.
 */

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { registerPtcTool } from "./registry.ts";

/** Cap for a single `read` without offset/limit (2 MiB is generous for code/data files). */
const READ_MAX_BYTES = 2 * 1024 * 1024;
/** Line-window reads (offset/limit) refuse files above this — streaming windows are v2. */
const READ_WINDOW_MAX_BYTES = 64 * 1024 * 1024;
/** Default cap on grep matches returned. */
const GREP_MAX_MATCHES = 200;
/** Hard cap on grep matches returned. */
const GREP_MAX_MATCHES_HARD = 5000;
/** Cap on grep file size (skip binaries/huge files). */
const GREP_MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Cap on find paths returned. */
const FIND_MAX_PATHS = 2000;
/** Dirent walk doesn't descend into these. */
const SKIP_DIRS = new Set([".git", "node_modules"]);
/** Default timeout for `sh` commands (a hang must not stall the whole tool). */
const SH_DEFAULT_TIMEOUT_MS = 30_000;
/** Default per-stream output cap for `sh`. */
const SH_MAX_OUTPUT_CHARS = 200_000;

function statOrNull(path: string) {
	return stat(path).catch(() => null);
}

/** Count "\n" via stream — safe for huge files. */
function countLines(path: string): Promise<number> {
	return new Promise((resolveCount, reject) => {
		let count = 0;
		createReadStream(path)
			.on("data", (chunk: Buffer) => {
				for (const b of chunk) if (b === 0x0a) count++;
			})
			.on("end", () => resolveCount(count))
			.on("error", reject);
	});
}

function noSuchFile(what: string, path: string): Error & { code: string } {
	const err = new Error(`${what}: no such file: ${path}`) as Error & { code: string };
	err.code = "ENOENT";
	return err;
}

registerPtcTool(
	"sh",
	async (args) => {
		const command = String(args.command ?? "");
		if (!command.trim()) throw new Error("sh: command is required");
		const timeoutMs = Math.max(1, Math.round(Number(args.timeout_ms ?? SH_DEFAULT_TIMEOUT_MS)));
		const maxOutput = Math.max(1, Math.round(Number(args.max_output ?? SH_MAX_OUTPUT_CHARS)));
		const cwd = args.cwd != null ? String(args.cwd) : process.cwd();

		return await new Promise((resolve, reject) => {
			const child = spawn(command, { shell: true, cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			let truncated = false;
			let timedOut = false;
			let settled = false;
			const append = (acc: () => string, set: (s: string) => void, chunk: Buffer) => {
				if (acc().length >= maxOutput) {
					truncated = true;
					return;
				}
				let next = acc() + chunk.toString();
				if (next.length > maxOutput) {
					next = next.slice(0, maxOutput);
					truncated = true;
				}
				set(next);
			};
			child.stdout.on("data", (c: Buffer) => append(() => stdout, (s) => (stdout = s), c));
			child.stderr.on("data", (c: Buffer) => append(() => stderr, (s) => (stderr = s), c));
			const timer = setTimeout(() => {
				timedOut = true;
				try {
					child.kill("SIGKILL");
				} catch {
					// already dead
				}
			}, timeoutMs);
			child.on("error", (e) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(e);
			});
			child.on("close", (code, signal) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve({ stdout, stderr, code, signal, timed_out: timedOut, truncated });
			});
		});
	},
	{
		signature:
			"sh({ command, timeout_ms?, max_output?, cwd? }) → { stdout, stderr, code, signal, timed_out, truncated } — never throws on nonzero exit; default timeout 30 s, default output cap 200k chars/stream",
	},
);

registerPtcTool(
	"read",
	async (args) => {
		const path = resolve(String(args.path ?? ""));
		const offset = args.offset != null ? Math.max(1, Math.round(Number(args.offset))) : undefined; // 1-indexed line
		const limit = args.limit != null ? Math.max(1, Math.round(Number(args.limit))) : undefined;

		const fstat = await statOrNull(path);
		if (!fstat || !fstat.isFile()) throw noSuchFile("read", path);
		const total_lines = await countLines(path);

		let content: string;
		let truncated: boolean;
		if (offset != null || limit != null) {
			if (fstat.size > READ_WINDOW_MAX_BYTES) {
				throw new Error(
					`read: file is ${fstat.size} bytes; line-window reads (offset/limit) are capped at ${READ_WINDOW_MAX_BYTES}`,
				);
			}
			const lines = (await readFile(path, "utf8")).split("\n");
			const start = (offset ?? 1) - 1;
			const end = limit != null ? start + limit : lines.length;
			content = lines.slice(start, end).join("\n");
			truncated = end < lines.length;
		} else if (fstat.size > READ_MAX_BYTES) {
			// Too big to hand over whole: give the head chunk, flag truncation.
			content = (await readFile(path, "utf8")).slice(0, READ_MAX_BYTES);
			truncated = true;
		} else {
			content = await readFile(path, "utf8");
			truncated = false;
		}
		return { path, content, truncated, total_bytes: fstat.size, total_lines };
	},
	{
		signature: "read({ path, offset?, limit? }) → { path, content, truncated, total_bytes, total_lines }",
	},
);

registerPtcTool(
	"grep",
	async (args) => {
		const pattern = String(args.pattern ?? "");
		if (!pattern) throw new Error("grep: pattern is required");
		let re: RegExp;
		try {
			re = new RegExp(pattern, args.ignore_case ? "i" : "");
		} catch (e) {
			throw new Error(`grep: invalid regex ${JSON.stringify(pattern)}: ${e instanceof Error ? e.message : e}`);
		}
		const root = resolve(String(args.path ?? process.cwd()));
		const maxMatches = Math.min(
			GREP_MAX_MATCHES_HARD,
			Math.max(1, Math.round(Number(args.max_matches ?? GREP_MAX_MATCHES))),
		);

		const rootStat = await statOrNull(root);
		if (!rootStat) throw new Error(`grep: no such path: ${root}`);

		const files: string[] = [];
		async function walk(dir: string): Promise<void> {
			let entries;
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				return; // unreadable dir — skip
			}
			for (const entry of entries) {
				if (SKIP_DIRS.has(entry.name)) continue;
				const full = join(dir, entry.name);
				if (entry.isDirectory()) await walk(full);
				else if (entry.isFile()) files.push(full);
			}
		}
		if (rootStat.isDirectory()) await walk(root);
		else files.push(root);

		const matches: { path: string; line: number; text: string }[] = [];
		let totalMatches = 0;
		let truncated = false;
		for (const file of files) {
			const fstat = await statOrNull(file);
			if (!fstat || fstat.size > GREP_MAX_FILE_BYTES) continue;
			let text: string;
			try {
				text = await readFile(file, "utf8");
			} catch {
				continue; // binary or unreadable — skip
			}
			const lines = text.split("\n");
			for (let i = 0; i < lines.length; i++) {
				if (!re.test(lines[i])) continue;
				totalMatches++;
				if (matches.length < maxMatches) {
					matches.push({ path: relative(root, file) || basename(file), line: i + 1, text: lines[i] });
				} else {
					truncated = true;
					break;
				}
			}
			if (truncated) break;
		}
		return { matches, truncated, total_matches: totalMatches };
	},
	{
		signature:
			"grep({ pattern, path?, ignore_case?, max_matches? }) → { matches: {path,line,text}[], truncated, total_matches }",
	},
);

registerPtcTool(
	"find",
	async (args) => {
		const pattern = String(args.pattern ?? "");
		if (!pattern) throw new Error("find: pattern is required (regex matched against relative paths)");
		let re: RegExp;
		try {
			re = new RegExp(pattern);
		} catch (e) {
			throw new Error(`find: invalid regex ${JSON.stringify(pattern)}: ${e instanceof Error ? e.message : e}`);
		}
		const root = resolve(String(args.path ?? process.cwd()));
		const type = args.type != null ? String(args.type) : undefined; // "file" | "dir"

		const rootStat = await statOrNull(root);
		if (!rootStat) throw new Error(`find: no such path: ${root}`);

		const typeOk = (isFile: boolean) =>
			type == null || (type === "file" && isFile) || (type === "dir" && !isFile);

		const paths: string[] = [];
		let total = 0;
		let truncated = false;
		const push = (rel: string, isFile: boolean): void => {
			if (!typeOk(isFile) || !re.test(rel)) return;
			total++;
			if (paths.length < FIND_MAX_PATHS) paths.push(rel);
			else truncated = true;
		};
		async function walk(dir: string): Promise<void> {
			if (truncated) return;
			let entries;
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				if (SKIP_DIRS.has(entry.name)) continue;
				const full = join(dir, entry.name);
				const rel = relative(root, full);
				if (entry.isDirectory()) {
					push(rel, false);
					await walk(full);
				} else {
					push(rel, true);
				}
				if (truncated) return;
			}
		}
		if (rootStat.isFile()) push(".", true);
		else await walk(root);
		return { paths, truncated, total };
	},
	{
		signature: "find({ pattern, path?, type? }) → { paths: string[], truncated, total }",
	},
);
