# registry — deferred

Where skills, extensions and packages get **promoted out of a bot** so they can
be reused by other bots (or handed to the web app later).

Not implemented yet, on purpose: there is nothing worth promoting until the
bots have run for a while. This file is the policy so the implementation does
not have to re-decide it.

## Model (when it lands)

- **Source of truth:** entries in this directory, git-versioned like everything
  else. A sqlite index is derived and rebuildable — search, tags, provenance.
- **Promotion is a copy, never a move.** The bot keeps its copy; the entry is
  an independent snapshot that later evolves on its own.
- **Provenance:** every entry records where it came from (`source: bot/<name>`,
  later `git:<url>`), so a bad entry can be traced.
- **No runtime access.** Bots cannot read the registry. Only the bot manager
  (and Denis) touches it; installing something into a bot stays a user-driven
  action, consistent with the self-extension rule.
