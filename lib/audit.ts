/**
 * lib/audit — append-only JSONL audit log shared by the personal-bot
 * extensions (Gmail, calendar).
 *
 * The point is accountability, not durability: every mutating (and read)
 * operation is recorded with its parameters, the file is a ring buffer of the
 * last `limit` entries, and a write failure is reported but never breaks the
 * tool call that triggered it.
 */
import * as fs from "node:fs";
import { dirname } from "node:path";

export interface AuditLog {
	write(entry: Record<string, unknown>): void;
	tail(limit?: number): Record<string, unknown>[];
}

export function createAuditLog(path: string, limit = 100): AuditLog {
	const write = (entry: Record<string, unknown>): void => {
		try {
			fs.mkdirSync(dirname(path), { recursive: true });
			let lines: string[] = [];
			try {
				lines = fs.readFileSync(path, "utf8").split("\n").filter((line) => line.trim());
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			}
			lines.push(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
			fs.writeFileSync(path, `${lines.slice(-limit).join("\n")}\n`);
		} catch (err) {
			process.stderr.write(`audit: write to ${path} failed: ${(err as Error).message}\n`);
		}
	};

	const tail = (count = limit): Record<string, unknown>[] => {
		try {
			const lines = fs.readFileSync(path, "utf8").split("\n").filter((line) => line.trim());
			return lines.slice(-count).map((line) => JSON.parse(line) as Record<string, unknown>);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw err;
		}
	};

	return { write, tail };
}
