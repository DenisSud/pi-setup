/**
 * asr/config — where the transcription binary lives and how much of its
 * output to return.
 *
 * The binary is a Nix package from this repo (`nix build .#asr`); the command
 * name is configurable so a device can point at a store path instead.
 *
 * Config file: ~/.pi/agent/asr.json (override with ASR_CONFIG).
 * Kept in the agent dir, never in the package: a git package is cleaned on
 * update, so nothing machine-local may live beside the source.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

export interface AsrConfig {
	/** Binary to execute (pi-asr CLI). */
	command: string;
	/**
	 * Hard limit for one file. Measured here: ~27x realtime on a Ryzen, so
	 * 10 minutes covers a two-hour recording.
	 */
	timeoutMs: number;
	/** Transcript beyond this is written to a file and only the head is returned. */
	maxChars: number;
	/** Where truncated output is written. */
	artifactDir: string;
	/** Longest span decoded at once; longer audio is cut at silence. */
	chunkSeconds: number;
}

export function configPath(): string {
	return process.env.ASR_CONFIG ?? join(os.homedir(), ".pi", "agent", "asr.json");
}

const DEFAULTS: AsrConfig = {
	command: "pi-asr",
	timeoutMs: 600_000,
	maxChars: 40_000,
	artifactDir: join(os.homedir(), ".pi", "agent", "tmp", "asr"),
	chunkSeconds: 30,
};

export function loadConfig(): AsrConfig {
	const path = configPath();
	let raw: Record<string, unknown> = {};
	try {
		raw = JSON.parse(fs.readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new Error(`asr: cannot read ${path}: ${(err as Error).message}`);
		}
	}

	const str = (key: string, fallback: string): string => {
		const value = raw[key];
		if (value === undefined) return fallback;
		if (typeof value !== "string" || !value.trim()) throw new Error(`asr: ${path}: ${key} must be a non-empty string`);
		return value.trim();
	};
	const num = (key: string, fallback: number): number => {
		const value = raw[key];
		if (value === undefined) return fallback;
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
			throw new Error(`asr: ${path}: ${key} must be a positive number`);
		}
		return value;
	};

	return {
		command: str("command", DEFAULTS.command),
		timeoutMs: num("timeoutMs", DEFAULTS.timeoutMs),
		maxChars: num("maxChars", DEFAULTS.maxChars),
		artifactDir: str("artifactDir", DEFAULTS.artifactDir),
		chunkSeconds: num("chunkSeconds", DEFAULTS.chunkSeconds),
	};
}
