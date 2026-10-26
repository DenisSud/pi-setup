# pi-setup — notes for agents

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
  `pi.subagents.agents` in `package.json`. They are copies of the profiles the
  `pi-subagents` fork bundles, shadowing them by name (package beats builtin),
  so a change there is a diff against upstream that has to be re-applied on
  every fork bump. Keep the diff to the lines this setup needs and never fork a
  whole prompt for style. When a skill list is the only difference, use
  `subagents.agentOverrides` in `settings.json` instead: upstream's prompt keeps
  tracking, and there is nothing to re-diff.
- **Skills are user-invoked by default**: every `SKILL.md` sets
  `disable-model-invocation: true` unless the agent has to reach the skill on
  its own, or another skill does. The 14 that qualify drop the line and keep a
  trigger-shaped description; the split follows `mattpocock/skills` skill for
  skill, so check upstream before flipping one. See [README](README.md#skills).
- **Model binaries are Nix packages**: an extension that needs a model runs a
  CLI built by `flake.nix` from `PATH` (configurable in its own agent-dir file,
  e.g. `ocr.json`), never a pip/venv install. Models download at runtime into
  the Hugging Face cache.
- **Every extension carries its harness** at `extensions/<name>/test/run.sh`.
  A change is done when `harness` passes for every extension it touched, and
  `live` too when the change touches credentials or the network path.
- **Commit messages**: `<scope>: <subject>` — `env:`, `gmail:`, `calendar:`,
  `skills:`, `pi-setup:` (`git log` shows the style).

## Layout

| path | what |
|---|---|
| `extensions/<name>/index.ts` | the extension factory pi calls |
| `extensions/<name>/test/` | harness (`run.sh harness`) and live variant |
| `lib/` | code shared by several extensions (`audit.ts`, `credentials.ts`, `exposure.ts`) |
| `skills/<group>/<name>/SKILL.md` | skills, discovered through their frontmatter |
| `SYSTEM.md` | the prompt; devices symlink it into `~/.pi/agent` |
| `docs/` | [configuration](docs/configuration.md), [development](docs/development.md), [design notes](docs/design-notes.md) |
| `package.json` | declares `./extensions` and `./skills`; peer deps come from the host |
| `flake.nix`, `nix/` | model binaries the extensions shell out to (`indra-ocr`); bump the input tag, rebuild, reinstall on each device |
