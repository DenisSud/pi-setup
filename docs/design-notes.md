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

## Subagents: a fork, not a config line (2026-10)

`pi-subagents` registers `subagent` with `exposure: "model-only"`: declared to
the model, not callable from a codemode script. Neither lever in settings
reaches that: `-subagent` also removes it from codemode (`tools.subagent` is
`undefined`), and the package exposes no exposure setting. So the package is
forked (`DenisSud/pi-subagents`, branch `pi-setup`, upstream `v0.80.0`) and the
parent-facing registrations take `SCRIPT_ONLY_TOOL` — `deferred` — while
child-session registrations keep `model-only`, because a child's prompt is its
own.

Why not a wrapper extension that proxies `registerTool` and rewrites
`exposure`: it would sit on pi's API identity, break the package's declaration
pinning, and make every upstream change a guessing game. A three-file diff in
a fork is easier to rebase than a proxy is to trust.

The cost is real and accepted: the fork tracks upstream by hand. Rebase the
branch onto a new tag, keep the `SCRIPT_ONLY_TOOL` replacements, push, `pi
update --extensions`.

## The prompt carries the repeated instructions (2026-10)

`SYSTEM.md` began as a 31-line "soul" and was cut to 8 lines when the package
went script-only, on the bet that skills and project `AGENTS.md` files would
carry the rest. They did not: the same corrections kept returning — TLDR first,
the smallest change, no "shall I?", check the remote before claiming state,
never commit to `main`, no em dashes.

An audit of 1,194 human turns from 211 sessions on two machines counted them
(subagent fan-out over the transcripts, then exact matching): skill or subagent
process in 137 turns, TLDR or "be brief" in 98, "minimal" or "don't overthink"
in 93, leftover cleanup in 60, branch and PR rules in 60, handoffs in 49,
"delete means delete" in 45, verify before claiming in 26, em dashes or "sounds
like me" in 6.

So the prompt went to 533 words, then lost the handoff line, grouped by where the failure happens: reply,
work, repo, tools, standing policies. Two policies are new by request, not by
frequency: an issue on his fork for any bug in code he owns, and no leftovers
from one-off work. The script-only budget still holds — ~800 prompt tokens
against the ~11.3k shape it replaced. A bullet that cannot cite a repeated turn
gets cut; the categories are the structure to keep it from growing.

## Invocation is copied from upstream, not re-derived (2026-10)

Every skill was user-invoked. The transcripts show what that cost: across 1,194
turns `/skill:` was typed twice and a skill named six times, while the
situations those skills exist for filled hundreds of turns. Denis states a
situation ("the site needs a login", "this is broken", "grill me"), never a
procedure name, so a hidden skill fires only when someone remembers it exists.

The first fix was a hand-picked eight. The right fix was to stop hand-picking:
most `SKILL.md` files here are copies of [`mattpocock/skills`](https://github.com/mattpocock/skills),
which already splits them on one axis and documents the test in its
`.agents/invocation.md`: a **user-invoked** skill orchestrates a flow the human
picks, a **model-invoked** skill holds reusable discipline the agent must reach
on its own, and only the latter can be called by another skill. Its README
groups both buckets into those two lists; ours now matches them skill for
skill, including the flips that look surprising at first: `pr`, `research`,
`tdd`, `code-review`, `prototype`, `codebase-design`, `wizard` and
`writing-for-agents` are advertised, while `handoff`, `wait-what`, `triage`,
`wayfinder`, `to-spec`, `to-tickets`, `implement`, `implement-spec`,
`improve-codebase-architecture`, `grill-with-docs`, `retro`, `ask-matt`,
`setup-matt-pocock-skills` and `teach` are not.

The dependency rule is what makes the split self-consistent rather than taste:
`implement` (user-invoked) drives `tdd` and closes with `code-review`, so both
must be model-invoked or the call cannot happen. A user-invoked skill can never
reach another user-invoked one.

The six skills that exist only here follow the same test: `agent-browser`,
`latex-pdf` and `self-improvement` are reachable because the trigger is a
situation; `ascii-animation`, `show-me` and `skill-authoring` stay hidden.

`handoff` is hidden like upstream and is deliberately absent from `SYSTEM.md`
too: he asks for a handoff when he wants one, so a standing instruction to end
every multi-turn session with a file was a line of prompt spent on a decision
that is his. The pattern for a hidden skill the prompt does rely on is to name
its `SKILL.md`, not the command; nothing in the prompt relies on one now.

Cost: pi renders an advertised skill as name, description and absolute path.
Fourteen is 6.4k characters, ~1.6k tokens on pi 1.4.0; all 31 would be 11.3k
characters, ~2.8k tokens. Copying upstream is also what keeps this from drifting
back: a flip is a line of frontmatter plus the `policy` block in the skill's
`agents/openai.yaml`, and the two harnesses stay in sync.
