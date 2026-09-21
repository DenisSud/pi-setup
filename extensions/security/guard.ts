/**
 * security/guard — block the obvious direct paths to credential stores.
 *
 * This is a policy guard, not a sandbox: it stops the plain-text moves
 * (`rbw get`, reading rbw/bitwarden/keyring state) so the model reaches
 * for a secrets profile instead. It cannot stop a determined agent from
 * encoding or re-implementing the same read — redaction is the backstop
 * for that. Keep it boring: token-level command-position matching, no
 * clever regexes.
 */
import type { GuardSettings } from "./config.ts";

const PROGRAM_NAMES = new Set(["rbw", "bw", "bitwarden", "bitwarden-cli"]);

/** Programs after which another command follows (`env FOO=1 rbw`, `bash -c "rbw ..."`). */
const WRAPPERS = new Set([
	"env",
	"sudo",
	"doas",
	"exec",
	"nohup",
	"command",
	"nice",
	"ionice",
	"stdbuf",
	"time",
	"xargs",
	"nix",
	"sh",
	"bash",
	"zsh",
	"fish",
	"dash",
]);

/** Case-insensitive substrings that mark a credential store path. */
const PATH_FRAGMENTS = [
	".config/rbw",
	"local/share/rbw",
	".bitwarden",
	"config/bitwarden",
	"login.keyring",
	"user.keystore",
	"/keyrings/",
	".pi/agent/auth.json",
	".pi/agent/secrets.md",
	".env.age",
];

const PATH_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write"]);

/** `nix` subcommands that stand between `nix` and the package/command it runs. */
const NIX_SUBCOMMANDS = new Set(["run", "shell", "develop", "build", "exec"]);

function programReason(name: string): string {
	return `Blocked by the security guard: direct use of \`${name}\` is disabled so secret values never reach the transcript. Use the bash tool's \`secrets\` parameter (or ptc's \`secrets_sh\`) with a profile name instead.`;
}

function pathReason(fragment: string): string {
	return `Blocked by the security guard: ${fragment} is a credential store. Use a secrets profile (bash \`secrets\` parameter or ptc \`secrets_sh\`) instead of reading it directly.`;
}

function extraReason(): string {
	return "Blocked by the security guard (configured block pattern).";
}

function unquote(token: string): string {
	return token.replace(/^["'`]+/, "").replace(/["'`]+$/, "");
}

/** Program name a shell token would execute (`foo/bar/rbw` → `rbw`, `nixpkgs#rbw` → `rbw`). */
function programName(token: string): string {
	const bare = unquote(token);
	const afterHash = bare.includes("#") ? bare.slice(bare.lastIndexOf("#") + 1) : bare;
	const parts = afterHash.split("/");
	return parts[parts.length - 1];
}

function segmentRunsProgram(segment: string): string | null {
	const tokens = segment.trim().split(/\s+/).filter(Boolean);
	let i = 0;
	// leading VAR=value assignments
	while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
	// walk through wrapper programs (`sudo -u x env FOO=1 rbw get …`)
	while (i < tokens.length) {
		const name = programName(tokens[i]);
		if (PROGRAM_NAMES.has(name)) return name;
		if (!WRAPPERS.has(name)) return null;
		const wrapper = name;
		i++;
		while (i < tokens.length) {
			const token = tokens[i];
			const isOption = token.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
			const isNixSubcommand = wrapper === "nix" && NIX_SUBCOMMANDS.has(token);
			if (!isOption && !isNixSubcommand) break;
			i++;
		}
	}
	return null;
}

/** Check a bash command string. Returns a block reason or null. */
export function checkCommand(command: string, settings: GuardSettings): string | null {
	if (!command || settings.disabled) return null;
	const lowered = command.toLowerCase();
	for (const fragment of PATH_FRAGMENTS) {
		if (lowered.includes(fragment)) return pathReason(fragment);
	}
	for (const segment of command.split(/[\n;&|(){}]/)) {
		const name = segmentRunsProgram(segment);
		if (name) return programReason(name);
	}
	return null;
}

function collectStrings(value: unknown, out: string[] = [], seen = new WeakSet<object>()): string[] {
	if (typeof value === "string") {
		out.push(value);
		return out;
	}
	if (!value || typeof value !== "object") return out;
	if (seen.has(value)) return out;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) collectStrings(item, out, seen);
		return out;
	}
	for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, out, seen);
	return out;
}

function extraMatches(text: string, settings: GuardSettings): boolean {
	for (const pattern of settings.extraPatterns) {
		try {
			if (new RegExp(pattern).test(text)) return true;
		} catch {
			// ignore invalid patterns from config
		}
	}
	return false;
}

/** Check a ptc program: it runs arbitrary Node, so only catch blatant words. */
export function checkPtcCode(code: string, settings: GuardSettings): string | null {
	const lowered = code.toLowerCase();
	for (const fragment of PATH_FRAGMENTS) {
		if (lowered.includes(fragment)) return pathReason(fragment);
	}
	const match = lowered.match(/\b(rbw|bitwarden)\b/);
	if (match) return programReason(match[1]);
	return null;
}

/** Check any tool call input. Returns a block reason or null. */
export function checkToolInput(toolName: string, input: Record<string, unknown>, settings: GuardSettings): string | null {
	if (settings.disabled) return null;
	const strings = collectStrings(input);
	for (const text of strings) {
		if (extraMatches(text, settings)) return extraReason();
	}
	// bash and ptc execute arbitrary code: check the whole input.
	if (toolName === "bash") return checkCommand(String(input.command ?? ""), settings);
	if (toolName === "ptc") return checkPtcCode(typeof input.code === "string" ? input.code : "", settings);
	// File tools: only the path can leak store *contents*. Writing text that
	// merely mentions a store path (docs, configs, this extension's own tests)
	// is fine, so content/pattern fields are not checked here.
	if (PATH_TOOLS.has(toolName)) {
		const path = typeof input.path === "string" ? input.path.toLowerCase() : "";
		for (const fragment of PATH_FRAGMENTS) {
			if (path.includes(fragment)) return pathReason(fragment);
		}
	}
	return null;
}
