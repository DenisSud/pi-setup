import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAttach, runClient, stopServer } from "./launcher.ts";
import { listBots } from "./registry.ts";

const BIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin");
// The fork's /bot and /new call back into this CLI; tell it where we are.
process.env.PI_BOT_BIN ??= join(BIN_DIR, "pi-bot");

const USAGE = `usage:
  pi-bot attach <bot> [--new]             attach to a bot (starts its server if needed)
  pi-bot message <bot> <text...> [--new]  send a prompt and print the reply
  pi-bot compact <bot> [--new]            compact the bot's session
  pi-bot stop <bot>                       stop the bot's server
  pi-bot resolve <bot> [--new]            ensure the server and resolve the session
  pi-bot list [--json]                    list bots (JSON for the TUI picker)
  pi-bot new <name>                       scaffold a new bot
  pi-bot <bot> [--new]                    same as attach
`;

function parseBotArgs(args: string[]): { name: string; fresh: boolean } {
  let name: string | undefined;
  let fresh = false;
  for (const arg of args) {
    if (arg === "--new") fresh = true;
    else if (name === undefined) name = arg;
    else throw new Error(`unexpected argument '${arg}'`);
  }
  if (name === undefined) throw new Error("missing bot name");
  return { name, fresh };
}

async function commandAttach(args: string[]): Promise<number> {
  const { name, fresh } = parseBotArgs(args);
  const target = await resolveAttach(name, { new: fresh });
  return runClient(target);
}

async function commandResolve(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const { name, fresh } = parseBotArgs(args.filter((arg) => arg !== "--json"));
  const target = await resolveAttach(name, { new: fresh });
  if (json) {
    console.log(
      JSON.stringify({
        bot: target.bot,
        dir: target.dir,
        serverId: target.serverId,
        socketPath: target.socketPath,
        sessionId: target.sessionId,
      }),
    );
  } else {
    console.log(`${target.bot}\t${target.sessionId}\t${target.socketPath}`);
  }
  return 0;
}

function commandNew(args: string[]): number {
  const script = join(BIN_DIR, "pi-bot-new");
  const result = spawnSync(script, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

async function commandCompact(args: string[]): Promise<number> {
  const { name, fresh } = parseBotArgs(args);
  const target = await resolveAttach(name, { new: fresh });
  return runClient(target, ["--compact"]);
}

async function commandMessage(args: string[]): Promise<number> {
  const fresh = args.includes("--new");
  const rest = args.filter((arg) => arg !== "--new");
  const name = rest[0];
  if (name === undefined) throw new Error("missing bot name");
  const text = rest.slice(1).join(" ");
  if (text.length === 0) throw new Error("missing message text");
  const target = await resolveAttach(name, { new: fresh });
  // "--" forces the text to be read as the prompt even if it starts with "-".
  return runClient(target, ["--", text]);
}

async function commandStop(args: string[]): Promise<number> {
  const { name } = parseBotArgs(args);
  const result = await stopServer(name);
  console.log(result.stopped ? `stopped ${name} (pid ${result.pid})` : `${name} not running`);
  return 0;
}

async function main(args: string[]): Promise<number> {
  const first = args[0];
  if (first === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }
  switch (first) {
    case "list": {
      const bots = listBots();
      if (args.includes("--json")) console.log(JSON.stringify(bots));
      else for (const bot of bots) console.log(bot.name);
      return 0;
    }
    case "new":
      return commandNew(args.slice(1));
    case "attach":
      return commandAttach(args.slice(1));
    case "message":
      return commandMessage(args.slice(1));
    case "compact":
      return commandCompact(args.slice(1));
    case "stop":
      return commandStop(args.slice(1));
    case "resolve":
      return commandResolve(args.slice(1));
    default:
      if (first.startsWith("-")) {
        process.stderr.write(USAGE);
        return 2;
      }
      return commandAttach(args); // sugar: pi-bot <bot>
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`pi-bot: ${message}\n`);
  process.exitCode = 1;
}
