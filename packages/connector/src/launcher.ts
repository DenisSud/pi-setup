import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { getUnixSocketPath } from "@earendil-works/pi-server/unix";
import { acquireLock } from "./lock.ts";
import { botsHome, isValidBotName, lockPath, logPath, serverDir, sourceDir } from "./paths.ts";
import { clearRoute, readRoute, writeRoute } from "./registry.ts";
import { isValidSessionId, newSessionId, readSession, recordAttached } from "./sessions.ts";

// The launcher owns the process boundary: it ensures a bot's server is up and
// resolves which session a client should attach to. All decisions about state
// live in registry.ts and sessions.ts.

const READY_TIMEOUT_MS = 10_000;
const READY_RETRY_MS = 100;
const LOG_TAIL_LINES = 20;

export interface ServerHandle {
  serverId: string;
  socketPath: string;
  pid?: number;
  started: boolean;
}

export interface AttachTarget extends ServerHandle {
  bot: string;
  dir: string;
  sessionId: string;
}

export function requireBot(name: string): { name: string; dir: string } {
  if (!isValidBotName(name)) throw new Error(`unknown bot '${name}'`);
  const dir = join(botsHome(), name);
  if (!existsSync(join(dir, "settings.json"))) {
    throw new Error(`unknown bot '${name}' (no ${dir}/settings.json)`);
  }
  if (!existsSync(join(dir, "memory"))) {
    const remote = remoteUrl();
    throw new Error(
      `bot '${name}' has no memory clone at ${dir}/memory\n` +
        `        (not falling back to ~/.pi/agent/memory — that is shared)` +
        (remote === undefined ? "" : `\n        restore it: git clone ${remote} ${dir}/memory`),
    );
  }
  return { name, dir };
}

export async function probeServer(socketPath: string, serverId: string): Promise<boolean> {
  const client = new Client({
    serverId,
    transportFactory: createUnixTransportFactory({ path: socketPath }),
  });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.dispose();
  }
}

/** Ensure the bot's server is running and reachable, spawning it if needed. */
export async function ensureServer(name: string): Promise<ServerHandle> {
  const { dir } = requireBot(name);
  const running = readRoute(name);
  if (running && (await probeServer(running.socketPath, running.serverId))) {
    return { serverId: running.serverId, socketPath: running.socketPath, pid: running.pid, started: false };
  }

  const lock = await acquireLock(lockPath(name));
  try {
    const current = readRoute(name);
    if (current && (await probeServer(current.socketPath, current.serverId))) {
      return { serverId: current.serverId, socketPath: current.socketPath, pid: current.pid, started: false };
    }
    const serverId = current?.serverId ?? randomUUID();
    const socketPath = getUnixSocketPath(serverId, serverDir(name));
    // Route before spawn: a concurrent launcher sees a pending route and waits
    // for the socket instead of spawning a second server under a new id.
    writeRoute(name, { serverId, socketPath, startedAt: new Date().toISOString() });
    const pid = spawnServer({ name, dir, serverId });
    await waitReady({ name, socketPath, serverId, pid });
    writeRoute(name, { serverId, socketPath, pid, startedAt: new Date().toISOString() });
    return { serverId, socketPath, pid, started: true };
  } finally {
    lock.release();
  }
}

/** Ensure the server, then pick the session: explicit id, else the bot's default. */
export async function resolveAttach(
  name: string,
  options: { new?: boolean; sessionId?: string } = {},
): Promise<AttachTarget> {
  const { dir } = requireBot(name);
  if (options.sessionId !== undefined && !isValidSessionId(options.sessionId)) {
    throw new Error(`invalid session id: ${JSON.stringify(options.sessionId)}`);
  }
  const server = await ensureServer(name);
  const pointer = options.new ? undefined : readSession(name);
  const sessionId = options.sessionId ?? pointer?.sessionId ?? newSessionId();
  // Record before attach: a crash between the two leaves a pointer that the
  // next attach materializes under the same id, so retries never fork sessions.
  recordAttached(name, { serverId: server.serverId, sessionId });
  return { bot: name, dir, sessionId, ...server };
}

/** Run the experimental client for the target, inheriting the terminal. */
export function runClient(target: AttachTarget, args: readonly string[] = []): number {
  const result = spawnSync(
    join(sourceDir(), "pi-test.sh"),
    ["client", "--connect", `unix://${target.socketPath}`, "--session-id", target.sessionId, ...args],
    { stdio: "inherit", env: botEnv(target.bot, target.dir) },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/**
 * Stop the bot's server. The route pid is only signalled after checking it is
 * still our server process (via /proc cmdline), so a recycled pid is safe.
 */
export async function stopServer(name: string): Promise<{ stopped: boolean; pid?: number }> {
  const route = readRoute(name);
  if (route === undefined) return { stopped: false };
  const pid = route.pid;
  let stopped = false;
  if (pid !== undefined && isOurServer(pid, name)) {
    try {
      process.kill(pid, "SIGTERM");
      stopped = true;
    } catch {
      // already gone
    }
    const deadline = Date.now() + 3_000;
    while (stopped && isAlive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (stopped && isAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  clearRoute(name);
  return { stopped, pid };
}

// The server rewrites its process title to "pi", so cmdline says nothing.
// The environment is untouched: match the per-bot PI_SERVER_DIR and agent dir
// so a recycled pid is never signalled.
function isOurServer(pid: number, name: string): boolean {
  if (!isAlive(pid)) return false;
  try {
    const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    return (
      env.includes(`PI_SERVER_DIR=${serverDir(name)}`) &&
      env.includes(`PI_CODING_AGENT_DIR=${join(botsHome(), name)}`)
    );
  } catch {
    return false;
  }
}

function spawnServer({ name, dir, serverId }: { name: string; dir: string; serverId: string }): number {
  const checkout = sourceDir();  // Same argv pi-test.sh builds: node --import <source-resolver> cli.ts server.
  // Calling node directly keeps the pid ours; pi-test.sh would leave a shell.
  const argv = [
    "--import",
    pathToFileURL(join(checkout, "packages/coding-agent/src/experimental/source-resolver.ts")).href,
    join(checkout, "packages/coding-agent/src/experimental/cli.ts"),
    "server",
    "--server-id",
    serverId,
  ];
  const log = openSync(logPathFor(name), "a");
  try {
    const child = spawn(process.execPath, argv, {
      cwd: dir,
      detached: true,
      stdio: ["ignore", log, log],
      env: botEnv(name, dir),
    });
    child.unref();
    if (child.pid === undefined) throw new Error(`failed to spawn the server for '${name}'`);
    return child.pid;
  } finally {
    closeSync(log);
  }
}

function logPathFor(name: string): string {
  const path = logPath(name);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

function botEnv(name: string, dir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PI_EXPERIMENTAL: "1",
    PI_CODING_AGENT_DIR: dir,
    PI_MEMORY_DIR: join(dir, "memory"),
    PI_SERVER_DIR: serverDir(name),
    PI_BOT_NAME: name,
  };
}

async function waitReady({
  name,
  socketPath,
  serverId,
  pid,
}: {
  name: string;
  socketPath: string;
  serverId: string;
  pid: number;
}): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (await probeServer(socketPath, serverId)) return;
    if (!isAlive(pid)) throw new Error(`server for '${name}' exited during startup\n${logTail(name)}`);
    if (Date.now() >= deadline) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
      throw new Error(`timed out waiting for the server for '${name}'\n${logTail(name)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, READY_RETRY_MS));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function logTail(name: string): string {
  try {
    const lines = readFileSync(logPath(name), "utf8").trimEnd().split("\n");
    return lines.slice(-LOG_TAIL_LINES).join("\n");
  } catch {
    return "(no log)";
  }
}

function remoteUrl(): string | undefined {
  const result = spawnSync("git", ["-C", join(homedir(), ".pi", "agent", "memory"), "remote", "get-url", "origin"], {
    encoding: "utf8",
  });
  const url = result.status === 0 ? result.stdout.trim() : "";
  return url.length > 0 ? url : undefined;
}
