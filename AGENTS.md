# AGENTS.md

Operating notes for AI agents working in this repo. Denis edits with pi; this file keeps any agent on the same conventions.

## What this repo is

The `pi-setup` pi package: Denis's skills + extensions + shareable settings, installed via `pi install`. On the PC this checkout is registered in `~/.pi/agent/settings.json` as a **local path** — edits apply on `/reload` or restart, then are shared by pushing to `git.sudakov.site` (`DenisSud/pi-setup`).

## Hard rules

- **Private repo.** `skills/homelab/` contains real credentials (API keys, LAN/WAN access details). Never push to a public remote; never paste secrets into memory notes or elsewhere.
- Extensions import only from the aliased packages: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`, `typebox`. No new npm dependencies.
- Run extension tests before committing: `extensions/<name>/test/run.sh harness` (no network). Consult also has a `live` mode (needs `CONSULT_KEY`, costs ~$0.01).
- Commit with short descriptive messages; push after committing.

## Load-bearing copy: tool descriptions and guidelines

Tool `description`, `promptSnippet`, and `promptGuidelines` are rendered verbatim into the agent's system prompt. They are **instructions the model follows literally** — editing them changes agent behavior more than any code path. Phrasing is load-bearing:

- **bash-background** — the contract is *never poll a background job*. When a job finishes, the completion notification is fed back into the agent loop as a user message (new turn when idle via `triggerTurn`, queued continuation while streaming — verified in pi's `agent-session.sendCustomMessage` + `messages.convertToLlm`). The agent should continue working or end its turn. Do not reintroduce sleep-loop idioms ("wait: `while kill -0 …`") into the copy, and keep the "you will be re-invoked" framing in the tool result.
- **consult** — deliberately liberal posture: cheap (tens of cents), the default second opinion for any non-trivial decision. Do not reintroduce conservative gatekeeping ("only for big moments", "don't waste inference").
- **sysinfo** — read-only machine facts injected into the system prompt; keep it fast and side-effect-free.

## Repo layout

- `extensions/<name>/` — extension dirs: `index.ts` (factory exporting default), `test/harness.mjs` (drives real pi internals via symlinked packages), `test/run.sh` (sets up symlinks, runs harness / live).
- `skills/<name>/SKILL.md` — skills; the agent-facing index is generated from the skill registry, not from this repo. Format guide: `skills/writing-great-skills/SKILL.md`.
- `settings.json` + `install.sh` — shareable settings; repo values are defaults, the user's local keys win, `packages` is a union merge.
- `package.json` — pi package manifest (`pi.extensions`, `pi.skills`).

## Related but separate

- `~/.pi/agent/memory/` — personal memory notes, a separate git repo (`DenisSud/memory-notes`), synced across devices. When you change behavior agents rely on (e.g. extension contracts), update the relevant notes there and push both repos.
