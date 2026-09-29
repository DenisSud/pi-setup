import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// Cross-process mutual exclusion over the state root. One lock file per bot,
// taken with O_EXCL so the filesystem is the arbiter. A holder that died or
// stopped refreshing is taken over after staleMs.

export interface Lock {
  release(): void;
}

export interface AcquireLockOptions {
  staleMs?: number;
  timeoutMs?: number;
  retryMs?: number;
}

interface LockFile {
  pid: number;
  token: string;
}

const STALE_MS = 30_000;
const TIMEOUT_MS = 30_000;
const RETRY_MS = 25;

export async function acquireLock(path: string, options: AcquireLockOptions = {}): Promise<Lock> {
  const staleMs = options.staleMs ?? STALE_MS;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const retryMs = options.retryMs ?? RETRY_MS;

  mkdirSync(dirname(path), { recursive: true });
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, token }));
      closeSync(fd);
      return {
        release(): void {
          // Only remove our own file: a stale takeover may have replaced it.
          if (readLockFile(path)?.token !== token) return;
          rmSync(path, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (isStale(path, staleMs)) {
      rmSync(path, { force: true });
      continue;
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for lock ${path}`);
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
}

function readLockFile(path: string): LockFile | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { pid, token } = parsed as Partial<LockFile>;
    if (typeof pid !== "number" || typeof token !== "string") return undefined;
    return { pid, token };
  } catch {
    return undefined;
  }
}

function isStale(path: string, staleMs: number): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return true; // gone between EEXIST and now
  }
  const holder = readLockFile(path);
  // A fresh unparseable file is a holder mid-write; only age makes it stale.
  if (holder === undefined) return Date.now() - mtimeMs > staleMs;
  if (!isAlive(holder.pid)) return true;
  return Date.now() - mtimeMs > staleMs;
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
