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
  this package passes `exposure: toolExposure()`, so `PI_TOOL_EXPOSURE` can
  take the whole package out of the prompt. A tool that calls
  `pi.setActiveTools()` on itself must skip that when the exposure is not
  `direct`. See [docs/minimal.md](docs/minimal.md).
- **Skills are user-invoked**: every `SKILL.md` sets
  `disable-model-invocation: true`. A skill that must fire on its own drops
  that line, and the reason belongs in the same commit.
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
| `minimal/` | the trial profile: `SYSTEM.md` template and `install.sh` for `~/.pi/minimal` |
| `docs/` | [configuration](docs/configuration.md), [development](docs/development.md), [minimal profile](docs/minimal.md), [design notes](docs/design-notes.md) |
| `package.json` | declares `./extensions` and `./skills`; peer deps come from the host |
