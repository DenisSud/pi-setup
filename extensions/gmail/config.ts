/**
 * gmail/config — non-secret connection facts for the Gmail tools.
 *
 * The account password is never here: it is read at connect time from the
 * process environment (the `pi-env` extension copies settings.json's "env"
 * block into it), from the variable named in `passwordVar`.
 *
 * Config file: ~/.pi/agent/gmail.json (override with GMAIL_CONFIG).
 * Kept in the agent dir, never in the package: a git package is cleaned on
 * update, so nothing machine-local may live beside the source.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

export interface GmailConfig {
	/** Gmail address; used for the IMAP login and as the draft From header. */
	username: string;
	host: string;
	port: number;
	/** Env var holding the IMAP app password (pi-env). */
	passwordVar: string;
	/** Append-only audit log, trimmed to the last AUDIT_LIMIT entries. */
	auditLog: string;
	/** Body text cap per message (chars). */
	maxBodyChars: number;
	/** Where `email_get_attachment` writes downloaded files. */
	attachmentDir: string;
}

export function configPath(): string {
	return process.env.GMAIL_CONFIG ?? join(os.homedir(), ".pi", "agent", "gmail.json");
}

const DEFAULTS: Omit<GmailConfig, "username"> = {
	host: "imap.gmail.com",
	port: 993,
	passwordVar: "GMAIL_APP_PASSWORD",
	auditLog: join(os.homedir(), ".local", "state", "pi-personal", "gmail-audit.jsonl"),
	maxBodyChars: 20_000,
	attachmentDir: join(os.homedir(), "Downloads", "email-attachments"),
};

export function loadConfig(): GmailConfig {
	const path = configPath();
	let raw: Record<string, unknown> = {};
	try {
		raw = JSON.parse(fs.readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new Error(`gmail: cannot read ${path}: ${(err as Error).message}`);
		}
	}

	const str = (key: string, fallback: string): string => {
		const value = raw[key];
		if (value === undefined) return fallback;
		if (typeof value !== "string" || !value.trim()) throw new Error(`gmail: ${path}: ${key} must be a non-empty string`);
		return value.trim();
	};

	const config: GmailConfig = {
		username: str("username", ""),
		host: str("host", DEFAULTS.host),
		port: Number(raw.port ?? DEFAULTS.port),
		passwordVar: str("passwordVar", DEFAULTS.passwordVar),
		auditLog: str("auditLog", DEFAULTS.auditLog),
		maxBodyChars: Number(raw.maxBodyChars ?? DEFAULTS.maxBodyChars),
		attachmentDir: str("attachmentDir", DEFAULTS.attachmentDir),
	};
	if (!config.username) throw new Error(`gmail: ${path}: set "username" to the Gmail address`);
	if (!Number.isInteger(config.port) || config.port <= 0) throw new Error(`gmail: ${path}: port must be a positive integer`);
	return config;
}
