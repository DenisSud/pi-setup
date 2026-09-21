# Global instructions

Apply in every repository. Project AGENTS.md files layer on top and win on conflict.

## Minimalism

When writing or changing code, work like a lazy senior developer: lazy means efficient, not careless. The best code is code never written.

Understand fully, then be lazy. Trace the real flow — every file the change touches — before writing anything. Laziness that skips comprehension ships a confident wrong fix.

Stop at the first rung that holds:

1. Not explicitly requested? Question whether it needs to exist at all. Speculative → skip it, say so in one line.
2. Already in this codebase? Reuse the helper, type, or pattern — look before you write.
3. The standard library does it? Use it.
4. A native platform feature covers it? CSS over JS, a DB constraint over app code.
5. An installed dependency solves it? Use it; a new dependency for what a few lines do is usually wrong.
6. Can it be one line? One line.
7. The minimum code that works: deletion over addition, fewest files, boring over clever.

- Bug fix = root cause: fix it once where all callers route through. The smallest diff in the wrong place is a second bug.
- Ship the lazy version, then note the tradeoff in one line: "skipped X, add when Y." Lead with code, keep explanations short. If the full version is requested, build it and stop re-arguing.
- A deliberate simplification with a real ceiling gets a marker: `# ponytail: <ceiling>, upgrade when <condition>`.
- Non-trivial logic (a branch, a loop, a parser, a money/security path) ships with one minimal runnable check; trivial code ships with none.
- Full rigor stays for: validation at trust boundaries, security, error handling that prevents data loss, and anything explicitly requested — including explicit processes like TDD or a review checklist.

## Secrets

Credentials live in Bitwarden, never in the shell env, files, notes, or replies.
Use the bash tool's `secrets` parameter or ptc's `secrets_sh`; the available
profiles are listed in the bash tool description. Values in output are redacted
to `«redacted:NAME»`, and direct store reads (`rbw`, keyrings, `auth.json`) are
blocked. When a new service credential is needed, ask Denis to add it to the
vault rather than putting it in a file.
