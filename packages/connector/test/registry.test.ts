import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clearRoute, listBots, readRoute, writeRoute } from "../src/index.ts";
import { routesDir } from "../src/paths.ts";

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), "connector-"));
  process.env.PI_CONNECTOR_DIR = join(root, "state");
  process.env.PI_BOTS_HOME = join(root, "bots");
  return root;
}

function makeBot(name: string): void {
  const dir = join(process.env.PI_BOTS_HOME!, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), "{}\n");
}

test("listBots finds dirs with settings.json, sorted, skips the rest", () => {
  setup();
  makeBot("beta");
  makeBot("alpha");
  mkdirSync(join(process.env.PI_BOTS_HOME!, "notabot"), { recursive: true });
  makeBot(".hidden");
  writeFileSync(join(process.env.PI_BOTS_HOME!, "file.txt"), "x");

  const bots = listBots();
  assert.deepEqual(
    bots.map((b) => b.name),
    ["alpha", "beta"],
  );
  assert.equal(bots[0]!.dir, join(process.env.PI_BOTS_HOME!, "alpha"));
  assert.equal(bots[0]!.hasRoute, false);

  writeRoute("alpha", { serverId: "s1", socketPath: "/tmp/a.sock" });
  assert.equal(listBots()[0]!.hasRoute, true);
});

test("listBots returns empty for a missing bots home", () => {
  setup();
  assert.deepEqual(listBots(), []);
});

test("route round trip, clear, missing and malformed reads", () => {
  setup();
  assert.equal(readRoute("alpha"), undefined);

  writeRoute("alpha", { serverId: "s1", socketPath: "/tmp/a.sock", pid: 42 });
  assert.deepEqual(readRoute("alpha"), {
    serverId: "s1",
    socketPath: "/tmp/a.sock",
    pid: 42,
  });

  clearRoute("alpha");
  assert.equal(readRoute("alpha"), undefined);
  clearRoute("alpha");

  mkdirSync(routesDir(), { recursive: true });
  writeFileSync(join(routesDir(), "broken.json"), "not json");
  writeFileSync(join(routesDir(), "wrong.json"), JSON.stringify({ serverId: 1 }));
  assert.equal(readRoute("broken"), undefined);
  assert.equal(readRoute("wrong"), undefined);
});

test("route writes are atomic and leave no temp files", () => {
  setup();
  writeRoute("alpha", { serverId: "s1", socketPath: "/tmp/a.sock" });
  writeRoute("alpha", { serverId: "s2", socketPath: "/tmp/a.sock" });
  assert.deepEqual(readdirSync(routesDir()), ["alpha.json"]);
  assert.equal(readRoute("alpha")!.serverId, "s2");
});

test("invalid bot names are rejected", () => {
  setup();
  for (const name of ["..", ".", ".hidden", "a/b", "", "a\\b"]) {
    assert.throws(() => readRoute(name), /invalid bot name/);
    assert.throws(() => writeRoute(name, { serverId: "s", socketPath: "x" }), /invalid bot name/);
  }
});
