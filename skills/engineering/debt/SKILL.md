---
name: debt
description: "Every deliberate `shortcut:` comment collected into one ledger, so a deferral cannot quietly become permanent. One-shot report, changes nothing. Use when the user asks what was deferred, what did we skip, to list the shortcuts, or for the debt ledger."
metadata:
  credits:
    skill: ponytail-debt
    author: Dietrich Gebert
    organisation: DietrichGebert
    url: "https://github.com/DietrichGebert/ponytail/blob/main/skills/ponytail-debt/SKILL.md"
    license: MIT
---

Every deliberate shortcut is marked with a `shortcut:` comment naming its
ceiling and upgrade path (older code may say `ponytail:`). This collects them
into one ledger so a deferral can't quietly become permanent.

## Scan

Grep the repo for comment markers, skipping `.git` and everything the
`.gitignore` files ignore (dependencies, build output, caches, in any stack):

`git grep --no-index --exclude-standard -nE '(#|//|/[*]) ?(shortcut|ponytail):'`

Add other comment prefixes if your stack uses them. If the user names their own
marker word, grep for that word instead.

Each hit is one ledger row. The comment prefix keeps prose that merely mentions
the convention out of the ledger. Skip hits that are not a deferral, like a note
about a keyboard shortcut.

## Output

One row per marker, grouped by file:

`<file>:<line>, <what was simplified>. ceiling: <the limit named>. upgrade: <the trigger to revisit>.`

The convention is `shortcut: <ceiling>, <upgrade path>`, so pull the ceiling
and the trigger straight from the comment. Want an owner per row too? Add
`git blame -L<line>,<line>`.

Flag the rot risk: any marker comment that names no upgrade path or trigger gets
a `no-trigger` tag. Those are the ones that silently rot.

End with `<N> markers, <M> with no trigger.` Nothing found: `No shortcut debt.
Clean ledger.`

## Boundaries

Reads and reports only, changes nothing. To persist it, ask and it writes the
ledger to a file. One-shot.
