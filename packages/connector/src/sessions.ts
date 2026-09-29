import { randomUUID } from "node:crypto";
import { readJsonFile, writeJsonAtomic } from "./files.ts";
import { sessionPath } from "./paths.ts";

export interface SessionRef {
  serverId: string;
  sessionId: string;
  updatedAt: string;
}

export function newSessionId(): string {
  return randomUUID();
}

// Session ids become filenames and protocol addresses, so validate the shape
// before anything writes or dials with them.
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidSessionId(id: string): boolean {
  return SESSION_ID.test(id);
}

export function readSession(name: string): SessionRef | undefined {
  const raw = readJsonFile<Partial<SessionRef>>(sessionPath(name));
  if (!raw || typeof raw.serverId !== "string" || typeof raw.sessionId !== "string") {
    return undefined;
  }
  return {
    serverId: raw.serverId,
    sessionId: raw.sessionId,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
  };
}

// Last attached session becomes the bot's default. Sharded per bot, so this
// cannot lose a concurrent update for another bot; same-bot writes are
// last-write-wins by rename order.
export function recordAttached(name: string, ref: { serverId: string; sessionId: string }): void {
  writeJsonAtomic(sessionPath(name), {
    serverId: ref.serverId,
    sessionId: ref.sessionId,
    updatedAt: new Date().toISOString(),
  });
}
