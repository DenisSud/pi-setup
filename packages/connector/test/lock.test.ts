import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireLock } from "../src/lock.ts";

function lockPath(): string {
  return join(mkdtempSync(join(tmpdir(), "connector-lock-")), "test.lock");
}

test("acquire and release, then acquire again", async () => {
  const path = lockPath();
  const first = await acquireLock(path);
  first.release();
  const second = await acquireLock(path);
  second.release();
});

test("release is idempotent", async () => {
  const path = lockPath();
  const lock = await acquireLock(path);
  lock.release();
  lock.release();
});

test("a held lock blocks another acquire until timeout", async () => {
  const path = lockPath();
  const lock = await acquireLock(path);
  await assert.rejects(acquireLock(path, { timeoutMs: 120, retryMs: 10 }), /timed out waiting for lock/);
  lock.release();
});

test("a dead holder is taken over", async () => {
  const path = lockPath();
  writeFileSync(path, JSON.stringify({ pid: 2 ** 30, token: "dead" }));
  const lock = await acquireLock(path, { timeoutMs: 500, retryMs: 10 });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).token !== "dead", true);
  lock.release();
});

test("an old lock with a live pid is taken over after staleMs", async () => {
  const path = lockPath();
  writeFileSync(path, JSON.stringify({ pid: process.pid, token: "old" }));
  const past = new Date(Date.now() - 10_000);
  utimesSync(path, past, past);
  const lock = await acquireLock(path, { staleMs: 5_000, timeoutMs: 500, retryMs: 10 });
  lock.release();
});

test("release does not remove a successor's lock", async () => {
  const path = lockPath();
  const first = await acquireLock(path);
  rmSync(path); // simulate a stale takeover
  const second = await acquireLock(path);
  first.release();
  const holder = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(typeof holder.token, "string");
  second.release();
});
