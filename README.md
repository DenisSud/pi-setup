# pi-setup

Denis's complete [pi](https://pi.dev) setup as a single installable package: skills, extensions, and shareable settings. One source of truth, one repo, no scattered packages.

> ⚠️ **Private repo.** The `homelab` skill contains real credentials (API keys, LAN/WAN access details). Do not make this repo public without redacting them first.

## Contents

```
├── package.json          # pi package manifest (pi-package)
├── settings.json         # shareable settings (see "Settings" below)
├── install.sh            # merges settings.json into ~/.pi/agent/settings.json
├── extensions/
│   └── sysinfo/          # system info injected into the system prompt
└── skills/
    ├── codebase-design/  # deep-module design vocabulary
    ├── cron-jobs/        # systemd-timer cron jobs on NixOS
    ├── devenv-nix/       # devenv.nix standards
    ├── grilling/         # stress-test plans and decisions
    ├── handoff/          # handoff between sessions
    ├── homelab/          # RPi/PC infra, Jellyfin, torrent pipeline
    ├── improve-codebase-architecture/
    ├── research/         # delegated research against primary sources
    ├── resolving-merge-conflicts/
    ├── subagents/        # delegate to fresh-context child agents
    ├── tdd/              # test-driven development
    └── writing-great-skills/
```

## Install

```bash
# 1. Install the package (skills + extensions)
pi install ssh://git@git.sudakov.site:2223/DenisSud/pi-setup.git

# 2. (Optional) Apply the shareable settings — merges, never clobbers
./install.sh
```

Or clone and use a local path for live loading while developing:

```bash
git clone git@git.sudakov.site:DenisSud/pi-setup.git
pi install /path/to/pi-setup
```

### Settings

`settings.json` ships opinionated preferences (`defaultModel`, `defaultProvider`, `defaultThinkingLevel`, `hideThinkingBlock`, `theme`) plus the `pi-web-search` npm package. `install.sh` merges it into your `~/.pi/agent/settings.json`:

- your existing keys **win** (repo provides defaults only),
- `packages` is a **union** (your entries are preserved),
- `auth.json`, `models.json`, `models-store.json` are **never touched**.

Note: `defaultProvider: opencode-go` / `defaultModel: deepseek-v4.1-flash` are Denis's setup — the `opencode-go` provider definition lives in `models.json` which is intentionally not shipped. Adjust these two keys to your own provider/model after installing.

## Development workflow

The canonical remote is `git.sudakov.site`. On the PC the repo is checked out at `~/dev/pi-setup` and registered in `~/.pi/agent/settings.json` as a **local path** — edits apply immediately on `/reload` or restart, no re-pin needed. Changes are shared by pushing:

```bash
git add -A && git commit -m "..." && git push
```

## Personal (not shipped)

The following intentionally stay out of this repo:

- `~/.pi/agent/memory/` — personal memory notes, tracked in [`DenisSud/memory-notes`](https://git.sudakov.site/DenisSud/memory-notes)
- `~/.pi/agent/auth.json`, `models.json`, `models-store.json` — credentials and private model configs
- `sessions/`, `npm/` (installed deps), `git/` (pi's package clones)
