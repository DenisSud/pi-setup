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
| `ocr` | `ocr`: PDF/image → markdown with Indra OCR, locally (Nix package, CPU, no network) |

### Lib

| file | what it does |
|---|---|
| `lib/audit.ts` | append-only JSONL audit log (ring buffer) shared by calendar + gmail |
| `lib/credentials.ts` | read required env vars, with an error that names the missing one |
| `lib/exposure.ts` | `PI_TOOL_EXPOSURE`: how much of a tool the model sees (`deferred` by default) |

### Skills

`skills/` holds the skills the agent discovers: `engineering/`,
`productivity/`, `creative/`, and tool skills at the top level
(`agent-browser`, `ascii-animation`, …).
Vault-only skills (``daily-planning``, ``weekly-review``, ``ocw-vault``) live in
the vault itself: `~/Documents/Notes/.pi/skills/`.
Each skill is a directory with a `SKILL.md` whose frontmatter names it and
describes it. The invocation split comes from [`mattpocock/skills`](https://github.com/mattpocock/skills),
where most of these files started, and is copied rather than re-derived: a
**user-invoked** skill orchestrates a flow the human picks, so it sets
`disable-model-invocation: true` and keeps a human-facing one-line description;
a **model-invoked** skill holds reusable discipline the agent has to reach on
its own, keeps a routing description with trigger branches, and is the only
kind another skill can call. 14 are model-invoked here, 17 are not.

The skills that are ours alone follow the same test: `agent-browser`,
`latex-pdf` and `self-improvement` are advertised, `ascii-animation`,
`show-me` and `skill-authoring` are not.

### Prompt and tool set

The package is built to keep the request small. Nothing here is declared to
the model: every tool registers with `exposure: "deferred"`, so it is reachable
as `tools.<name>(…)` inside a `codemode` script and appears neither in the
request nor in the codemode description (`searchTools()` and `ALL_TOOLS` find
it when the name is unknown). Only the 14 model-invoked skills are advertised,
and only as name, description and path: 6.4k characters, ~1.6k tokens on pi
1.4.0. All 31 would be 11.3k characters, ~2.8k tokens. `SYSTEM.md` in this repo
is the prompt.

Measured on pi 1.3.0, one trivial prompt from `/tmp`: 1.76k input tokens —
against ~11.3k for a prompt that declares 26 tools and lists 32 skills. After
the longer `SYSTEM.md` (551 words) and the 14 advertised skills, pi 1.4.0
reports 4.04k input tokens for the same probe, with the skills section at 6.4k
characters. The script-only shape is still about three times smaller than the
declaring one.

A device matches that shape with three things in `~/.pi/agent`:

| what | why |
|---|---|
| `SYSTEM.md` → symlink into this checkout | the prompt is versioned here, so a push plus `pi update` changes it with no copy step |
| `settings.json` → `"defaultTools": ["+codemode"]` | codemode is opt-in in pi; without it there is no way to reach the tools |
| `settings.json` → `"packages"` | only packages whose tools are script-only: this one, and the `pi-subagents` fork below |

```sh
ln -sf ~/.pi/agent/git/github.com/DenisSud/pi-setup/SYSTEM.md ~/.pi/agent/SYSTEM.md
```

`PI_TOOL_EXPOSURE=direct pi` declares every tool of this package in the request
for a session that should not need a script; `codemode` lists them in the
codemode description instead.

The trade is explicit: the agent does not suggest a skill, and nothing in the
prompt says a calendar exists. The user, a skill body, or a `searchTools()`
call has to name the tool.

### Subagents come from a fork

`subagent`, `bg_wait`, `subagent_supervisor` and `contact_supervisor` come from
[DenisSud/pi-subagents](https://github.com/DenisSud/pi-subagents), branch
`pi-setup`: upstream `v0.80.0` plus one patch. Upstream registers those tools
with `exposure: "model-only"` — declared to the model, invisible to a codemode
script. `model-only` becomes `deferred`, the activation helpers stop activating
script-only tools (naming one in `setActiveTools()` would only declare it), and
its two skills carry `disable-model-invocation: true` so `/skill:council-mode`
still works.

No setting can do this: `-subagent` removes the tool from codemode too
(`tools.subagent` is then undefined), and the package has no exposure knob.
Hence a fork rather than a config line. Child agents still get declared tools —
only the parent-facing registrations changed.

What the fork offers is then narrowed per device in
`~/.pi/agent/extensions/subagent/config.json`:

```json
{
  "disabledFeatures": ["missions", "lane-management", "lane-metadata", "external-machines"],
  "missions": { "enabled": false },
  "scheduledRuns": { "enabled": false }
}
```

That keeps workflow scripts, the budget/control knobs and agent management, and
drops missions (which otherwise records every delegation), worktrees/lanes and
remote machines: those actions disappear from the unknown-action list and their
parameters are rejected with an error naming the setting. It does **not** shrink
the prompt — `disabledFeatures` trims the tool declaration, which a deferred
tool never sends — so it is a guardrail, not a saving.

To follow a new upstream release: rebase `pi-setup` onto the new tag, keep the
`SCRIPT_ONLY_TOOL` replacements, push, then `pi update --extensions` on each
device.

### Local models (Nix)

Model binaries are Nix packages from this repo, so a device gets them the same
way on every architecture without pip, a venv or a GPU. Indra OCR is packaged
from source in [`nix/indra-ocr.nix`](nix/indra-ocr.nix) (nixpkgs' Python with
onnxruntime, opencv4 and pypdfium2) and exposed through `flake.nix`:

```sh
nix profile install ~/dev/pi-setup#indra-ocr      # ~/.nix-profile/bin/indra-ocr
nix run ~/dev/pi-setup#indra-ocr -- paper.pdf     # without installing
```

The models themselves download from Hugging Face on the first run (~76 MB,
cached in `$XDG_CACHE_HOME/huggingface`). The `ocr` tool calls `indra-ocr` from
`PATH`; `~/.pi/agent/ocr.json` can point `command` at a store path instead.
Measured here: 2 s for a 30-page digital PDF, 5 s for a 1.2 MB scan, Russian and
English text intact.

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
| `~/.pi/agent/ocr.json` | optional; OCR binary name, timeout, output cap and artifact directory |
| `~/.pi/agent/calendar.json` | optional; sensible defaults for cal.sudakov.site |
| `~/.pi/agent/extensions/subagent/config.json` | which pi-subagents features stay reachable on this device (missions/lanes/remote machines off) |
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
