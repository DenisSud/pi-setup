# pi-bots

The **base** of Denis's pi setup: the extensions and skills every agent gets,
the rules they all follow, and the tooling that runs the bots.

The bots themselves do **not** live here. A bot is a complete pi agent dir
(its own persona, skills, extensions, settings, sessions, memory clone) in its
own local git repo under `~/Bots/<name>`. This repo is the one thing they all
load.

## Layout

```
├── package.json          # base pi package manifest (pi-package) + bun workspaces
├── settings.json         # shareable defaults (model, provider, thinking, theme)
├── install.sh            # settings merge, package install, bot tooling, ~/Bots
├── devenv.nix            # dev shell: node + bun, extractors, one command per task
├── global/AGENTS.md      # the base rules — injected into every agent by house-rules
├── extensions/           # house-rules, security, ptc, sysinfo, web-search, memory
├── skills/               # skill-authoring, handoff, grilling
├── packages/connector/   # bot registry, launcher, bridge — the pi-bot implementation
├── packages/web/         # browser client served by the bridge
├── registry/             # promotion policy — deferred, see registry/README.md
├── bin/pi-bot            # attach / message / resolve / list / new (connector CLI)
├── bin/pi-bot-new        # the scaffold behind `pi-bot new`
├── bin/pi-bots-web       # bridge + web app server
└── fish/pi.fish          # fish function: pi --bot <name>
```

## Base

| extension | what it does |
|---|---|
| `house-rules` | injects `global/AGENTS.md` into the system prompt of every agent that loads this package |
| `security` | Bitwarden secrets profiles, output redaction, credential-store guards |
| `ptc` | programmatic tool calling |
| `sysinfo` | machine facts in the system prompt |
| `web-search` | `web_search` / `web_fetch` via a local SearXNG + trafilatura/pdftotext |

Skills: `skill-authoring` (how to write skills well), `handoff` (context
handoff between sessions), `grilling` (stress-test a plan one question at a
time). Everything domain-specific lives in a bot.

`web-search` expects a SearXNG instance (`SEARXNG_BASE_URL`, default
`http://127.0.0.1:8888`) and the `trafilatura` + `pdftotext`/`pandoc` binaries
for `web_fetch`. The devenv shell ships the extractors; the SearXNG module
lives in the nixos-config repo.

## Bots

| bot | job |
|---|---|
| `dev` | coding: skills, research, subagents |
| `time-management` | time management: the personal CalDAV calendar (`cal.sudakov.site`) |
| `contacts` | Gmail, read + drafts only |
| `homelab` | homelab services, media pipeline, troubleshooting |
| `memory` | curating the memory repo (`memory-review`) |
| `chief-of-staff` | owning the fleet, base and docs; orchestrating the other bots |

```bash
pi                  # base agent: base extensions + skills, shared memory
pi-bot dev          # a bot (also: pi --bot dev)
pi-bot list         # which bots exist
pi-bot new <name>   # scaffold one at ~/Bots/<name>
```

A bot run is just `PI_CODING_AGENT_DIR=~/Bots/<name>` — no `-e`, no
`--append-system-prompt`, no `--session-dir`. Pi reads the bot dir as its agent
dir: `APPEND_SYSTEM.md` is the persona, `skills/` and `extensions/` load like
any agent dir, `settings.json` pulls in this package, sessions stay local, and
`PI_MEMORY_DIR` points at the bot's own memory clone. Shared plumbing
(`auth.json`, `models.json`, `models-store.json`, `trust.json`) is symlinked
from `~/.pi/agent/`, so credentials, model catalogs and trust decisions are
common to all bots. Secrets profiles need no symlink at all: the security
extension reads the absolute `~/.pi/agent/security.json`.

Bots start **local-first**. When one must run on another machine, add a
private Forgejo remote — the current fleet uses `DenisSud/bot-<name>` (docs:
`bots-docs`) so pc and g14 share it. Pull --rebase before editing, push after.

## Install per machine

```bash
git clone ssh://git@git.sudakov.site:2223/DenisSud/pi-bots.git ~/dev/pi-bots
~/dev/pi-bots/install.sh
```

The installer registers the checkout as a **local path** (`pi install
/path/to/pi-bots`): base edits apply on `/reload` or restart, no push needed to
test.

It also puts `~/.pi/agent/bin` (where `pi-bot` lives) on PATH for interactive
shells — appends to `~/.zshrc`, writes `~/.config/fish/conf.d/pi-bots.fish` —
since pi only does that for the processes it spawns itself. `PI_NO_SHELL_RC=1`
skips it.

### Settings

`settings.json` ships defaults (`defaultModel`, `defaultProvider`,
`defaultThinkingLevel`, `hideThinkingBlock`, `theme`). `install.sh` merges them
into `~/.pi/agent/settings.json`: your existing keys **win**, `packages` is a
**union**, and `auth.json` / `models.json` / `models-store.json` are **never
touched**. `pi-bot new` copies these defaults into a new bot's
`settings.json` — a bot's settings are self-contained, since its agent dir
replaces `~/.pi/agent`.

### Rules

`global/AGENTS.md` is the single source for the base rules; the `house-rules`
extension appends it to the system prompt of every agent loading this package
(including bots, which never see `~/.pi/agent/AGENTS.md`). One file to edit,
nothing to sync.

## Add a bot

```bash
pi-bot new <name>          # scaffold ~/Bots/<name>
$EDITOR ~/Bots/<name>/APPEND_SYSTEM.md
pi-bot <name>              # run it
```

## Development

`devenv shell` gives you node 24 + bun, jq, shellcheck, watchexec and the
`web_fetch` extractors — no system packages needed beyond `pi` itself.
`bun install` re-runs when `bun.lock` changes.

Tasks are devenv scripts, all listed by `devenv info`:

| command | what it does |
|---|---|
| `check` | connector suite + every extension harness (the pre-commit gate) |
| `test-ext [name…]` | extension harnesses only — all, or named ones |
| `test-connector` | `node --test` for packages/connector |
| `test-web-search-live` | live web-search test (needs the local SearXNG) |
| `build` | bundle packages/web/dist |
| `web` | serve the app + bridge on 127.0.0.1:8787 |
| `web-watch` | rebuild the bundle while packages/web/src changes |
| `bot <name>` | this checkout's pi-bot (local connector source) |
| `lint` | shellcheck the entrypoints, `fish -n` the fish function |
| `doctor` | pi, the pi source checkout, bots root, SearXNG |
| `install-base` | run ./install.sh on this machine |

`devenv up` builds the web app and serves it; `devenv test` runs `check`.

Two host dependencies stay outside the devenv on purpose:

- **`pi`** — the extension test runners resolve the installed pi store from
  `command -v pi`, so tests run against the same pi the agents run. The devenv
  deliberately avoids `languages.javascript`, which prepends
  `node_modules/.bin` to PATH — bun's auto-installed peer `pi-coding-agent`
  would shadow the system binary there and the runners could not resolve a
  monorepo store. `doctor` reports the version in use.
- **the pi source checkout** — bots are spawned from `$PI_SOURCE_DIR`
  (default `~/dev/pi`) and the web bundle resolves `@pi/fork/*` there.

Register the checkout as a local path and edits apply on `/reload` or restart.
Run `check` before committing; commit and push normally.
