import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { resolveAttach, type AttachTarget } from "./launcher.ts";
import { isValidBotName } from "./paths.ts";
import { listBots, readRoute, type BotInfo } from "./registry.ts";
import { isValidSessionId, readSession } from "./sessions.ts";

// The bridge is the only web-facing process. It reads the connector state files
// for the bot list and relays one WebSocket per session to the bot's unix
// socket. Bytes pass through untouched; everything above them is the pi
// protocol, which is the browser client's business.

export interface BridgeLauncher {
  resolveAttach(name: string, options?: { new?: boolean; sessionId?: string }): Promise<AttachTarget>;
}

export interface BridgeOptions {
  readonly port: number;
  readonly host?: string;
  /** Static app directory; defaults to packages/web/dist. */
  readonly webDir?: string;
  /** Overridable for tests; the default spawns real servers. */
  readonly launcher?: BridgeLauncher;
}

export interface Bridge {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function startBridge(options: BridgeOptions): Promise<Bridge> {
  const launcher = options.launcher ?? { resolveAttach };
  const webDir = resolve(options.webDir ?? join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "web", "dist"));
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer((request, response) => handleRequest(request, response, webDir));
  server.on("upgrade", (request, socket, head) => {
    void handleUpgrade(request, socket, head, launcher, wss);
  });

  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;

  return {
    host,
    port,
    async close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function handleRequest(request: IncomingMessage, response: ServerResponse, webDir: string): void {
  const url = new URL(request.url ?? "/", "http://bridge");
  if (request.method === "GET" && url.pathname === "/api/bots") {
    sendJson(response, 200, { bots: listBots().map(summarizeBot) });
    return;
  }
  if (request.method === "GET" || request.method === "HEAD") {
    serveStatic(request, response, webDir, url.pathname);
    return;
  }
  sendJson(response, 404, { error: "not found" });
}

function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  webDir: string,
  pathname: string,
): void {
  if (!existsSync(webDir)) {
    sendText(response, 503, "web app not built: run `bun run build` from the repo root\n");
    return;
  }
  const relative = decodeURIComponent(pathname).replace(/^\/+/, "");
  const target = resolve(webDir, relative === "" || relative.endsWith("/") ? `${relative}index.html` : relative);
  if (target !== webDir && !target.startsWith(webDir + sep)) {
    sendText(response, 404, "not found\n");
    return;
  }
  if (!existsSync(target) || statSync(target).isDirectory()) {
    sendText(response, 404, "not found\n");
    return;
  }
  const size = statSync(target).size;
  response.writeHead(200, { "content-type": contentType(target), "content-length": size });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(target).pipe(response);
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json";
    case ".map":
      return "application/json";
    case ".svg":
      return "image/svg+xml";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

function sendText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

function summarizeBot(bot: BotInfo): Record<string, unknown> {
  const route = readRoute(bot.name);
  const session = readSession(bot.name);
  return {
    name: bot.name,
    dir: bot.dir,
    running: route !== undefined,
    serverId: route?.serverId ?? null,
    pid: route?.pid ?? null,
    startedAt: route?.startedAt ?? null,
    lastSession:
      session === undefined ? null : { sessionId: session.sessionId, updatedAt: session.updatedAt },
  };
}

async function handleUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  launcher: BridgeLauncher,
  wss: WebSocketServer,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://bridge");
  if (url.pathname !== "/ws") {
    rejectUpgrade(socket, 404, "not found");
    return;
  }
  const bot = url.searchParams.get("bot") ?? "";
  if (!isValidBotName(bot)) {
    rejectUpgrade(socket, 400, "invalid bot name");
    return;
  }
  const session = url.searchParams.get("session");
  if (session !== null && !isValidSessionId(session)) {
    rejectUpgrade(socket, 400, "invalid session id");
    return;
  }

  let target: AttachTarget;
  try {
    // Starts the bot's server when it is not running, like `pi-bot attach`.
    target = await launcher.resolveAttach(bot, session === null ? {} : { sessionId: session });
  } catch (error) {
    rejectUpgrade(socket, 502, error instanceof Error ? error.message : "could not start the bot");
    return;
  }
  if (socket.destroyed) return;
  try {
    wss.handleUpgrade(request, socket, head, (ws) => relay(ws, target));
  } catch {
    socket.destroy();
  }
}

function relay(ws: WebSocket, target: AttachTarget): void {
  const upstream = connect(target.socketPath);
  let closed = false;
  const shutdown = (): void => {
    if (closed) return;
    closed = true;
    upstream.destroy();
    ws.close();
  };

  upstream.on("connect", () => {
    upstream.on("data", (chunk: Buffer) => {
      ws.send(chunk, (error) => {
        if (error) {
          shutdown();
          return;
        }
        if (upstream.isPaused()) upstream.resume();
      });
      // The ws send queue is unbounded; when a frame is still buffered, stop
      // reading the upstream socket until the send callback runs.
      if (ws.bufferedAmount > 0) upstream.pause();
    });
  });
  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (!isBinary) {
      // The channel is the raw byte stream; control goes over HTTP.
      shutdown();
      return;
    }
    if (!upstream.write(rawToBuffer(data))) ws.pause();
  });
  upstream.on("drain", () => ws.resume());
  upstream.on("error", shutdown);
  upstream.on("close", shutdown);
  ws.on("error", shutdown);
  ws.on("close", shutdown);
}

function rawToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const body = JSON.stringify({ error: message });
  socket.end(
    `HTTP/1.1 ${status} ${statusText(status)}\r\n` +
      "content-type: application/json\r\n" +
      `content-length: ${Buffer.byteLength(body)}\r\n` +
      "connection: close\r\n\r\n" +
      body,
  );
}

function statusText(status: number): string {
  if (status === 400) return "Bad Request";
  if (status === 404) return "Not Found";
  return "Bad Gateway";
}
