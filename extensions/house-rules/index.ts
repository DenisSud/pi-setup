/**
 * house-rules — inject the base rules into every agent's system prompt.
 *
 * The rules live in one file (`global/AGENTS.md`) and reach every agent that
 * loads this package. That includes bots: a bot is its own agent dir, so pi
 * reads context files from there, and the copy under `~/.pi/agent/AGENTS.md`
 * is never seen. Injecting from the package keeps one source of truth — no
 * per-bot copies to sync.
 *
 * A missing rules file means every agent runs without the base rules, so that
 * failure is reported in the UI and on stderr, not swallowed.
 *
 * `PI_HOUSE_RULES` overrides the path (tests, or another rules file).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_RULES_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "global",
  "AGENTS.md",
);

function rulesPath(): string {
  return process.env.PI_HOUSE_RULES || DEFAULT_RULES_PATH;
}

function readRules(): string | null {
  try {
    const text = fs.readFileSync(rulesPath(), "utf8").trim();
    return text || null;
  } catch {
    return null;
  }
}

export default function houseRules(pi: ExtensionAPI) {
  let rules: string | null = null;
  let warned = false;

  function warnMissing(ctx: ExtensionContext) {
    const message = `house-rules: cannot read ${rulesPath()} — agents run without the base rules`;
    console.error(message);
    if (warned || !ctx.hasUI) return;
    warned = true;
    ctx.ui.notify(message, "error");
  }

  pi.on("session_start", async (_event, ctx) => {
    rules = readRules();
    if (!rules) warnMissing(ctx);
  });

  pi.on("before_agent_start", async (event) => {
    if (!rules) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n## House rules\n\n${rules}\n`,
    };
  });
}
