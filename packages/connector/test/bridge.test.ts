import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startBridge, type BridgeLauncher } from "../src/bridge.ts";
import { writeRoute } from "../src/registry.ts";
import { recordAttached } from "../src/sessions.ts";

const SERVER_ID = "6f1e4a7c-2b3d-4f5a-8c9d-0e1f2a3b4c5d";
const SESSION_ID = "3c5564b0-1f2e-4a3b-9c8d-7e6f5a4b3c2d";
const TIMEOUT_MS = 5_000;

function setupState(): void {
  const root = mkdtempSync(join(tmpdir(), "bridge-"));
  process.env.PI_CONNECTOR_DIR = join(root, "state");
  process.env.PI_BOTS_HOME = join(root, "bots");
}

function makeBot(name: string): void {
  const dir = join(process.env.PI_BOTS_HOME!, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), "{}\n");
}

async function echoUpstream(): Promise<{ server: Server; path: string }> {
  const root = mkdtempSync(join(tmpdir(), "bridge-upstream-"));
  const path = join(root, "upstream.sock");
  const server = createServer((socket) => {
    // The test tears the relay down by destroying its upstream socket.
    socket.on("error", () => {});
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { server, path };
}

function fakeLauncher(socketPath: string, calls: string[]): BridgeLauncher {
  return {
    async resolveAttach(name, options = {}) {
      calls.push(`${name}:${options.sessionId ?? "default"}`);
      if (name !== "echo") throw new Error(`unknown bot '${name}'`);
      return {
        bot: name,
        dir: "/fake",
        serverId: SERVER_ID,
        socketPath,
        sessionId: options.sessionId ?? SESSION_ID,
        started: false,
      };
    },
  };
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function expectUpgradeFailure(url: string): Promise<Event> {
  return withTimeout(
    new Promise<Event>((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onerror = (event) => resolve(event);
      ws.onopen = () => reject(new Error("expected the upgrade to fail"));
    }),
    "upgrade failure",
  );
}

function roundtrip(port: number, query: string, chunks: readonly Buffer[]): Promise<Buffer> {
  return withTimeout(
    new Promise<Buffer>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`);
      ws.binaryType = "arraybuffer";
      const expected = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const parts: Buffer[] = [];
      ws.onopen = () => {
        for (const chunk of chunks) ws.send(chunk);
      };
      ws.onmessage = (event) => {
        parts.push(Buffer.from(event.data as ArrayBuffer));
        if (parts.reduce((sum, part) => sum + part.length, 0) >= expected) {
          ws.close();
          resolve(Buffer.concat(parts));
        }
      };
      ws.onerror = () => reject(new Error("websocket failed before the echo completed"));
    }),
    "echo roundtrip",
  );
}

test("GET /api/bots summarizes bots, routes, and the last session", async () => {
  setupState();
  makeBot("alpha");
  writeRoute("alpha", {
    serverId: SERVER_ID,
    socketPath: "/tmp/alpha.sock",
    pid: 42,
    startedAt: "2026-09-28T12:00:00.000Z",
  });
  recordAttached("alpha", { serverId: SERVER_ID, sessionId: SESSION_ID });

  const bridge = await startBridge({ port: 0, launcher: fakeLauncher("/tmp/none.sock", []) });
  try {
    const response = await fetch(`http://127.0.0.1:${bridge.port}/api/bots`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { bots: Array<Record<string, unknown>> };
    assert.equal(body.bots.length, 1);
    const bot = body.bots[0]!;
    assert.equal(bot.name, "alpha");
    assert.equal(bot.dir, join(process.env.PI_BOTS_HOME!, "alpha"));
    assert.equal(bot.running, true);
    assert.equal(bot.serverId, SERVER_ID);
    assert.equal(bot.pid, 42);
    assert.deepEqual(bot.lastSession, {
      sessionId: SESSION_ID,
      updatedAt: (bot.lastSession as { updatedAt: string }).updatedAt,
    });
    assert.match((bot.lastSession as { updatedAt: string }).updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await bridge.close();
  }
});

test("the WebSocket relay carries bytes to the unix socket and back", async () => {
  setupState();
  const upstream = await echoUpstream();
  const calls: string[] = [];
  const bridge = await startBridge({ port: 0, launcher: fakeLauncher(upstream.path, calls) });
  try {
    const payload = Buffer.alloc(256 * 1024 + 13);
    for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;
    const echoed = await roundtrip(bridge.port, `?bot=echo&session=${SESSION_ID}`, [
      payload.subarray(0, 1024),
      payload.subarray(1024),
    ]);
    assert.deepEqual(echoed, payload);
    assert.deepEqual(calls, [`echo:${SESSION_ID}`]);
  } finally {
    await bridge.close();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  }
});

test("serves the built app and refuses path escapes", async () => {
  setupState();
  const webDir = mkdtempSync(join(tmpdir(), "bridge-web-"));
  writeFileSync(join(webDir, "index.html"), "<html>ok</html>\n");
  mkdirSync(join(webDir, "assets"));
  writeFileSync(join(webDir, "assets", "app.js"), "console.log(1)\n");
  const bridge = await startBridge({ port: 0, webDir, launcher: fakeLauncher("/tmp/none.sock", []) });
  try {
    const root = await fetch(`http://127.0.0.1:${bridge.port}/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(await root.text(), "<html>ok</html>\n");
    const script = await fetch(`http://127.0.0.1:${bridge.port}/assets/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type") ?? "", /javascript/);
    const escaped = await fetch(`http://127.0.0.1:${bridge.port}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`);
    assert.equal(escaped.status, 404);
  } finally {
    await bridge.close();
  }
});

test("reports a missing web build instead of failing", async () => {
  setupState();
  const missing = join(mkdtempSync(join(tmpdir(), "bridge-web-")), "nope");
  const bridge = await startBridge({ port: 0, webDir: missing, launcher: fakeLauncher("/tmp/none.sock", []) });
  try {
    const response = await fetch(`http://127.0.0.1:${bridge.port}/`);
    assert.equal(response.status, 503);
    assert.match(await response.text(), /bun run build/);
  } finally {
    await bridge.close();
  }
});

test("an unknown bot is rejected during the upgrade", async () => {
  setupState();
  const bridge = await startBridge({ port: 0, launcher: fakeLauncher("/tmp/none.sock", []) });
  try {
    await expectUpgradeFailure(`ws://127.0.0.1:${bridge.port}/ws?bot=nope`);
  } finally {
    await bridge.close();
  }
});

test("an invalid session id is rejected without starting anything", async () => {
  setupState();
  const calls: string[] = [];
  const bridge = await startBridge({ port: 0, launcher: fakeLauncher("/tmp/none.sock", calls) });
  try {
    await expectUpgradeFailure(`ws://127.0.0.1:${bridge.port}/ws?bot=echo&session=../../etc/passwd`);
    assert.deepEqual(calls, []);
  } finally {
    await bridge.close();
  }
});

test("text frames close the byte channel", async () => {
  setupState();
  const upstream = await echoUpstream();
  const bridge = await startBridge({ port: 0, launcher: fakeLauncher(upstream.path, []) });
  try {
    const closed = await withTimeout(
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws?bot=echo`);
        ws.onopen = () => ws.send("not bytes");
        ws.onclose = () => resolve();
        ws.onerror = () => reject(new Error("unexpected error"));
        ws.onmessage = () => reject(new Error("text frame was echoed back"));
      }),
      "text frame shutdown",
    );
    assert.equal(closed, undefined);
  } finally {
    await bridge.close();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  }
});
