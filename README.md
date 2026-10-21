# pi-setup

Denis's personal [pi](https://pi.dev) package: the extensions, shared lib and
skills the personal agent loads, on every device. Install it once per agent dir;
the code syncs through git, the machine-local config does not.

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

Agents editing this repo: read [AGENTS.md](AGENTS.md) first — the checkout is a
cache of `origin/main` and pi deletes anything not pushed.

## Contents

### Extensions

| extension | what it does |
|---|---|
| `env` | loads `~/.pi/agent/env.json` into `process.env` at startup (names-only `/env` command) |
| `web-search` | `web_search` (SearXNG) — source discovery only; reading pages is curl or the `agent-browser` skill |
| `calendar` | CalDAV (Radicale) tools: list/read/create/update/delete |
| `gmail` | Gmail IMAP read + drafts only (no send, no delete-received) |

### Lib

| file | what it does |
|---|---|
| `lib/audit.ts` | append-only JSONL audit log (ring buffer) shared by calendar + gmail |
| `lib/credentials.ts` | read required env vars, with an error that names the missing one |
| `lib/exposure.ts` | `PI_TOOL_EXPOSURE`: how much of a tool the model sees (`direct` by default) |

### Skills

`skills/` holds the skills the agent discovers: `engineering/`,
`productivity/`, `creative/`, and tool skills at the top level
(`agent-browser`, `ascii-animation`, …).
Vault-only skills (``daily-planning``, ``weekly-review``, ``ocw-vault``) live in
the vault itself: `~/Documents/Notes/.pi/skills/`.
Each skill is a directory with a `SKILL.md` whose frontmatter names it and
describes it. Every skill here sets `disable-model-invocation: true`: it is
invoked with `/skill:<name>` and never advertised to the model.

### Minimal profile

`minimal/` installs a trial profile in `~/.pi/minimal` — six-line system
prompt, five declared tools, everything else reachable only from a `codemode`
script. From /tmp the request cost drops from ~11.3k to ~1.7k input tokens.
See [docs/minimal.md](docs/minimal.md).

```sh
./minimal/install.sh && ~/.pi/minimal/pi
```

## Conventions

- **One config file per extension**, in the agent dir: `env.json`, `gmail.json`,
  `calendar.json`. Extensions never add keys to `settings.json`;
  `auth.json` belongs to pi's providers. Details:
  [docs/configuration.md](docs/configuration.md).
- **Credentials are plain environment variables** in `~/.pi/agent/env.json`
  (mode 600), loaded by the `env` extension. No vault, no unlock prompt — the
  trade-off and its history: [docs/design-notes.md](docs/design-notes.md).
- **Extensions stay independent**; shared code lives in `lib/`.

## Machine-local files

| file | for |
|---|---|
| `~/.pi/agent/env.json` | **the credentials**: environment variables for bash and the extensions (mode 600; path override `PI_ENV_CONFIG`) |
| `~/.pi/agent/gmail.json` | Gmail address (required: `{"username": "…"}`) |
| `~/.pi/agent/calendar.json` | optional; sensible defaults for cal.sudakov.site |
| `~/.pi/agent/settings.json` | pi's own settings: model, theme, packages |
| `~/.pi/agent/security.json.retired` | the old vault mapping (variable → Bitwarden item); safe to delete |

Per-device files are not in git. On a new machine, copy them over.

## Development

```sh
extensions/<name>/test/run.sh harness    # mocked, no network, no credentials
extensions/<name>/test/run.sh live       # real server; needs env.json
```

[docs/development.md](docs/development.md) covers the harness/live split, the
package-refresh behaviour, and how to add an extension.

## Troubleshooting

| symptom | cause and fix |
|---|---|
| `X not set — add it to ~/.pi/agent/env.json` | variable missing from `env.json`; add it, then `/reload` |
| `web_search: cannot reach SearXNG` | the local SearXNG service is down (`services.searx`) |
| a skill or edit disappeared from this checkout | the package refresh reset it; see [AGENTS.md](AGENTS.md) — commit and push |
| `rbw` fails with `Inappropriate ioctl for device` | nothing in this package uses it any more; the diagnosis is in [docs/design-notes.md](docs/design-notes.md) |

## System dependencies

Not npm: SearXNG, `nvidia-smi`, and `agent-browser` + `chromium` from the NixOS
config. `rbw`, `trafilatura`, `pandoc` and `poppler-utils` were only needed by
the retired vault scripts and `web_fetch` tool.
