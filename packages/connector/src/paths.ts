import { homedir } from "node:os";
import { join } from "node:path";

// Environment is read per call so tests and callers can point the state root
// at a temp dir after import.

export function stateRoot(): string {
  return process.env.PI_CONNECTOR_DIR ?? join(homedir(), ".pi", "bots");
}

export function botsHome(): string {
  return process.env.PI_BOTS_HOME ?? join(homedir(), "Bots");
}

export function serversDir(): string {
  return join(stateRoot(), "servers");
}

// One logical server per bot: a shared PI_SERVER_DIR would collide on
// default-server-id, and session workers inherit the server environment.
export function serverDir(name: string): string {
  return join(serversDir(), assertBotName(name));
}

export function logsDir(): string {
  return join(stateRoot(), "logs");
}

export function logPath(name: string): string {
  return join(logsDir(), `${assertBotName(name)}.log`);
}

export function locksDir(): string {
  return join(stateRoot(), "locks");
}

export function lockPath(name: string): string {
  return join(locksDir(), `${assertBotName(name)}.lock`);
}

// The pi source checkout that runs the experimental server and client.
export function sourceDir(): string {
  return process.env.PI_SOURCE_DIR ?? join(homedir(), "dev", "pi");
}

export function routesDir(): string {
  return join(stateRoot(), "routes");
}

export function sessionsDir(): string {
  return join(stateRoot(), "sessions");
}

export function routePath(name: string): string {
  return join(routesDir(), `${assertBotName(name)}.json`);
}

export function sessionPath(name: string): string {
  return join(sessionsDir(), `${assertBotName(name)}.json`);
}

// A bot name is a directory name, so it is also a file name here. First char
// must be alphanumeric: no dotfiles, no "..", no separators.
const BOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidBotName(name: string): boolean {
  return BOT_NAME.test(name);
}

export function assertBotName(name: string): string {
  if (!isValidBotName(name)) throw new Error(`invalid bot name: ${JSON.stringify(name)}`);
  return name;
}
