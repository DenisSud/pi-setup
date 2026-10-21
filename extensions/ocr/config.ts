/**
 * ocr/config — where the OCR binary lives and how much of its output to return.
 *
 * The binary is a Nix package from this repo (`nix build .#indra-ocr`); the
 * command name is configurable so a device can point at a path instead.
 *
 * Config file: ~/.pi/agent/ocr.json (override with OCR_CONFIG).
 * Kept in the agent dir, never in the package: a git package is cleaned on
 * update, so nothing machine-local may live beside the source.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

export interface OcrConfig {
	/** Binary to execute (Indra OCR CLI). */
	command: string;
	/** Hard limit for one document. Indra reads ~1-2 s per page on this hardware. */
	timeoutMs: number;
	/** Output beyond this is written to a file and only the head is returned. */
	maxChars: number;
	/** Where truncated output is written. */
	artifactDir: string;
}

export function configPath(): string {
	return process.env.OCR_CONFIG ?? join(os.homedir(), ".pi", "agent", "ocr.json");
}

const DEFAULTS: OcrConfig = {
	command: "indra-ocr",
	timeoutMs: 300_000,
	maxChars: 20_000,
	artifactDir: join(os.homedir(), ".pi", "agent", "tmp", "ocr"),
};

export function loadConfig(): OcrConfig {
	const path = configPath();
	let raw: Record<string, unknown> = {};
	try {
		raw = JSON.parse(fs.readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new Error(`ocr: cannot read ${path}: ${(err as Error).message}`);
		}
	}

	const str = (key: string, fallback: string): string => {
		const value = raw[key];
		if (value === undefined) return fallback;
		if (typeof value !== "string" || !value.trim()) throw new Error(`ocr: ${path}: ${key} must be a non-empty string`);
		return value.trim();
	};
	const num = (key: string, fallback: number): number => {
		const value = raw[key];
		if (value === undefined) return fallback;
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
			throw new Error(`ocr: ${path}: ${key} must be a positive number`);
		}
		return value;
	};

	return {
		command: str("command", DEFAULTS.command),
		timeoutMs: num("timeoutMs", DEFAULTS.timeoutMs),
		maxChars: num("maxChars", DEFAULTS.maxChars),
		artifactDir: str("artifactDir", DEFAULTS.artifactDir),
	};
}
