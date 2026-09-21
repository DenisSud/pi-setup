/**
 * Harness tests for the security extension.
 *
 * Drives the real extension factory with a stubbed ExtensionAPI, the real
 * bash tool definition (local shell, no network) and a fake `rbw` script
 * in a temp dir — no vault access, no real secrets.
 *
 * Tests:
 *   - config: missing file, strict validation, shorthand item refs
 *   - rbw: profile resolution, unknown profile, locked vault hint
 *   - redact: exact/base64/hex/URL/JSON variants, longest-first, min length,
 *             idempotency, first-name-wins
 *   - guard: command-position program matching, path fragments, ptc code
 *   - bash override: stock behavior preserved, `secrets` env injection,
 *                    unknown profile error, tool_call guard wiring
 *   - tool_result redaction + provider payload scrub
 *   - session_start warmup
 *   - ptc `secrets_sh` binding
 *
 * Run: node test/harness.mjs   (Node >= 23.6, native TS type stripping)
 * Requires node_modules symlinks set up by run.sh.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import securityExtension from "../index.ts";
import { loadConfig } from "../config.ts";
import { resolveAll, resolveProfile } from "../rbw.ts";
import { Redactor, placeholder, redactDeep } from "../redact.ts";
import { checkCommand, checkToolInput } from "../guard.ts";
import { getPtcTool } from "../../ptc/registry.ts";

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
			console.error(`        ${String(err && err.message).split("\n").slice(0, 8).join("\n        ")}`);
		}
	}
	console.log(`\n${passed}/${tests.length} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
}

function assert(cond, msg) {
	if (!cond) throw new Error(msg || "assertion failed");
}

function assertMatch(text, re, msg) {
	if (!re.test(text)) throw new Error(`${msg || "no match"}: ${re} against ${JSON.stringify(text.slice(0, 200))}`);
}

// ── fixtures ──────────────────────────────────────────────────────────────

const TMP = fs.mkdtempSync(join(os.tmpdir(), "pi-security-test-"));

const SECRETS = {
	jellyfin: "jf_live_3f9a1c7d2b8e4f60",
	forgejo: "fj_tok_a1b2c3d4e5f60718",
	ollama: "ol_9z8y7x6w5v4u3t2s",
};

const RBW_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${TMP}/rbw-args.log"
[ "\${1:-}" = "get" ] || { echo "fake rbw: unsupported command \${1:-}" >&2; exit 2; }
item="\${@: -1}"
field="password"
while [ $# -gt 0 ]; do
  case "$1" in
    --field) field="$2"; shift 2 ;;
    --folder) shift 2 ;;
    *) shift ;;
  esac
done
case "$item/$field" in
  "Jellyfin API/password") printf '%s\\n' "${SECRETS.jellyfin}" ;;
  "Forgejo Token/password") printf '%s\\n' "${SECRETS.forgejo}" ;;
  "Ollama Cloud/password") printf '%s\\n' "${SECRETS.ollama}" ;;
  "Locked Item/password") echo "Vault is locked. Run rbw unlock" >&2; exit 1 ;;
  *) echo "no item $item" >&2; exit 1 ;;
esac
`;

const RBW_PATH = join(TMP, "rbw");
fs.writeFileSync(RBW_PATH, RBW_SCRIPT);
fs.chmodSync(RBW_PATH, 0o755);

const CONFIG = {
	profiles: {
		jellyfin: {
			description: "Jellyfin API token",
			vars: { JELLYFIN_API_KEY: { item: "Jellyfin API", field: "password" } },
		},
		forgejo: { vars: { FORGEJO_TOKEN: "Forgejo Token" } },
		ollama: { vars: { OLLAMA_API_KEY: { item: "Ollama Cloud" } } },
		locked: { vars: { LOCKED_KEY: { item: "Locked Item" } } },
	},
	rbw: { command: RBW_PATH, timeoutMs: 5000 },
	guard: { disabled: false, extraPatterns: [] },
};

const CONFIG_PATH = join(TMP, "security.json");
fs.writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG, null, 2));
process.env.PI_SECURITY_CONFIG = CONFIG_PATH;

// ── stub ExtensionAPI ─────────────────────────────────────────────────────

function makePi() {
	const tools = new Map();
	const handlers = new Map();
	return {
		tools,
		handlers,
		registerTool: (def) => tools.set(def.name, def),
		on: (name, handler) => {
			if (!handlers.has(name)) handlers.set(name, []);
			handlers.get(name).push(handler);
		},
		async emit(name, event, ctx = makeCtx()) {
			let result;
			for (const handler of handlers.get(name) ?? []) {
				const r = await handler(event, ctx);
				if (r !== undefined) result = r;
			}
			return result;
		},
	};
}

const notifications = [];
const SESSION_ID = "01a0a91d-f8f6-7ef4-9430-cf878cd2b2c4";
function makeCtx(overrides = {}) {
	return {
		cwd: TMP,
		mode: "tui",
		hasUI: true,
		ui: { notify: (message, level) => void notifications.push({ message, level }) },
		sessionManager: { getSessionId: () => SESSION_ID, getSessionFile: () => undefined },
		...overrides,
	};
}

const pi = makePi();
securityExtension(pi);

const bashTool = pi.tools.get("bash");
assert(bashTool, "bash tool registered (override)");
const secretsSh = getPtcTool("secrets_sh");
assert(secretsSh, "secrets_sh registered with the ptc registry");

async function runBash(params, ctx = makeCtx()) {
	return bashTool.execute("call-1", params, undefined, undefined, ctx);
}

// ── config ────────────────────────────────────────────────────────────────

test("config: missing file → empty profiles, defaults", () => {
	const cfg = loadConfig(join(TMP, "does-not-exist.json"));
	assert(Object.keys(cfg.profiles).length === 0, "no profiles");
	assert(cfg.rbw.command === "rbw", "default rbw command");
	assert(cfg.guard.disabled === false, "guard on by default");
});

test("config: loads profiles, shorthand item, defaults nested", () => {
	const cfg = loadConfig(CONFIG_PATH);
	assert(Object.keys(cfg.profiles).join(",") === "jellyfin,forgejo,ollama,locked", "profile names");
	assert(cfg.profiles.forgejo.vars.FORGEJO_TOKEN.item === "Forgejo Token", "shorthand item");
	assert(cfg.profiles.forgejo.vars.FORGEJO_TOKEN.field === undefined, "field defaulted at resolve time");
	assert(cfg.rbw.command === RBW_PATH, "rbw command");
});

test("config: invalid JSON throws with file name", () => {
	const bad = join(TMP, "bad.json");
	fs.writeFileSync(bad, "{ not json");
	try {
		loadConfig(bad);
		throw new Error("expected throw");
	} catch (err) {
		assertMatch(err.message, /not valid JSON/, "message");
	}
});

test("config: bad env var name rejected", () => {
	const bad = join(TMP, "bad2.json");
	fs.writeFileSync(bad, JSON.stringify({ profiles: { p: { vars: { "not-a-name": "Item" } } } }));
	try {
		loadConfig(bad);
		throw new Error("expected throw");
	} catch (err) {
		assertMatch(err.message, /not a valid env var name/, "message");
	}
});

// ── rbw resolution ────────────────────────────────────────────────────────

test("rbw: profile resolves to env map, trailing newline stripped", async () => {
	fs.writeFileSync(join(TMP, "rbw-args.log"), "");
	const env = await resolveProfile(loadConfig(CONFIG_PATH), "jellyfin");
	assert(env.JELLYFIN_API_KEY === SECRETS.jellyfin, `value: ${JSON.stringify(env.JELLYFIN_API_KEY)}`);
	// regression guard: `--raw` would mean JSON output in rbw, not the raw value
	const logged = fs.readFileSync(join(TMP, "rbw-args.log"), "utf8").trim();
	assert(logged === "get --field password Jellyfin API", `argv: ${JSON.stringify(logged)}`);
});

test("rbw: shorthand ref defaults to the password field", async () => {
	const env = await resolveProfile(loadConfig(CONFIG_PATH), "forgejo");
	assert(env.FORGEJO_TOKEN === SECRETS.forgejo, "value");
});

test("rbw: unknown profile lists available names", async () => {
	try {
		await resolveProfile(loadConfig(CONFIG_PATH), "nope");
		throw new Error("expected throw");
	} catch (err) {
		assertMatch(err.message, /unknown secrets profile "nope"/, "message");
		assertMatch(err.message, /jellyfin \(Jellyfin API token\)/, "descriptions listed");
	}
});

test("rbw: locked vault error carries unlock hint", async () => {
	try {
		await resolveProfile(loadConfig(CONFIG_PATH), "locked");
		throw new Error("expected throw");
	} catch (err) {
		assertMatch(err.message, /rbw unlock/, "hint");
	}
});

test("rbw: resolveAll reports per-profile failures", async () => {
	const { env, failures } = await resolveAll(loadConfig(CONFIG_PATH));
	assert(env.JELLYFIN_API_KEY === SECRETS.jellyfin, "good profiles resolved");
	assert(failures.length === 1 && failures[0].profile === "locked", "one failure");
});

// ── redaction ─────────────────────────────────────────────────────────────

test("redact: exact value and encodings", () => {
	const r = new Redactor();
	const value = "sk-live-0123456789abcdef";
	r.add("MY_TOKEN", value);
	const b64 = Buffer.from(value).toString("base64");
	const hex = Buffer.from(value).toString("hex");
	const cases = [value, b64, hex, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)];
	for (const c of cases) {
		assert(r.redact(`before ${c} after`) === `before ${placeholder("MY_TOKEN")} after`, `variant not redacted: ${c}`);
	}
});

test("redact: longest value wins, shorter does not mangle it", () => {
	const r = new Redactor();
	r.add("SHORT", "abcdefgh");
	r.add("LONG", "abcdefghijklmnop");
	assert(r.redact("x abcdefghijklmnop y") === `x ${placeholder("LONG")} y`, "longer match");
	assert(r.redact("x abcdefgh y") === `x ${placeholder("SHORT")} y`, "shorter match");
});

test("redact: values shorter than the minimum are ignored", () => {
	const r = new Redactor();
	r.add("TINY", "short");
	assert(r.size === 0, "not registered");
	assert(r.redact("short") === "short", "text untouched");
});

test("redact: idempotent and safe on plain text", () => {
	const r = new Redactor();
	r.add("TOKEN", "abcdefghijklmnop");
	const once = r.redact("v=abcdefghijklmnop");
	assert(once === `v=${placeholder("TOKEN")}`, "redacted");
	assert(r.redact(once) === once, "second pass unchanged");
	assert(r.redact("nothing to do here") === "nothing to do here", "untouched text");
});

test("redact: first registered name wins for a shared value", () => {
	const r = new Redactor();
	r.add("FIRST", "abcdefghijklmnop");
	r.add("SECOND", "abcdefghijklmnop");
	assert(r.redact("abcdefghijklmnop") === placeholder("FIRST"), "first name");
});

test("redact: non-string payload members and nested arrays are scrubbed", () => {
	const r = new Redactor();
	r.add("TOKEN", "abcdefghijklmnop");
	const payload = { a: "abcdefghijklmnop", b: [1, "x abcdefghijklmnop y", { c: "abcdefghijklmnop" }], d: 5 };
	redactDeep(payload, r);
	assert(payload.a === placeholder("TOKEN"), "top-level");
	assert(payload.b[1] === `x ${placeholder("TOKEN")} y`, "array string");
	assert(payload.b[2].c === placeholder("TOKEN"), "nested object");
	assert(payload.d === 5, "numbers untouched");
});

// ── guard ─────────────────────────────────────────────────────────────────

const GUARD = { disabled: false, extraPatterns: [] };

test("guard: blocks rbw in command position, allows mention as an argument", () => {
	const blocked = [
		"rbw get Jellyfin",
		"/usr/bin/rbw get Jellyfin",
		"sudo rbw get Jellyfin",
		"FOO=1 rbw get Jellyfin",
		"env -i rbw get Jellyfin",
		"bash -c \"rbw get Jellyfin\"",
		"xargs rbw",
		"nix run nixpkgs#rbw -- get Jellyfin",
		"echo x; rbw unlock",
		"out=$(rbw get Jellyfin)",
	];
	for (const command of blocked) {
		assert(checkCommand(command, GUARD), `should block: ${command}`);
	}
	const allowed = ["grep -rn rbw docs", "echo hello", "git status", "rg bitwarden --files", "node test/harness.mjs"];
	for (const command of allowed) {
		assert(checkCommand(command, GUARD) === null, `should allow: ${command}`);
	}
});

test("guard: blocks credential-store paths anywhere in a command", () => {
	assert(checkCommand("cat ~/.config/rbw/rbw.json", GUARD), "rbw config");
	assert(checkCommand("ls ~/.pi/agent/", GUARD) === null, "pi agent dir itself is fine");
	assert(checkCommand("cat ~/.pi/agent/auth.json", GUARD), "auth.json");
	assert(checkCommand("cp ~/.env.age /tmp/x", GUARD), "age file");
});

test("guard: tool inputs", () => {
	assert(checkToolInput("read", { path: "/home/denis/.pi/agent/auth.json" }, GUARD), "auth.json read");
	assert(checkToolInput("read", { path: "/home/denis/dev/pi-setup/README.md" }, GUARD) === null, "normal read");
	assert(checkToolInput("bash", { command: "rbw get X" }, GUARD), "bash command");
	assert(checkToolInput("ptc", { code: "const x = await sh({command: 'rbw get X'});" }, GUARD), "ptc code");
	assert(checkToolInput("ptc", { code: "const {output} = await secrets_sh({profile: 'forgejo', command: 'git push'});" }, GUARD) === null, "secrets_sh allowed");
});

test("guard: extraPatterns from config and disabled switch", () => {
	const settings = { disabled: false, extraPatterns: ["rm\\s+-rf\\s+/"] };
	assert(checkToolInput("bash", { command: "rm -rf /" }, settings), "extra pattern");
	assert(checkToolInput("bash", { command: "rm -rf /" }, { disabled: true, extraPatterns: [] }) === null, "disabled");
});

// ── extension wiring ──────────────────────────────────────────────────────

test("bash override: stock behavior preserved without `secrets`", async () => {
	const result = await runBash({ command: "printf 'plain ok'" });
	assert(result.content[0].text === "plain ok", `output: ${JSON.stringify(result.content[0].text)}`);
});

test("bash override: description and guidelines carry the contract", () => {
	assertMatch(bashTool.description, /secrets: "<profile>"/, "description mentions secrets param");
	assertMatch(bashTool.description, /«redacted:NAME»/, "description mentions marker");
	assert((bashTool.promptGuidelines ?? []).some((g) => /secrets/.test(g)), "guideline present");
	assert(bashTool.name === "bash" && bashTool.label, "stock fields preserved");
});

test("bash override: `secrets` injects env and does not leak via details", async () => {
	const ctx = makeCtx();
	const result = await runBash({ command: 'printf "%s" "$JELLYFIN_API_KEY"', secrets: "jellyfin" }, ctx);
	assert(result.content[0].text === SECRETS.jellyfin, `env injected: ${JSON.stringify(result.content[0].text)}`);
});

test("bash override: unknown profile throws a useful error", async () => {
	try {
		await runBash({ command: "true", secrets: "nope" });
		throw new Error("expected throw");
	} catch (err) {
		assertMatch(err.message, /unknown secrets profile "nope"/, "message");
	}
});

test("tool_call guard: blocks rbw through the real handler, allows profiles", async () => {
	const blocked = await pi.emit("tool_call", {
		type: "tool_call",
		toolCallId: "c1",
		toolName: "bash",
		input: { command: "rbw get Jellyfin" },
	});
	assert(blocked && blocked.block === true, "blocked");
	assertMatch(blocked.reason, /secrets/, "reason points at profiles");

	const allowed = await pi.emit("tool_call", {
		type: "tool_call",
		toolCallId: "c2",
		toolName: "bash",
		input: { command: "git status", secrets: "jellyfin" },
	});
	assert(allowed === undefined, "not blocked");

	const fileRead = await pi.emit("tool_call", {
		type: "tool_call",
		toolCallId: "c3",
		toolName: "read",
		input: { path: "/home/denis/.config/rbw/rbw.json" },
	});
	assert(fileRead && fileRead.block === true, "rbw store read blocked");
});

test("session_start: warms the redactor from every profile", async () => {
	await pi.emit("session_start", { type: "session_start" }, makeCtx());
	const result = await pi.emit("tool_result", {
		type: "tool_result",
		toolCallId: "c9",
		toolName: "some_other_tool",
		input: {},
		isError: false,
		content: [{ type: "text", text: `token=${SECRETS.forgejo}` }],
	});
	assert(result && result.content[0].text === `token=${placeholder("FORGEJO_TOKEN")}`, "warmup redaction works");
});

test("tool_result: redacts text, leaves other content untouched", async () => {
	const image = { type: "image", data: "AAAA", mimeType: "image/png" };
	const result = await pi.emit("tool_result", {
		type: "tool_result",
		toolCallId: "c10",
		toolName: "bash",
		input: { command: "echo", secrets: "ollama" },
		isError: false,
		content: [{ type: "text", text: `key ${SECRETS.ollama}` }, image],
	});
	assert(result.content[0].text === `key ${placeholder("OLLAMA_API_KEY")}`, "text redacted");
	assert(result.content[1] === image, "image passthrough");
});

test("before_provider_request: scrubs nested payload in place", async () => {
	const payload = {
		model: "m",
		messages: [{ role: "user", content: [{ type: "text", text: `leak ${SECRETS.jellyfin}` }] }],
	};
	await pi.emit("before_provider_request", { type: "before_provider_request", payload }, makeCtx());
	assert(payload.messages[0].content[0].text === `leak ${placeholder("JELLYFIN_API_KEY")}`, "payload scrubbed");
});

test("ptc registry: separate module instances share one store (pi isolates extensions)", async () => {
	// pi loads each extension with its own module instance, so a module-scoped
	// registry would hide registrations from the ptc extension.
	const url = new URL("../../ptc/registry.ts", import.meta.url);
	const isolated = await import(`${url.href}?instance=2`);
	isolated.registerPtcTool("__isolation_probe__", () => "first");
	assert(getPtcTool("__isolation_probe__")?.run() === "first", "visible through the first instance");
	isolated.registerPtcTool("__isolation_probe__", () => "second");
	assert(getPtcTool("__isolation_probe__")?.run() === "second", "last write wins across instances");
});

test("ptc secrets_sh: injects env, returns redacted output", async () => {
	const result = await secretsSh.run(
		{ profile: "forgejo", command: 'printf "%s" "$FORGEJO_TOKEN"' },
		makeCtx(),
	);
	assert(result.output === placeholder("FORGEJO_TOKEN"), `output: ${JSON.stringify(result.output)}`);
	assert(result.code === 0, "exit code");
});

test("ptc secrets_sh: plain command output passes through", async () => {
	const result = await secretsSh.run({ profile: "forgejo", command: "printf 'hello'" }, makeCtx());
	assert(result.output === "hello" && result.code === 0, `output: ${JSON.stringify(result)}`);
});

runTests();
