/**
 * Harness tests for the bash-background extension.
 *
 * Drives the extension's registered tools directly with a stubbed
 * ExtensionAPI, using the REAL pi runtime code (createLocalBashOperations,
 * the built-in bash tool) — so spawn, detached process groups, tree kills,
 * and notification logic are exercised against actual pi internals, not mocks.
 *
 * Management is exercised exactly the way the model uses it: plain bash calls
 * with the pid (`kill -TERM -<pid>`, `kill -USR1 <pid>`, `kill -0` wait loop)
 * plus the log file. No management tools exist to test.
 *
 * Includes red-team findings: fast-job pid capture, backgrounded-children
 * (lingering group) handling, empty-log cleanup, notification-failure
 * containment.
 *
 * Run: node test/harness.mjs   (Node >= 23.6, native TS type stripping)
 * Requires node_modules symlinks set up by run.sh.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import createExtension from "../index.ts";

// ── tiny test runner ──────────────────────────────────────────────────────

const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
	tests.push({ name, fn });
}

async function runTests() {
	for (const t of tests) {
		try {
			await t.fn();
			passed++;
			console.log(`  ok    ${t.name}`);
		} catch (err) {
			failed++;
			console.error(`  FAIL  ${t.name}`);
			console.error(`        ${String(err.message).split("\n").slice(0, 6).join("\n        ")}`);
		}
	}
	console.log(`\n${passed}/${tests.length} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
}

function assert(cond, msg) {
	if (!cond) throw new Error(msg || "assertion failed");
}

function assertRejects(promise, pattern, msg) {
	return promise.then(
		() => {
			throw new Error(msg || `expected rejection matching ${pattern}`);
		},
		(err) => {
			if (pattern && !pattern.test(String(err?.message))) {
				throw new Error(`rejected with ${err?.message}, expected ${pattern}`);
			}
		},
	);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 15000, interval = 50 } = {}) {
	const t0 = Date.now();
	for (;;) {
		const v = fn();
		if (v) return v;
		if (Date.now() - t0 > timeout) throw new Error(`waitFor timed out after ${timeout}ms`);
		await sleep(interval);
	}
}

const isAlive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

// pgrep that does not match its own wrapper shell ([x] bracket trick)
function pgrep(pattern) {
	try {
		return execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" })
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(Number);
	} catch {
		return [];
	}
}

// ── harness setup ─────────────────────────────────────────────────────────

function makePi() {
	const tools = new Map();
	const sent = [];
	const handlers = new Map();
	const api = {
		registerTool: (tool) => tools.set(tool.name, tool),
		sendMessage: (message, options) => sent.push({ message, options }),
		on: (event, handler) => handlers.set(event, handler),
		getActiveTools: () => [...tools.keys()],
	};
	return { api, tools, sent, handlers };
}

function makeCtx(cwd) {
	return {
		cwd,
		model: undefined,
		thinkingLevel: undefined,
		sessionManager: {
			getSessionId: () => "test-session",
			getSessionFile: () => undefined,
		},
	};
}

const harness = makePi();
createExtension(harness.api);

const bash = harness.tools.get("bash");
const shutdownHandler = harness.handlers.get("session_shutdown");

assert(bash, "bash tool registered (override)");
assert(!harness.tools.has("bash_output"), "no bash_output tool (management is plain bash)");
assert(!harness.tools.has("bash_kill"), "no bash_kill tool (management is plain bash)");
assert(shutdownHandler, "session_shutdown handler registered");

const workDir = await mkdtemp(join(tmpdir(), "bgtest-"));
const ctx = makeCtx(workDir);
let tagCounter = 0;
const tag = () => `t${++tagCounter}`;

const notifFor = (needle) =>
	harness.sent.find((m) => m.message.customType === "bash-bg-result" && m.message.content.includes(needle));

/** Background start; tracks the id for the final leftover-file check. */
const allJobIds = [];
const runBg = (command, extra = {}) => {
	const res = bash.execute(
		`call-${tag()}`,
		{ command, run_in_background: true, ...extra },
		undefined,
		undefined,
		ctx,
	);
	res.then((r) => r.details?.backgroundId && allJobIds.push(r.details.backgroundId)).catch(() => {});
	return res;
};

/** A plain foreground bash call through the extension — how the model manages jobs. */
const runFg = (command, timeout) =>
	bash.execute(`fg-${tag()}`, { command, ...(timeout ? { timeout } : {}) }, undefined, undefined, ctx);

// ── tests ─────────────────────────────────────────────────────────────────

test("foreground bash still works (delegates to built-in)", async () => {
	const res = await runFg("echo hello-fg");
	assert(res.content[0].text.includes("hello-fg"), "stdout passthrough");
	// Built-in only sets details when output is truncated; small output -> undefined.
	assert(res.details === undefined, "no details for untruncated output");

	await assertRejects(runFg("exit 3"), /exited with code 3/, "non-zero exit must surface as error");
});

test("foreground timeout is enforced", async () => {
	const t0 = Date.now();
	await assertRejects(runFg("sleep 5", 1), /timed out after 1 seconds/, "timeout must abort the command");
	assert(Date.now() - t0 < 4000, `timeout must fire fast (took ${Date.now() - t0}ms)`);
});

test("foreground respects pre-aborted signal", async () => {
	const ac = new AbortController();
	ac.abort();
	await assertRejects(
		bash.execute("fg4", { command: "echo nope", timeout: 5 }, ac.signal, undefined, ctx),
		/Command aborted/,
	);
});

test("background start returns immediately with id, pid, and log file", async () => {
	const t0 = Date.now();
	const res = await runBg("sleep 0.2 && echo late-" + tag());
	assert(Date.now() - t0 < 1500, "bg start must not block");
	assert(/^[0-9a-f]{8}$/.test(res.details.backgroundId), "8-hex background id");
	assert(Number.isInteger(res.details.pid) && res.details.pid > 1, `real pid (${res.details.pid})`);
	assert(isAlive(res.details.pid), "pid is a live process");
	assert(res.details.logFile.endsWith(".log"), "log file path in details");
	const text = res.content[0].text;
	assert(text.includes(`pid ${res.details.pid}`), "pid mentioned in reply");
	assert(text.includes(res.details.logFile), "log path mentioned in reply");
	assert(text.includes(`kill -TERM -${res.details.pid}`), "manage hints present");
});

test("pid identity: reported pid equals the job's own $$; kill -TERM -pid kills the tree", async () => {
	const $$File = join(workDir, "dollars-" + tag());
	const dur = "71"; // unique per test for pgrep
	const res = await runBg(`echo $$ > ${$$File}; sleep ${dur}`);
	const pid = res.details.pid;

	await waitFor(() => existsSync($$File));
	assert(Number(readFileSync($$File, "utf8").trim()) === pid, "details.pid matches the job's own $$");

	// Developer-style kill through a plain foreground bash call.
	await runFg(`kill -TERM -${pid}`);

	const n = await waitFor(() => notifFor(`sleep ${dur}`), { timeout: 10000 });
	assert(n.message.content.includes("EXITED (signal)"), "SIGTERM death observed (signal exit)");
	await waitFor(() => !isAlive(pid), { timeout: 5000 });
	assert(pgrep(`[s]leep ${dur}`).length === 0, "sleep child also dead (tree kill)");
});

test("custom signals work: USR1 trap fires; SIGKILL escalation exits 137", async () => {
	const sigFile = join(workDir, "usr1-" + tag());
	const tag2 = tag();
	const res = await runBg(
		`trap 'echo got-usr1 >> ${sigFile}' USR1; while true; do sleep 0.2; done # usr1-${tag2}`,
	);
	const pid = res.details.pid;

	await runFg(`kill -USR1 ${pid}`);
	await waitFor(() => existsSync(sigFile) && readFileSync(sigFile, "utf8").includes("got-usr1"), {
		timeout: 5000,
	});
	assert(isAlive(pid), "job still running after USR1 (only the trap fired)");

	await runFg(`kill -KILL -${pid}`);
	const n = await waitFor(() => notifFor(`usr1-${tag2}`), { timeout: 10000 });
	assert(n.message.content.includes("EXITED (signal)"), "SIGKILL death observed (signal exit)");
	await waitFor(() => !isAlive(pid), { timeout: 5000 });
});

test("wait idiom: kill -0 loop returns only after the job exits", async () => {
	const marker = "waited-" + tag();
	const res = await runBg(`sleep 1 && echo ${marker}`);
	const pid = res.details.pid;

	const w = await runFg(`while kill -0 ${pid} 2>/dev/null; do sleep 0.1; done; echo WAIT_OK_${marker}`, 30);
	assert(w.content[0].text.includes(`WAIT_OK_${marker}`), "wait loop returned after exit");

	const n = await waitFor(() => notifFor(marker), { timeout: 10000 });
	assert(n.options.deliverAs === "followUp" && n.options.triggerTurn === true, "followUp + triggerTurn options");
	assert(n.message.customType === "bash-bg-result" && n.message.display === true, "customType/display");
	assert(n.message.content.includes("EXITED (code 0)"), "exit code in notification");
	assert(n.message.content.includes("Full output:"), "log path in notification");
});

test("log file holds FULL output (no cap); notification embeds only the tail", async () => {
	const marker = "cap-" + tag();
	// Marker built via shell var so the literal marker only appears in the
	// command string once; BEGIN is at the start of 160KB of output.
	const doneFile = join(workDir, "capdone-" + tag());
	const res = await runBg(
		`m=${marker}; echo $m-BEGIN; dd if=/dev/urandom bs=1 count=120000 2>/dev/null | base64 | tr -d '\\n'; echo $m-END; echo done > ${doneFile}`,
	);
	await waitFor(() => existsSync(doneFile), { timeout: 30000 });

	const n = await waitFor(() => notifFor(`${marker}-END`), { timeout: 10000 });
	assert(n.message.content.includes(`${marker}-END`), "tail contains END");
	assert(!n.message.content.includes(`${marker}-BEGIN`), "160KB of output not embedded in notification");

	const logBuf = readFileSync(res.details.logFile);
	assert(logBuf.length > 100000, `full output in log file (${logBuf.length} bytes)`);
	assert(logBuf.toString().includes(`${marker}-BEGIN`), "beginning retained in log file");
	assert(logBuf.toString().includes(`${marker}-END`), "end retained in log file");
});

test("quoting survives: single and double quotes in commands", async () => {
	const marker = "quote-" + tag();
	const res = await runBg(`echo "it's" && echo 'a"b' && echo ${marker}`);
	await waitFor(() => notifFor(marker), { timeout: 10000 });
	const log = readFileSync(res.details.logFile, "utf8");
	assert(log.includes("it's"), "single quote inside double quotes");
	assert(log.includes('a"b'), "double quote inside single quotes");
});

test("background timeout is enforced (safety net) and reported", async () => {
	const marker = "tmo-" + tag();
	const res = await runBg(`echo ${marker}; sleep 61`, { timeout: 1 });
	const pid = res.details.pid;

	const n = await waitFor(() => notifFor(marker), { timeout: 10000 });
	assert(n.message.content.includes("Command timed out after 1 seconds"), "timeout reported");
	await waitFor(() => !isAlive(pid), { timeout: 5000 });
	assert(pgrep(`[s]leep 61`).length === 0, "sleep child killed with the tree");
});

test("missing cwd is reported as job error with null pid", async () => {
	const marker = "nocwd-" + tag();
	const badCtx = makeCtx(join(workDir, "does-not-exist"));
	const res = await bash.execute(
		"cwd1",
		{ command: `echo ${marker}`, run_in_background: true },
		undefined,
		undefined,
		badCtx,
	);
	assert(res.details.pid === null, "no pid for a job that never spawned");
	await waitFor(() => notifFor(marker), { timeout: 10000 });
	const n = notifFor(marker);
	assert(n.message.content.includes("FAILED"), "never-spawned job reports FAILED, not EXITED (signal)");
	assert(n.message.content.includes("Working directory does not exist"), "cwd error in notification");
	// Red-team m2: never-spawned jobs must not leave an empty log file behind.
	assert(
		!existsSync(join(tmpdir(), `pi-bg-${res.details.backgroundId}.log`)),
		"no empty log file for never-spawned job",
	);
});

test("background job survives a turn abort", async () => {
	const marker = "survived-" + tag();
	const ac = new AbortController();
	ac.abort();
	const res = await bash.execute(
		"abortcall",
		{ command: `echo ${marker}`, run_in_background: true },
		ac.signal,
		undefined,
		ctx,
	);
	assert(res.details.backgroundId, "job started despite aborted turn signal");
	await waitFor(() => notifFor(marker), { timeout: 10000 });
});

test("non-zero exit is reported in the notification", async () => {
	const marker = "fail-" + tag();
	await runBg(`echo ${marker}; exit 7`);
	await waitFor(() => notifFor(marker));
	const n = notifFor(marker);
	assert(n.message.content.includes("EXITED (code 7)"), "non-zero exit reported");
});

test("no-output job still notifies with status and log path only", async () => {
	const res = await runBg("sleep 0.2");
	const id = res.details.backgroundId;
	await waitFor(() => notifFor(id), { timeout: 10000 });
	const n = notifFor(id);
	assert(n.message.content.includes("EXITED (code 0)"), "status present");
	assert(!n.message.content.includes("```"), "no code fence for empty output");
	assert(n.message.content.includes("Full output:"), "log path present");
});

test("trivial fast jobs still get a pid (no pid-capture race)", async () => {
	// Red-team M1: a job that completes within one poll interval must not
	// always report pid null. Each iteration waits for the notification so
	// pidfiles are removed before the next run starts.
	let withPid = 0;
	const total = 8;
	for (let k = 0; k < total; k++) {
		const marker = `fast-${tag()}`;
		const res = await runBg(`echo ${marker}`);
		if (Number.isInteger(res.details.pid) && res.details.pid > 1) withPid++;
		const n = await waitFor(() => notifFor(marker), { timeout: 10000 });
		assert(n.message.content.includes("EXITED (code 0)"), "fast job still notifies correctly");
	}
	assert(withPid === total, `pid captured for only ${withPid}/${total} fast jobs`);
});

test("backgrounded children are flagged, stay killable via the pid, die at shutdown", async () => {
	// Red-team C1: `foo &` makes the shell exit while children keep running.
	const marker = "ling-" + tag();
	const res = await runBg(`sleep 300 & echo ${marker}`);
	const pid = res.details.pid;
	assert(Number.isInteger(pid), "pid known for the job");

	const n = await waitFor(() => notifFor(marker), { timeout: 10000 });
	assert(n.message.content.includes("EXITED (code 0)"), "shell exit reported");
	assert(n.message.content.includes("still running in process group"), "lingering children flagged");
	assert(!isAlive(pid), "the shell itself is gone");
	await waitFor(() => pgrep(`[s]leep 300`).length > 0, { timeout: 5000 });

	// Still manageable with plain bash via the process group.
	await runFg(`kill -TERM -${pid}`);
	await waitFor(() => pgrep(`[s]leep 300`).length === 0, { timeout: 5000 });
});

test("notification failure is contained (no crash, no leak)", async () => {
	// Red-team M2/M3: if sendMessage throws (e.g. "Agent is already processing"),
	// the error must be swallowed - an unhandled rejection would crash pi.
	const h2 = makePi();
	h2.api.sendMessage = () => {
		throw new Error("boom");
	};
	createExtension(h2.api);
	const bash2 = h2.tools.get("bash");
	const res = await bash2.execute(
		"notiffail",
		{ command: `echo notif-fail-${tag()}`, run_in_background: true },
		undefined,
		undefined,
		ctx,
	);
	assert(res.details.backgroundId, "job started");
	await sleep(1000); // completion handler + throwing notifyDone must be swallowed
	assert(true, "no unhandled rejection / crash");
	// Clean up the second instance's own files (its shutdown handler).
	await h2.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" });
});

test("session_shutdown: SIGTERM grace, SIGKILL stragglers, no notifications, files cleaned (run last)", async () => {
	const termFile = join(workDir, "term-" + tag());
	const graceTag = "trap-grace-" + tag();
	const ignTag = "trap-ign-" + tag();
	// Job that catches SIGTERM (writes a marker) but keeps running.
	await runBg(`trap 'echo got-term >> ${termFile}' TERM; while true; do sleep 0.34; done # ${graceTag}`);
	// Job that ignores SIGTERM entirely — must be SIGKILLed after the grace.
	await runBg(`trap '' TERM; while true; do sleep 0.35; done # ${ignTag}`);

	// Lingering job (shell exited, backgrounded child still running) - its
	// group must be killed at shutdown even though no exec promise is pending.
	const lingMarker = "shutdown-ling-" + tag();
	await runBg(`sleep 302 & echo ${lingMarker}`);
	await waitFor(() => notifFor(lingMarker), { timeout: 10000 });

	const sentBefore = harness.sent.length;
	const t0 = Date.now();
	await shutdownHandler({ type: "session_shutdown", reason: "quit" });

	// SIGTERM was delivered (graceful path worked).
	await waitFor(() => existsSync(termFile) && readFileSync(termFile, "utf8").includes("got-term"), {
		timeout: 5000,
	});
	// All trees dead after grace + SIGKILL (incl. the lingering child).
	await waitFor(
		() =>
			pgrep(graceTag).length === 0 &&
			pgrep(ignTag).length === 0 &&
			pgrep(`[s]leep 302`).length === 0,
		{ timeout: 10000 },
	);
	assert(Date.now() - t0 > 2500, `grace period observed (${Date.now() - t0}ms)`);
	assert(harness.sent.length === sentBefore, "no notifications after shutdown");

	// No leftover pid/log files for any job started during the run.
	const leftovers = readdirSync(tmpdir()).filter(
		(f) => f.startsWith("pi-bg-") && allJobIds.some((id) => f.includes(id)),
	);
	assert(leftovers.length === 0, `leftover files: ${leftovers.join(", ")}`);
});

await runTests();
