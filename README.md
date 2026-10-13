# pi-setup

Denis's personal [pi](https://pi.dev) package: the extensions and skills the
personal agent loads, on every device. Install it once per agent dir; the
content syncs through git, the machine-local settings do not.

## Install

```sh
pi install git:github.com/DenisSud/pi-setup
```

Project scope, or a specific ref:

```sh
pi install -l git:github.com/DenisSud/pi-setup
pi install git:github.com/DenisSud/pi-setup@v1
```

Update / remove:

```sh
pi update --extensions          # pull the configured refs
pi remove <source>
```

Enable or disable individual resources with the native TUI:

```sh
pi config
```

## Contents

### Extensions

| extension | what it does |
|---|---|
| `web-search` | `web_search` (SearXNG) — source discovery only; reading pages is curl or the `agent-browser` skill |
| `mem0` | semantic memory: auto-recall + batched auto-capture + `mem0_memory` tool |
| `calendar` | CalDAV (Radicale) tools: list/read/create/update/delete |
| `gmail` | Gmail IMAP read + drafts only (no send, no delete-received) |

Credentials are plain environment variables: `calendar`, `gmail` and `mem0`
read them from `process.env`, and the third-party `pi-env` extension
(`npm:pi-env`, in `settings.json`'s `packages`) loads them from the `env` block
of `~/.pi/agent/settings.json` at startup. One machine-local file, no vault and
no prompt — the trade-off is that any process running as the same user can read
those values. No ptc; no systemone (mem0 speaks pi's native System One endpoint
directly).

### Lib

| file | what it does |
|---|---|
| `lib/audit.ts` | append-only JSONL audit log (ring buffer) shared by calendar + gmail |
| `lib/credentials.ts` | read required env vars, with an error that names the missing one |

### Skills

- **engineering:** code-review, diagnosing-bugs, domain-modeling, implement,
  implement-spec, pr, prototype, retro, to-spec, to-tickets, triage, wayfinder,
  wizard
- **productivity:** daily-planning, teach, tracker, wait-what, weekly-review,
  writing-for-agents
- **core:** grilling, handoff, self-improvement, show-me, skill-authoring
- **tools:** agent-browser (browser automation CLI; the skill points at
  `agent-browser skills get core` so it stays version-matched)

## Machine-local config

Nothing here reads config from the package directory — a git package is
cleaned on update. Per-device config lives in the agent dir:

| file | for |
|---|---|
| `~/.pi/agent/settings.json` | machine settings **and the `env` block with all credentials** (mode 600) |
| `~/.pi/agent/gmail.json` | Gmail address (required: `{"username": "…"}`) |
| `~/.pi/agent/calendar.json` | optional; sensible defaults for cal.sudakov.site |
| `~/.pi/agent/decision.json` | **retired** — safe to delete |

System dependencies (not npm): SearXNG, `nvidia-smi`, `agent-browser` and
`chromium` (the last two come from the NixOS config). `rbw`, `trafilatura`,
`pandoc` and `poppler-utils` were only needed by the retired secrets profiles
and `web_fetch` tool.

## Development

Each extension carries its own harness:

```sh
extensions/<name>/test/run.sh harness
```

The harnesses stub the pi API and the network — no credentials, no network.
The `live` variant of each reads the `env` block of `~/.pi/agent/settings.json`
the same way `pi-env` does in a session.
