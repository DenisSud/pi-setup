# pi-setup

Denis's personal [pi](https://pi.dev) package: the extensions and skills the
personal agent loads, on every device. Install it once per agent dir; the
content syncs through git, the machine-local settings do not.

## Install

```sh
pi install ssh://git@git.sudakov.site:2223/DenisSud/pi-setup.git
```

Project scope, or a specific ref:

```sh
pi install -l ssh://git@git.sudakov.site:2223/DenisSud/pi-setup.git
pi install ssh://git@git.sudakov.site:2223/DenisSud/pi-setup.git@v1
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
| `security` | Bitwarden (`rbw`) secrets profiles, output redaction, credential-store guard |
| `sysinfo` | injects OS/hardware/time/locale as `<system_info>`; GPU VRAM cached per UUID |
| `web-search` | `web_search` (SearXNG) + `web_fetch` (trafilatura/pandoc, pdftotext) |
| `mem0` | semantic memory: auto-recall + batched auto-capture + `mem0_memory` tool |
| `calendar` | CalDAV (Radicale) tools: list/read/create/update/delete |
| `gmail` | Gmail IMAP read + drafts only (no send, no delete-received) |

`security` and `mem0` share `~/.pi/agent/security.json`. No ptc; no systemone
(the guard was retired, mem0 speaks pi's native System One endpoint directly).

### Lib

| file | what it does |
|---|---|
| `lib/audit.ts` | append-only JSONL audit log (ring buffer) shared by calendar + gmail |

### Skills

- **engineering:** code-review, diagnosing-bugs, domain-modeling, implement,
  implement-spec, pr, prototype, retro, to-spec, to-tickets, triage, wayfinder,
  wizard
- **productivity:** daily-planning, teach, tracker, wait-what, weekly-review,
  writing-for-agents
- **core:** grilling, handoff, self-improvement, show-me, skill-authoring

## Machine-local config

Nothing here reads config from the package directory — a git package is
cleaned on update. Per-device config lives in the agent dir:

| file | for |
|---|---|
| `~/.pi/agent/security.json` | secrets profiles |
| `~/.pi/agent/gmail.json` | Gmail address (required: `{"username": "…"}`) |
| `~/.pi/agent/calendar.json` | optional; sensible defaults for cal.sudakov.site |
| `~/.pi/agent/decision.json` | **retired** — safe to delete |

System dependencies (not npm): `rbw`, SearXNG, `trafilatura`, `pandoc`,
`poppler-utils`, `nvidia-smi`.

## Development

Each extension carries its own harness:

```sh
extensions/<name>/test/run.sh harness
```

The harnesses stub the pi API and the network; no vault access.
