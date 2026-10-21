# Minimal profile

A trial profile that keeps the agent's prompt almost empty: file and shell
work is direct, everything else — calendar, mail, web search — is reached from
a `codemode` script, and skills are invoked by name instead of advertised.

It lives in its own agent directory (`~/.pi/minimal`), so the daily setup in
`~/.pi/agent` is untouched and one environment variable switches between them.

## What it changes

| | daily profile | minimal profile |
|---|---|---|
| system prompt | `SYSTEM.md` (SOUL) | six lines (`minimal/SYSTEM.md`) |
| declared tools | 26 | `read`, `bash`, `edit`, `write`, `codemode` |
| package tools | `direct` | `deferred` (`PI_TOOL_EXPOSURE`) |
| skills | 32 advertised | 32, none advertised |
| package source | `git:github.com/DenisSud/pi-setup` | same git source, own clone |
| other packages | `pi-web-access`, `pi-subagents`, … | none |

`deferred` is the quietest exposure pi has: the tool is callable from a
codemode script (`tools.email_search({…})`) but is not declared in the request
and is not listed in the codemode description either. `searchTools("email")`,
`describeTool()`, `describeNamespace()` and `ALL_TOOLS` find it when the name
is not known.

Skills keep working as `/skill:<name>`: pi expands the command into the skill
body with its `location` and `baseDir`, so the full instructions arrive
without any of them sitting in the system prompt. The flag that does this is
`disable-model-invocation: true` in each `SKILL.md` — every skill in this repo
carries it.

## Install and run

```sh
./minimal/install.sh          # writes ~/.pi/minimal (idempotent)
~/.pi/minimal/pi              # pi with the minimal profile
```

The installer reads the daily profile to carry over `defaultProvider`,
`defaultModel`, `defaultThinkingLevel` and `theme`, copies `gmail.json` and
`calendar.json` if present, and symlinks `auth.json` and `models.json` so
provider credentials stay in one file. Re-running it regenerates
`settings.json`, `SYSTEM.md` and the wrapper, and leaves the copied configs
alone.

Credentials are not duplicated: the wrapper sets `PI_ENV_CONFIG` to the daily
`~/.pi/agent/env.json`.

The package is installed as `git:github.com/DenisSud/pi-setup` — the same source
the daily profile uses — so pi clones it per agent dir
(`~/.pi/minimal/git/github.com/DenisSud/pi-setup`) and keeps it at
`origin/main`. Nothing points at a working checkout, which is what makes the
install identical on every device: run `pi update` inside the profile to pull a
new push, and the profile keeps loading the same code as the daily one. The
`SYSTEM.md` skills pointer resolves into that clone, so it appears on the first
launch.

## How a request reaches a tool

1. The user types `/skill:email` (or names a skill in a sentence).
2. The skill body says which script to run.
3. The script calls `tools.email_search({ query: "…" })` and returns only what
   the model should see.

The same flow without a skill: ask for a codemode script that calls
`searchTools("calendar")` first.

## Measured cost

One trivial prompt, same model, run from `/tmp` (so no project instructions),
pi 1.3.0:

| | daily | minimal |
|---|---|---|
| system prompt sections | 9,020 chars | 810 chars |
| declared tool declarations | 33,482 chars | 5,328 chars |
| request input tokens | 11,349 | 1,749 |

Most of what is left in the minimal request is the `codemode` description
itself (~1.3k tokens); `codemode.inlineBudget` trims the part that lists
tools.

## What you give up

- **Skill routing.** The agent no longer sees the skill list, so it will not
  suggest or pick one on its own; you name it. Cross-skill references still
  work because `SYSTEM.md` points at the skills directory.
- **Tool recall.** Nothing in the prompt says a calendar exists. A skill, the
  user, or a `searchTools()` call has to put the name in front of the model.
- **Prompt guidelines.** `promptGuidelines` on undeclared tools never reach the
  model (they are still visible through `describeTool`).
- **Subagents.** `subagent` is out of the profile: it adds a tool and a
  delegation vocabulary the prompt does not carry.
- **Pi docs pointers.** `SYSTEM.md` replaces pi's preamble, and with it the
  built-in `tools`, `rules` and `docs` sections. Ask for pi docs by path when
  you need them.

## Making it less minimal

- **Advertise one skill**: delete its `disable-model-invocation` line.
- **List a tool in the codemode description**: `PI_TOOL_EXPOSURE=codemode`
  instead of `deferred` (~1.5k tokens for the current tools, capped by
  `codemode.inlineBudget`).
- **Declare a tool**: `PI_TOOL_EXPOSURE=direct`, or drop the variable for that
  extension by removing the `exposure:` line.
- **Back to the daily prompt**: `cp ~/.pi/agent/SYSTEM.md ~/.pi/minimal/`.
- **Remove the profile**: `rm -r ~/.pi/minimal`.
