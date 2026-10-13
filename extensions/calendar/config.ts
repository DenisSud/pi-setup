/**
 * calendar/config — where the personal calendar lives and who talks to it.
 *
 * No credentials here: the CalDAV user/password are read from the process
 * environment (the `env` extension copies ~/.pi/agent/env.json into it). The
 * variable names are configurable via `userVar` / `passwordVar`.
 *
 * Config file: ~/.pi/agent/calendar.json (override with CALENDAR_CONFIG).
 * Kept in the agent dir, never in the package: a git package is cleaned on
 * update, so nothing machine-local may live beside the source.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

export interface CalendarConfig {
	/** Server root, e.g. https://cal.sudakov.site (no trailing slash). */
	baseUrl: string;
	/** Calendar collection path, with leading and trailing slash. */
	collection: string;
	/** Env var holding the CalDAV user (env.json). */
	userVar: string;
	/** Env var holding the CalDAV password (env.json). */
	passwordVar: string;
	/** Timezone used for local input times and for display. */
	timezone: string;
	auditLog: string;
}

export function configPath(): string {
	return process.env.CALENDAR_CONFIG ?? join(os.homedir(), ".pi", "agent", "calendar.json");
}

const DEFAULTS: CalendarConfig = {
	baseUrl: "https://cal.sudakov.site",
	collection: "/denis/main/",
	userVar: "RADICALE_AGENT_USER",
	passwordVar: "RADICALE_AGENT_PASSWORD",
	timezone: "Europe/Moscow",
	auditLog: join(os.homedir(), ".local", "state", "pi-personal", "calendar-audit.jsonl"),
};

export function loadConfig(): CalendarConfig {
	const path = configPath();
	let raw: Record<string, unknown> = {};
	try {
		raw = JSON.parse(fs.readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new Error(`calendar: cannot read ${path}: ${(err as Error).message}`);
		}
	}
	const str = (key: keyof CalendarConfig): string => {
		const value = raw[key];
		if (value === undefined) return DEFAULTS[key];
		if (typeof value !== "string" || !value.trim()) throw new Error(`calendar: ${path}: ${key} must be a non-empty string`);
		return value.trim();
	};

	const collection = `/${str("collection").replace(/^\/+|\/+$/g, "")}/`;
	return {
		baseUrl: str("baseUrl").replace(/\/+$/, ""),
		collection,
		userVar: str("userVar"),
		passwordVar: str("passwordVar"),
		timezone: str("timezone"),
		auditLog: str("auditLog"),
	};
}
