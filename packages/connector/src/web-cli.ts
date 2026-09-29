import { startBridge } from "./bridge.ts";

const USAGE = `usage: pi-bots-web [--host <host>] [--port <port>] [--web-dir <path>]

Serves the bot list on /api/bots, the built web app, and relays
/ws?bot=<name>[&session=<uuid>] to the bot's server. Defaults to
127.0.0.1:8787 and packages/web/dist.
`;

function parseArgs(args: string[]): { host?: string; port?: number; webDir?: string } {
  let host: string | undefined;
  let port: number | undefined;
  let webDir: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--host") {
      host = args[++index];
      if (host === undefined) throw new Error("--host needs a value");
    } else if (arg === "--port") {
      const value = args[++index];
      if (value === undefined) throw new Error("--port needs a value");
      port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port '${value}'`);
    } else if (arg === "--web-dir") {
      webDir = args[++index];
      if (webDir === undefined) throw new Error("--web-dir needs a value");
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else {
      throw new Error(`unexpected argument '${arg}'`);
    }
  }
  return { host, port, webDir };
}

export async function main(args: string[]): Promise<number> {
  const { host, port, webDir } = parseArgs(args);
  const bridge = await startBridge({
    port: port ?? 8787,
    ...(host === undefined ? {} : { host }),
    ...(webDir === undefined ? {} : { webDir }),
  });
  console.log(`pi-bots-web listening on http://${bridge.host}:${bridge.port}`);
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void bridge.close().then(resolve, resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`pi-bots-web: ${message}\n`);
  process.exitCode = 1;
}
