# pi-setup — notes for agents

ship: local

This repo is Denis's personal pi package: extensions, shared lib and skills,
loaded from this checkout on each device. Read
[README.md](README.md) for the human entry point and the
[docs/](docs/) for detail. What follows is what an agent editing this repo must
know before touching it.

## Rules

- **Commit and push every change.** Pi refreshes this checkout with
  `git reset --hard <upstream>` and `git clean -fdx`, so unpushed commits,
  uncommitted edits and untracked files are deleted on the next refresh — they
  exist nowhere else. See
  [docs/development.md](docs/development.md#the-checkout-is-disposable).
- **Extensions keep their config in their own agent-dir file**
  (`~/.pi/agent/<name>.json`), never as a key in `settings.json`. Credentials go
  in `~/.pi/agent/env.json` and are read with `process.env`; `auth.json` belongs
  to pi's providers. See [docs/configuration.md](docs/configuration.md).
- **Extensions stay independent**: no imports across `extensions/*`. Shared code
  lives in `lib/` (and a shared npm package if it ever outgrows this repo).
- **A tool's exposure comes from `lib/exposure.ts`**: every `registerTool` in
  this package passes `exposure: toolExposure()`. The default is `deferred`
  (script-only, out of the prompt); `PI_TOOL_EXPOSURE=direct` declares the tools
  in the request. A tool that calls `pi.setActiveTools()` on itself must skip
  that when the exposure is not `direct`. See
  [docs/configuration.md](docs/configuration.md#tool-exposure).
- **Subagent tools come from a fork**, not upstream: `git:github.com/DenisSud/pi-subagents@pi-setup`
  is `v0.80.0` with `exposure: "deferred"` (its `SCRIPT_ONLY_TOOL`) on the
  parent-facing registrations, so a script reaches them and the prompt does not.
  Never install `npm:pi-subagents` — upstream's `model-only` exposure declares
  `subagent` in every request and hides it from codemode. Upgrade by rebasing
  the branch onto the new upstream tag. See [README.md](README.md#subagents-come-from-a-fork).
- **Our subagent profiles live in `agents/`**, declared under
  `pi.subagents.agents` in `package.json`. `subagents.disableBuiltins` is `true`,
  so this directory is the whole catalog: `reviewer`, `researcher`, `worker`,
  `demo-recorder`. The first three are copies of the profiles the
  `pi-subagents` fork bundles, shadowing them by name (package beats builtin);
  `demo-recorder` is ours alone, with no upstream to shadow, so it carries no
  diff to keep. Keep the other three's diff to the lines
  this setup needs and never fork a whole prompt for style. A per-task skill or
  tool loadout is a launch parameter (`skill`, `tools`), not an
  `agentOverrides` block: there is nothing to re-diff.
- **Two models on `opencode-go`, one for children.** `enabledModels` in the
  device's `~/.pi/agent/settings.json` scopes the session to
  `opencode-go/deepseek-v4.1-flash` and `opencode-go/kimi-k3.1-pro`;
  `subagents.modelScope` with `enforce` + `strict` allows only the flash model,
  so the `subagent` tool never runs a child on anything else. `delegate_task`
  resolves its own model and the scope does not reach it, so `PROMPT.md` carries
  the one-model rule for every path. Skills do not pass `model`. A new
  provider is one appended pattern, never a widened glob. See
  [docs/configuration.md](docs/configuration.md#models).
- **The prompt is `PROMPT.md`, installed as the agent-dir `AGENTS.md`.** pi
  has two mechanisms and we use the lighter one: `<agent-dir>/AGENTS.md` is user
  instructions loaded beside pi's own prompt, while `<agent-dir>/SYSTEM.md`
  *replaces* that prompt and takes the tool descriptions and docs paths with
  it. A device symlinks `PROMPT.md` to `~/.pi/agent/AGENTS.md`; do not add an
  `APPEND_SYSTEM.md`, a `.pi/SYSTEM.md` or any other layer above it. The repo's
  own `AGENTS.md` is this file, project notes, not the prompt.
- **Skills are user-invoked by default**: every `SKILL.md` sets
  `disable-model-invocation: true` unless the agent has to reach the skill on
  its own, or another skill does. The 20 that qualify drop the line and keep a
  trigger-shaped description; the split follows `mattpocock/skills` skill for
  skill, so check upstream before flipping one. `full-send`, `review-loop` and
  `babysit-pr` are advertised because their trigger is a spoken phrase, not a
  menu choice. `audit` and `debt` are the two procedures taken from
  [`DietrichGebert/ponytail`](https://github.com/DietrichGebert/ponytail) (MIT,
  credited in each `SKILL.md`); its always-on rule lives in `PROMPT.md` under
  `## Code`, not in a skill, so it cannot be forgotten.
  `npm run check:skills` guards the split, names and relative links;
  a change to skills is done when it passes. See [README](README.md#skills).
- **Model binaries are Nix packages**: an extension that needs a model runs a
  CLI built by `flake.nix` from `PATH` (configurable in its own agent-dir file,
  e.g. `ocr.json`), never a pip/venv install. A model is either pinned as a
  fixed-output derivation in `nix/` (`asr`: 640 MB, hermetic, no network at
  inference) or downloaded at runtime into the Hugging Face cache (`indra-ocr`
  does this itself).
- **Every extension carries its harness** at `extensions/<name>/test/run.sh`.
  A change is done when `harness` passes for every extension it touched, and
  `live` too when the change touches credentials or the network path.
- **Commit messages**: `<scope>: <subject>` — `env:`, `gmail:`, `calendar:`,
  `skills:`, `agents:`, `pi-setup:` (`git log` shows the style).
- **The workflow is three skills and a pointer**: `grill` (recon, then rounds)
  → `spec github|local` → `full-send <pointer>`. `full-send` never merges;
  github ends at an open PR, local at pushed `main`. `review-loop` is the
  independent check, capped at 3 rounds. Do not add a second skill that
  re-derives one of these steps.

## Layout

| path | what |
|---|---|
| `extensions/<name>/index.ts` | the extension factory pi calls |
| `extensions/<name>/test/` | harness (`run.sh harness`) and live variant |
| `lib/` | code shared by several extensions (`audit.ts`, `credentials.ts`, `exposure.ts`) |
| `skills/<group>/<name>/SKILL.md` | skills, discovered through their frontmatter |
| `PROMPT.md` | the prompt; devices symlink it to `~/.pi/agent/AGENTS.md` |
| `docs/` | [configuration](docs/configuration.md), [development](docs/development.md), [design notes](docs/design-notes.md) |
| `package.json` | declares `./extensions` and `./skills`; peer deps come from the host |
| `flake.nix`, `nix/` | model binaries the extensions shell out to (`indra-ocr`, `pi-asr`); bump the pinned input or hash, rebuild, reinstall on each device |
