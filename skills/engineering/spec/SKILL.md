---
name: spec
description: "Turn the current conversation into a spec and publish it as one GitHub issue (github) or one /tmp file (local). Usage: /spec github or /spec local."
disable-model-invocation: true
---

# Spec

Turn what is already settled into the artifact the next session executes. Do not
interview. If a decision the work needs is missing, name it and stop; send the
user back to `/grill`.

## Mode

- `/spec github` publishes one GitHub issue with `gh issue create`.
- `/spec local` writes one file under `/tmp`.

With no argument, recommend **github** when the repo has a GitHub remote and
issues are the place work is tracked, otherwise **local**. State the choice in
one line and proceed unless the user objects.

The artifact is the mode for the next session: an issue number or URL means
github, a file path means local. A `/full-send github <path>` or
`/full-send local #123` override wins.

## Write

1. Read the current repo state if you have not already: `git status`, the
   default branch, and the modules the change touches. Use the project's
   vocabulary from `GLOSSARY.md` when it exists.
2. Name the seams where the change will be proved. Prefer existing seams and the
   highest one. Put them in **Testing and proof**; do not ask a second round of
   questions about them.
3. Write the spec with the template below. No file paths or code snippets unless
   a prototype pinned a shape that prose cannot: then inline only the
   decision-rich part and say it came from a prototype.
4. Publish it.

## Template

```markdown
## Problem

Who hurts, when, and why now.

## Goal and success criteria

One goal. Then the observable checks that say it worked. No adjectives.

## Approach

The smallest change that meets the criteria. Name the modules and seams.

## Decisions

The calls from the grill, each with the reason. Include what was rejected.

## Testing and proof

How full-send proves it: the commands, fixtures, reproduction, or screenshot.
Existing seams first.

## Out of scope

What this spec does not do.

## Open questions

Only what is still open. Write "None" when none.
```

## Publish

**github**

```bash
gh issue create --repo <owner/name> --title "<title>" --body-file <body.md>
```

Write the body to a temporary file, create one issue, print its URL. Do not
create a ticket graph or sub-issues. Do not add labels. If `gh` is missing or
unauthenticated, stop and say so; do not fall back to a local file silently.

**local**

Write the spec to `/tmp/spec-<repo>-<slug>.md` with this header above the body:

```markdown
# <title>

Repo: <absolute path>
Base: <sha> <branch>
Mode: local
Date: <YYYY-MM-DD>
```

Print the absolute path. `/tmp` does not survive a reboot; if the work spans
days, say so and put the file somewhere durable instead.

Do not implement. The next session runs `/full-send <pointer>`.
