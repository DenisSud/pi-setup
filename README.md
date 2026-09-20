# pi-setup

My complete [pi](https://pi.dev) setup as one installable package: skills,
extensions and shareable settings. One source of truth, no scattered packages.

## Contents

```
├── package.json          # pi package manifest (pi-package)
├── settings.json         # shareable settings (see "Settings")
├── install.sh            # merges settings.json into ~/.pi/agent/settings.json
├── global/AGENTS.md      # global instructions, symlinked to ~/.pi/agent/AGENTS.md
├── extensions/
│   ├── sysinfo/          # machine facts injected into the system prompt
│   ├── consult/          # second opinion from a frontier model
│   ├── web-search/       # web_search / web_fetch (local SearXNG + trafilatura)
│   └── ptc/              # programmatic tool calling (JS runner + built-ins)
└── skills/
    ├── codebase-design/                 # deep-module design vocabulary
    ├── cron-jobs/                       # systemd-timer cron jobs
    ├── devenv-nix/                      # devenv.nix standards
    ├── grilling/                        # stress-test plans and decisions
    ├── handoff/                         # handoff between sessions
    ├── homelab/                         # find infra facts, act safely
    ├── improve-codebase-architecture/
    ├── memory-review/                   # periodic note consolidation
    ├── research/                        # evidence-gated graph research + HTML report
    ├── resolving-merge-conflicts/
    ├── subagents/                       # delegate to fresh-context child agents
    ├── tdd/                             # test-driven development
    └── writing-great-skills/            # how to write skills
```

`web-search` expects a SearXNG instance (`SEARXNG_BASE_URL`, default
`http://127.0.0.1:8888`) and the `trafilatura` + `pdftotext`/`pandoc` binaries
for `web_fetch` (my NixOS module for that lives in the nixos-config repo).

## Install

```bash
# 1. skills + extensions
pi install git@github.com:DenisSud/pi-setup.git

# 2. (optional) shareable settings — merges, never clobbers
./install.sh
```

Or clone and register the checkout as a local path while developing:

```bash
git clone git@github.com:DenisSud/pi-setup.git
pi install /path/to/pi-setup
```

### Settings

`settings.json` ships opinionated defaults (`defaultModel`, `defaultProvider`,
`defaultThinkingLevel`, `hideThinkingBlock`, `theme`). `install.sh` merges them
into your `~/.pi/agent/settings.json`:

- your existing keys **win** (the repo provides defaults only),
- `packages` is a **union** (your entries are preserved),
- `auth.json`, `models.json`, `models-store.json` are **never touched**.

The shipped `defaultProvider: opencode-go` / `defaultModel` are my own setup —
adjust these to your provider/model after installing.

## Development

Register the checkout as a local path (`pi install /path/to/pi-setup`) and edits
apply on `/reload` or restart. Commit and push normally.
