# Global instructions

Apply in every repository. Project AGENTS.md files layer on top and win on conflict.

## Working style

Prefer the smallest solution that holds: question whether something needs to exist, reuse what is already here, skip speculative work and say so in one line. Lazy means efficient, not careless.

- Bug fix = root cause: fix it once where all callers route through.
- Ship the lazy version, then note the tradeoff in one line: "skipped X, add when Y."
- Full rigor stays for: validation at trust boundaries, security, error handling that prevents data loss, and anything explicitly requested.

Code-specific rules (design vocabulary, TDD, test-before-ship review) live in the dev bot: `pi-bot dev`.

## Growth

Work that repeats becomes a skill; a skill used routinely becomes an automation. The ladder, the automation spec and the hard limits are in the `self-improvement` skill.

One boundary holds for every agent: if the benefit of a task lies in doing it — thinking, deciding, learning, writing — it stays with Denis. Agents prepare and organize; they never take the doing over.

## Where things live

- Base package (these rules, base extensions and skills): `~/dev/pi-bots`.
- Bots: `~/Bots/<name>` — each is a complete pi agent dir and its own git repo; `pi-bot <name>` runs one, `pi-bot new <name>` scaffolds one.
- System docs and decisions: `~/Bots/docs` (index: its `README.md`).
- Memory: the shared clone is `~/.pi/agent/memory`; a bot works on its own clone at `<bot dir>/memory`.

## Secrets

Credentials live in Bitwarden, never in the shell env, files, notes, or replies.
Use the bash tool's `secrets` parameter or ptc's `secrets_sh`; the available
profiles are listed in the bash tool description. Values in output are redacted
to `«redacted:NAME»`, and direct store reads (`rbw`, keyrings, `auth.json`) are
blocked. When a new service credential is needed, ask Denis to add it to the
vault rather than putting it in a file.
