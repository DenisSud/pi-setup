/**
 * bash-background — background bash execution for pi
 *
 * Overrides the `bash` tool with an optional `run_in_background` flag.
 * Background jobs are spawned detached via pi's own local shell backend
 * (`createLocalBashOperations`), so shell resolution, env, and process
 * handling match the built-in tool.
 *
 * The model manages jobs the way a developer manages a background process:
 * no management tools, just the pid and a log file.
 *
 *   - `bash({ command, run_in_background: true })` returns immediately with
 *     `{ backgroundId, pid, logFile }` in details.
 *   - The pid is the actual command process for simple commands (bash -c
 *     exec-optimizes), or the process-group leader for compound commands.
 *     Children share the process group, so:
 *       `kill -TERM -<pid>`  terminate the whole tree
 *       `kill -USR1 <pid>`   send any signal
 *       `ps -p <pid>`        inspect
 *       `kill -0 <pid>`      probe
 *   - stdout/stderr stream into `logFile` (kept until session end); the model
 *     tails/greps it with plain bash or read.
 *   - When the job finishes, a follow-up notification with the output tail is
 *     delivered and fed back into the agent loop as a user message: it starts
 *     a new turn when idle (triggerTurn) and queues a continuation while
 *     streaming (verified in agent-session.sendCustomMessage + core
 *     messages.convertToLlm: role "custom" → user text).
 *   - Contract: the model never sleep-polls a running job
 *     (`while kill -0 <pid>; do sleep 2; done`); it continues working or ends
 *     its turn, and the completion notification re-invokes it. The tool copy
 *     (parameter description + returned text) states this matter-of-factly —
 *     keep it that way. Exit codes reflect external kills, so the state never
 *     desyncs.
 *   - Background jobs default to a 1h safety-net timeout; pass `timeout` to
 *     override.
 *   - Jobs survive turn aborts; on session shutdown they receive SIGTERM to
 *     the process group, then SIGKILL after a short grace period, and their
 *     log files are removed.
 *
 * Known limitations (inherent to pi's exec-only API):
 *   - A command that backgrounds its own children (`foo &`) is reported
 *     EXITED when the shell exits; any children still alive in the process
 *     group are flagged in the notification and stay manageable via the pid
 *     (and are killed at session shutdown). Output they write after the shell
 *     exited is not captured (pi closes the pipes).
 *   - Unix only: process-group management does not exist on Windows.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

/** Tail size embedded in the completion notification. */
const NOTIFY_TAIL_CHARS = 4000;

/**
 * Safety-net timeout for background jobs (seconds). Background jobs are
 * expected to outlive a single turn, but the model can forget to kill one -
 * the extension enforces a default cap and reports it like any other death.
 * Pass an explicit `timeout` to override (e.g. for long-running training).
 */
const BG_DEFAULT_TIMEOUT_SECONDS = 3600;

/** Grace period between SIGTERM and SIGKILL when shutting down a session. */
const SHUTDOWN_TERM_GRACE_MS = 3000;

interface BgJob {
	id: string;
	command: string;
	/** Command actually spawned: pid-reporting prefix + original command. */
	spawnCommand: string;
	cwd: string;
	/** Temp file where the shell wrote its pid ($$). */
	pidFile: string;
	/** Log file the job's stdout/stderr streams into. */
	logFile: string;
	/** OS pid of the job (the process-group leader). Null until known. */
	pid: number | null;
	exitCode: number | null;
	error: string | null;
	/** True once the job produced any output (for empty-log cleanup). */
	hadOutput: boolean;
	/**
	 * True when the shell exited but the process group still has members
	 * (the command backgrounded its own children). The job stays in the map
	 * so session shutdown still kills the group.
	 */
	lingering: boolean;
	abort: AbortController;
}

export default function (pi: ExtensionAPI) {
	const jobs = new Map<string, BgJob>();
	const logFiles = new Set<string>();
	const pidFiles = new Set<string>();
	const bashOps = createLocalBashOperations();
	let shuttingDown = false;

	/** Strip control characters (except \n \t \r) for display in notifications. */
	function sanitize(text: string): string {
		return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
	}

	async function logTail(job: BgJob): Promise<string> {
		try {
			const buf = await readFile(job.logFile);
			return sanitize(buf.subarray(-NOTIFY_TAIL_CHARS).toString("utf8"));
		} catch {
			return "";
		}
	}

	/** Nicer rendering for exec's timeout rejection (`timeout:<secs>`). */
	function formatError(msg: string): string {
		const m = msg.match(/^timeout:(\d+(?:\.\d+)?)$/);
		return m ? `Command timed out after ${m[1]} seconds` : msg;
	}

	function statusLine(job: BgJob): string {
		// exitCode is null for signal deaths (Node's exit event reports the
		// signal separately and exec discards it) - the model knows which
		// signal it sent, so "EXITED (signal)" is the honest summary.
		// A job that never ran (spawn/timeout validation failure) is FAILED.
		const status = job.error
			? "FAILED"
			: job.exitCode !== null
				? `EXITED (code ${job.exitCode})`
				: "EXITED (signal)";
		let line = `${status} \u00b7 ${job.id}${job.pid ? ` \u00b7 pid ${job.pid}` : ""} \u00b7 ${job.cwd} \u00b7 ${job.command}`;
		if (job.error) line += `\n(error: ${formatError(job.error)})`;
		return line;
	}

	/** True if the job's process group still has at least one live member. */
	function groupAlive(pgid: number): boolean {
		try {
			process.kill(-pgid, 0);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Poll the pid file the shell writes as its first statement. Read FIRST,
	 * then check whether the job settled: a fast job may write the file and
	 * exit within one poll interval, so the early-exit must not shadow the
	 * read. Pid files are kept until session shutdown (removing them at
	 * completion would race the poll for sub-millisecond jobs), so the read
	 * always succeeds once the shell has started. Null on timeout.
	 */
	async function waitForPid(job: BgJob, timeoutMs = 1000): Promise<number | null> {
		const t0 = Date.now();
		for (;;) {
			try {
				const pid = Number((await readFile(job.pidFile, "utf8")).trim());
				if (Number.isInteger(pid) && pid > 1) return pid;
			} catch {
				// pid file not written yet (shell has not started)
			}
			if (job.exitCode !== null || job.error !== null) {
				// Settled without a pid (spawn failure): nothing more to wait for.
				return null;
			}
			if (Date.now() - t0 >= timeoutMs) return null;
			await new Promise((r) => setTimeout(r, 5));
		}
	}

	/**
	 * Inject a custom message with the job result. Works in both states:
	 * - agent streaming: `deliverAs: "followUp"` queues it for after the turn
	 * - agent idle: `deliverAs` is ignored and `triggerTurn: true` starts a
	 *   new turn immediately (verified in agent-session.sendCustomMessage)
	 */
	async function notifyDone(job: BgJob) {
		if (shuttingDown) return;
		const tail = await logTail(job);
		if (shuttingDown) return; // re-check: shutdown may have begun while reading
		const parts: string[] = [statusLine(job)];
		if (tail) parts.push(`\`\`\`\n${tail}\n\`\`\``);
		parts.push(`Full output: ${job.logFile} (kept until session end)`);
		if (job.lingering && job.pid) {
			parts.push(
				`Note: the command backgrounded children that are still running in process group ${job.pid} ` +
					`(\`kill -TERM -${job.pid}\` stops them; output they write after the shell exited is not captured).`,
			);
		}
		pi.sendMessage(
			{
				customType: "bash-bg-result",
				display: true,
				content: parts.join("\n\n"),
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	}

	/**
	 * Start a background job. `createLocalBashOperations()` exposes only
	 * `exec()` (no spawn handle), so we call it WITHOUT awaiting and keep the
	 * AbortController: abort() triggers pi's process-tree kill. Completion
	 * arrives via the promise (pi's waitForChildProcess handles detached
	 * descendants). Output streams to the job's log file. The process is
	 * detached and tracked by pi as a detached child (killed by pi on quit).
	 */
	function startJob(job: BgJob, timeoutSecs: number) {
		const log = createWriteStream(job.logFile, { flags: "a" });
		log.on("error", () => {});
		bashOps
			.exec(job.spawnCommand, job.cwd, {
				onData: (chunk) => {
					job.hadOutput = true;
					log.write(chunk);
				},
				timeout: timeoutSecs,
				// Deliberately our own signal, NOT the tool-call signal:
				// aborting the agent's turn must not kill background jobs.
				signal: job.abort.signal,
			})
			.then(
				async ({ exitCode }) => {
					job.exitCode = exitCode;
					// The shell exited. If the group still has members, the
					// command backgrounded its own children: keep the job in the
					// map (so shutdown still kills the group) and flag it in the
					// notification instead of claiming full completion.
					if (job.pid !== null && groupAlive(job.pid)) {
						job.lingering = true;
					} else {
						jobs.delete(job.id);
					}
					await new Promise((r) => log.end(r)); // flush before tail read
					try {
						await notifyDone(job);
					} catch (err) {
						// A notification failure must never crash the runtime
						// or lose the job entry (map already consistent).
						console.error("bash-background: notifyDone failed", err);
					}
				},
				async (err: unknown) => {
					await new Promise((r) => log.end(r)); // flush before tail read
					jobs.delete(job.id);
					if (!job.hadOutput) {
						// Never ran (cwd/timeout validation failure): no empty
						// log file should outlive the attempt.
						logFiles.delete(job.logFile);
						rm(job.logFile, { force: true }).catch(() => {});
					}
					if (job.abort.signal.aborted) return; // session shutdown
					job.error = err instanceof Error ? err.message : String(err);
					try {
						await notifyDone(job);
					} catch (notifyErr) {
						console.error("bash-background: notifyDone failed", notifyErr);
					}
				},
			);
	}

	// ── bash override ─────────────────────────────────────────────────────

	// Built-in definition: keeps the built-in foreground behavior (streaming
	// partial updates, truncation to temp file, exit-code error formatting,
	// and TUI rendering) intact. We only add the background branch.
	const localBash = createBashTool(process.cwd());

	pi.registerTool({
		...localBash,
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
			timeout: Type.Optional(
				Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
			),
			run_in_background: Type.Optional(
				Type.Boolean({
					description:
						"Start the command detached and return immediately. " +
						"Details include backgroundId, pid, and logFile. " +
						"The pid is the actual command process for simple commands, or the process-group leader " +
						"for compound commands (children share the group). Manage it with plain bash: " +
						"`kill -TERM -<pid>` terminates the whole tree, `kill -USR1 <pid>` sends any signal, " +
						"`ps -p <pid>` inspects, `kill -0 <pid>` probes. " +
						"Continue with other work or end your turn; when the job finishes, a follow-up notification " +
						"with the output tail is delivered and starts a new turn, so the result is fed back to you " +
						"like any other tool result. " +
						"Output streams to logFile (kept until session end) - tail or grep it anytime. " +
						"Background jobs default to a 1h safety-net timeout (pass `timeout` to override, e.g. for " +
						"long-running training); on timeout the job is terminated and reported like any exit. " +
						"If the command backgrounded its own children, the notification flags them and they " +
						"remain manageable via the pid (their post-exit output is not captured). " +
						"Jobs survive turn aborts; on session shutdown they get SIGTERM, then SIGKILL after a grace period. " +
						"Unix only.",
				}),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (!params.run_in_background) {
				// Foreground: delegate to the built-in bash tool untouched.
				// Created per call so the session cwd (ctx.cwd) is honored even
				// when pi was launched from a different directory.
				return createBashTool(ctx.cwd).execute(
					toolCallId,
					{ command: params.command, timeout: params.timeout },
					signal,
					onUpdate,
				);
			}

			const id = randomUUID().slice(0, 8);
			if (process.platform === "win32") {
				// Process-group management (kill -TERM -<pid>, $$ pid capture)
				// is POSIX-only; the whole contract would silently degrade.
				throw new Error("run_in_background is only supported on Unix (process-group management requires POSIX signals)");
			}
			const pidFile = join(tmpdir(), `pi-bg-${id}.pid`);
			const logFile = join(tmpdir(), `pi-bg-${id}.log`);
			const job: BgJob = {
				id,
				command: params.command,
				// The shell writes its own pid first so the extension (and thus
				// the model) can report it. Pure prefix: no quoting of the
				// original command needed. bash -c exec-optimizes simple
				// commands, so the pid is usually the command process itself.
				spawnCommand: `echo $$ > ${JSON.stringify(pidFile)}; ${params.command}`,
				cwd: ctx.cwd,
				pidFile,
				logFile,
				pid: null,
				exitCode: null,
				error: null,
				hadOutput: false,
				lingering: false,
				abort: new AbortController(),
			};
			jobs.set(id, job);
			logFiles.add(logFile);
			pidFiles.add(pidFile);
			startJob(job, params.timeout ?? BG_DEFAULT_TIMEOUT_SECONDS);
			job.pid = await waitForPid(job);

			const manageHints = job.pid
				? `\n\nContinue working or end your turn; you will be re-invoked with the output when it ` +
					`finishes. Kill the whole tree: \`kill -TERM -${job.pid}\`. Any signal: \`kill -SIGNAME ${job.pid}\`.`
				: "";
			return {
				content: [
					{
						type: "text",
						text:
							`Started background job \`${id}\`` +
							(job.pid ? ` (pid ${job.pid})` : "") +
							`: ${params.command}` +
							`\n\nOutput: ${logFile} (tail/grep it anytime; kept until session end).` +
							manageHints +
							`\n\nYou will be re-invoked with the output tail when it finishes.`,
					},
				],
				details: { backgroundId: id, pid: job.pid, logFile },
			};
		},
	});

	// ── cleanup ───────────────────────────────────────────────────────────

	// Fired on quit, /reload, and session switch (new/resume/fork) - the
	// runtime is torn down afterwards, so any still-running job must die.
	// The event is awaited by the runtime (verified in agent-session-runtime:
	// teardownCurrent/dispose await emitSessionShutdownEvent), so the
	// TERM-grace-KILL sequence runs to completion. SIGTERM to the process
	// group gives jobs a chance to flush/clean up (same signal a developer
	// would send with `kill -TERM -<pid>`); stragglers get SIGKILL via
	// abort() (pi's killProcessTree), which also settles the exec promise.
	// Log files from all jobs (finished or not) are removed afterwards.
	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		for (const job of jobs.values()) {
			if (job.pid) {
				try {
					process.kill(-job.pid, "SIGTERM");
				} catch {
					// already dead - its completion handler will settle it
				}
			} else {
				// pid unknown (spawn failed early): nothing to signal
				job.abort.abort();
			}
		}
		if (jobs.size > 0) {
			await new Promise((r) => setTimeout(r, SHUTDOWN_TERM_GRACE_MS));
		}
		for (const job of jobs.values()) job.abort.abort();
		// Lingering jobs (shell exited, children left) have no pending exec
		// promise - their groups are dead now, so drop them before draining.
		for (const job of jobs.values()) {
			if (job.lingering) jobs.delete(job.id);
		}
		// Drain: completion handlers run as the exec promises settle (they
		// clean up pidfiles and remove jobs from the map). Bound the wait so
		// a wedged child cannot hang session teardown.
		const drainDeadline = Date.now() + 5000;
		while (jobs.size > 0 && Date.now() < drainDeadline) {
			await new Promise((r) => setTimeout(r, 20));
		}
		await Promise.all([...logFiles].map((f) => rm(f, { force: true }).catch(() => {})));
		logFiles.clear();
		await Promise.all([...pidFiles].map((f) => rm(f, { force: true }).catch(() => {})));
		pidFiles.clear();
	});
}
