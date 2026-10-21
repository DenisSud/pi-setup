# Design notes

Why the package looks the way it does. Each note records the constraint that
shaped a decision, so the decision is not relitigated from scratch.

## Secrets: a vault was replaced by `env.json` (2026-10)

Until October 2026 credentials were resolved through Bitwarden (`rbw`) by a
`security` extension: named profiles in `~/.pi/agent/security.json`, values
fetched per call, output redaction, and a guard against reading credential
stores. It was removed for reliability.

What went wrong in practice: `rbw` keeps the decrypted vault in a separate
agent process. When that agent is locked — after a reboot, or once `lock_timeout`
expires — every read needs the master password, which `rbw` asks for through a
pinentry binary. NixOS installs only `pinentry-curses`, which needs a controlling
terminal, and pi runs commands with pipes, so the prompt failed with
`pinentry error: Inappropriate ioctl for device`. Session start resolves all
profiles up front, so the whole mechanism failed silently until a command
actually needed a credential. Even with a GUI pinentry the design wanted a human
present at unpredictable moments, which is the opposite of what an agent needs.

`env.json` plus the `env` extension trades that away deliberately: a plain file,
loaded once at startup, available to the shell and the extensions with no prompt
and no vault process. The price is explicit:

- the values sit in plain text in `~/.pi/agent/env.json` (mode 600), readable by
  anything running as the same user;
- every bash command inherits them;
- nothing redacts output any more, so a command that echoes a value puts it in
  the transcript.

The old profile names remain a flat namespace: the calendar's agent user needed
its own names (`RADICALE_AGENT_*`) because a flat environment cannot hold two
`RADICALE_USER` values. `~/.pi/agent/security.json.retired` keeps the mapping
from variable to Bitwarden item for reference; Bitwarden stays the backup of
record.

## `auth.json` stays pi's file

Pi keeps provider API keys and OAuth tokens in `<agent-dir>/auth.json`
(`/login`, `pi auth`), and MCP tokens in `mcp-auth.json`. It is written by pi,
keyed by provider, and has no API for extensions to add entries — writing into
it would risk collisions with pi's own writes. Extension credentials therefore
belong in the extension's file or in `env.json`.

## `web_search` finds, curl and `agent-browser` read (2026-10)

The first version of the web extension shipped `web_fetch` next to `web_search`:
a fetch plus a chain of system extractors (trafilatura, pandoc, pdftotext) and
its own size limits, timeouts and fallbacks. In practice the extractor chain was
a mediocre middle: it could not run JavaScript, could not interact with a page,
and its output quality varied per site, while `agent-browser` (a real browser
over CDP) and plain `curl` cover both ends properly. `web_fetch` was removed and
its system dependencies with it. The split now is:

- `web_search` — discovery: titles, URLs, snippets, nothing else;
- `curl` in bash — static HTML, JSON, APIs, one-off downloads;
- the `agent-browser` skill — anything that has to run or be driven.

## Extensions do not import each other

The old `security` extension doubled as a library: `calendar` and `gmail`
imported its `rbw.ts` and `config.ts` to resolve credentials, which is how one
extension's removal nearly broke two others. Extensions load as separate module
instances and can be enabled, disabled or deleted independently, so an import
across them invents a hidden dependency that the host does not know about.
Shared code belongs in `lib/` (or a shared npm package once it outgrows this
repo); shared *data* belongs in a file like `env.json` that each extension reads
on its own.

## The package trades discovery for prompt size (2026-10)

The prompt carried 32 skill entries (~7.8k characters) and 26 declared tools
(~33k characters), so a one-word question cost ~11.3k input tokens before the
conversation started. On any single turn almost none of it is used: the skill
list is routing for a model that already has the request, and the calendar and
mail descriptions are only needed once the task is about calendar or mail.

It started as a separate trial profile in `~/.pi/minimal`. The numbers held, so
the behaviour moved into the package: `deferred` is now the exposure default,
`SYSTEM.md` lives in this repo, and a device needs only
`defaultTools: ["+codemode"]`. No second agent dir, no wrapper to remember.

Both lists moved out of the prompt:

- **Skills** are invoked as `/skill:<name>` and carry
  `disable-model-invocation: true`, so pi does not advertise them. The command
  still expands the file with its `location`, so nothing else changes.
- **Tools** register with `exposure: "deferred"` (`PI_TOOL_EXPOSURE`), which
  keeps them callable as `tools.<name>(…)` from a codemode script and out of
  both the request and the codemode description. `searchTools()` and
  `ALL_TOOLS` still find them.

Why not an MCP server per tool: with `codemode` exposure an MCP server reaches
the same place, but every server also adds a line to the `mcp_servers` section
of the system prompt, and wrapping the existing TypeScript tools would add an
MCP SDK dependency and a second process for each. Extensions already have the
`exposure` hook, so the profile is a variable, not a rewrite.

Why one environment variable instead of a key in each extension's config: the
choice is per session, not per service. Four files would let the profile drift
into a half-declared state, and a typo there would look minimal while still
paying the prompt.

The price is explicit: the agent no longer suggests a skill or remembers that a
calendar exists. The user, a skill body, or a `searchTools()` call has to name
the tool. That is the point — the router moved from the prompt to the skill.
