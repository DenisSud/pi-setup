# AGENTS.md

Operating notes for AI agents working in this repo. Denis edits with pi; this file keeps any agent on the same conventions.

## What this repo is

The **base** of Denis's pi setup — the one thing every agent loads:

- **base** (this repo) — `extensions/`, `skills/`, `global/AGENTS.md` (the rules), shareable `settings.json`, and the bot tooling (`bin/pi-bot`, `bin/pi-bot-new`). Installed with `pi install <checkout>`.
- **bots** — `~/Bots/<name>`, **not here**. Each bot is a complete pi agent dir and its own local git repo, run with `pi-bot <name>`. Moved out of this repo 2026-09-23.
- **docs** — `~/Bots/docs`: how the system works and why.
- **registry** — `registry/`: promotion policy for reusable skills/extensions; deferred, no implementation.

## Hard rules

- **Keep secrets out.** No passwords/API keys in this repo (memory notes included) — credentials live in Bitwarden (folder `pi`) and reach a command only through the `security` extension's secrets profiles (`bash { secrets: "<profile>" }`, ptc `secrets_sh`); never print, copy, or paste secret values into notes, prompts, commits, or replies.
- Extensions import only from the aliased packages: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`, `typebox`. No new npm dependencies. Skills are markdown.
- Run extension tests before committing: `extensions/<name>/test/run.sh harness` (no network).
- Commit with short descriptive messages; push after committing.

## Load-bearing copy

Tool `description`, `promptSnippet`, and `promptGuidelines` are rendered verbatim into the agent's system prompt. They are **instructions the model follows literally** — editing them changes agent behavior more than any code path. Phrasing is load-bearing:

- **sysinfo** — read-only machine facts injected into the system prompt; keep it fast and side-effect-free.
- **house-rules** — injects `global/AGENTS.md` verbatim into the system prompt of *every* agent that loads this package, bots included. That file is the rules for all of Denis's agents; edit it deliberately.

## Bots

Bots live in `~/Bots/<name>` — a pi agent dir: `APPEND_SYSTEM.md` (persona), `skills/`, `extensions/`, `settings.json` (lists this package), `package.json` (this repo as a `file:` dependency, so bot code can `import ... from "pi-bots/extensions/..."`), `memory/` (own clone), `sessions/`, symlinks to the shared `auth.json` / `models.json` / `models-store.json` / `trust.json`.

- Scaffold with `pi-bot new <name>`; run with `pi-bot <name>`.
- Never put bot-specific content in the base: the base is only what *every* agent needs.
- `APPEND_SYSTEM.md` is rendered verbatim into the system prompt — edit deliberately.
- Bot repos start local-first; the current fleet has private Forgejo remotes (`DenisSud/bot-<name>`, docs `bots-docs`) so pc and g14 stay in sync — pull --rebase before editing, push after.

## Repo layout

- `extensions/<name>/` — `index.ts` (factory exporting default), `test/harness.mjs`, `test/run.sh` (symlinks the aliased packages, runs harness / live).
- `skills/<name>/SKILL.md` — base skills. Format guide: `skills/skill-authoring/SKILL.md`.
- `bin/pi-bot`, `bin/pi-bot-new`, `fish/pi.fish`, `install.sh` — the `pi --bot <name>` / `pi-bot` tooling.
- `global/AGENTS.md` — the base rules, injected by `house-rules`.
- `package.json` — base pi package manifest (`pi.extensions`, `pi.skills`).

## Verify

- Wrapper: `fish -c 'pi --bot dev --version'`.
- Bot load: `pi-bot dev --no-session -p "List the skills available to you."` — asking the model is unreliable; for a mechanical check use `loadSkills()` from pi's `dist/core/skills.js` with `agentDir` set to the bot dir.
- Extension tests: `extensions/<name>/test/run.sh harness`.

## Related but separate

- `~/Bots/docs` — system docs and decisions (architecture, per-bot notes, migration).
- `~/Bots/docs/dist-sys-glossary.md` — distributed-systems vocabulary (Kleppmann CDS) to use when designing the connector/runtime; read it before architecture discussions.
- `~/.pi/agent/memory` — personal memory notes, a separate private git repo. When you change behavior agents rely on, update the relevant notes there and push both repos.
- `~/dev/bot` — the Grok-bot-style SaaS prototype this setup is meant to become.
