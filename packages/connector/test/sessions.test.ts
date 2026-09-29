import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { newSessionId, readSession, recordAttached } from "../src/index.ts";
import { sessionsDir } from "../src/paths.ts";

function setup(): void {
  const root = mkdtempSync(join(tmpdir(), "connector-"));
  process.env.PI_CONNECTOR_DIR = join(root, "state");
  process.env.PI_BOTS_HOME = join(root, "bots");
}

test("recordAttached then readSession round trip", () => {
  setup();
  assert.equal(readSession("dev"), undefined);

  recordAttached("dev", { serverId: "s1", sessionId: "session-a" });
  const ref = readSession("dev")!;
  assert.equal(ref.serverId, "s1");
  assert.equal(ref.sessionId, "session-a");
  assert.ok(!Number.isNaN(Date.parse(ref.updatedAt)));
});

test("same bot: last write wins", () => {
  setup();
  recordAttached("dev", { serverId: "s1", sessionId: "session-a" });
  recordAttached("dev", { serverId: "s1", sessionId: "session-b" });
  assert.equal(readSession("dev")!.sessionId, "session-b");
});

test("sharded: writes to different bots do not interfere", () => {
  setup();
  recordAttached("alpha", { serverId: "s1", sessionId: "session-a" });
  recordAttached("beta", { serverId: "s2", sessionId: "session-b" });
  assert.equal(readSession("alpha")!.sessionId, "session-a");
  assert.equal(readSession("beta")!.sessionId, "session-b");
});

test("missing and malformed state read as no pointer", () => {
  setup();
  mkdirSync(sessionsDir(), { recursive: true });
  writeFileSync(join(sessionsDir(), "broken.json"), "{oops");
  writeFileSync(join(sessionsDir(), "wrong.json"), JSON.stringify({ serverId: "s" }));
  assert.equal(readSession("broken"), undefined);
  assert.equal(readSession("wrong"), undefined);
  assert.equal(readSession("missing"), undefined);
});

test("newSessionId returns distinct UUIDs", () => {
  const a = newSessionId();
  const b = newSessionId();
  assert.match(a, /^[0-9a-f-]{36}$/);
  assert.notEqual(a, b);
});
