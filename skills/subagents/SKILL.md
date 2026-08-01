---
name: subagents
description: |
  Spawn subagents through the `pi` CLI with least privilege and the fixed
  `opencode-go/deepseek-v4-flash` model. Use when you need to delegate work to a
  fresh-context child agent, run parallel investigations, or isolate a task from
  the current session. Do not use the removed `pi-subagents` extension tool.
---

# Pi Subagent CLI

Spawn subagents by running the `pi` CLI from a `bash` tool call. Treat every
spawned agent as a **least-privilege** process: give it only the tools,
extensions, skills, and thinking level it needs for the exact task, and nothing
more.

## Hard rule: model

Every subagent **must** run with:

```bash
pi --model opencode-go/deepseek-v4-flash ...
```

This is not a default or suggestion; it is mandatory for every subagent spawn.
Use the `opencode-go` provider specifically — do not use the DeepSeek provider
or any other model alias.

## Basic spawn command

Use `--print` so the child runs non-interactively and exits. Use a dedicated
`--session-dir` to keep child artifacts isolated and inspectable.

```bash
pi \
  --model opencode-go/deepseek-v4-flash \
  --tools read,grep,find,ls \
  --no-extensions \
  --no-skills \
  --thinking off \
  --print \
  --session-dir /tmp/pi-subagent-<task>-<uuid> \
  "<task prompt>"
```

## Least-privilege tool sets

Pick the smallest `--tools` list that can complete the task. Do not add a tool
"just in case".

| Task type | Tools | Notes |
| --- | --- | --- |
| Read/search only | `read,grep,find,ls` | No `bash`, no `edit`, no `write`. |
| Run existing tests/scripts | `read,bash,grep,find,ls` | `bash` only for read-only or validation commands; no `edit`/`write`. |
| Edit files | `read,edit,write,bash,grep,find,ls` | Grant only when the child must produce file changes. |
| Heavy shell work | `read,bash,grep,find,ls` | Give `edit`/`write` only if the child also needs to persist results. |

Deny tools explicitly when you want to be safe:

```bash
--exclude-tools edit,write
```

## Hardening flags

| Flag | When to use |
| --- | --- |
| `--no-extensions` | Almost always. Prevents the child from loading any extension. |
| `--no-skills` | When the child does not need any skill guidance. |
| `--skill <path>` | When the child needs exactly one specific skill; prefer this over loading all skills. |
| `--no-context-files` | When the child should not inherit `AGENTS.md` / `CLAUDE.md` from the project. |
| `--thinking off` | For cheap, deterministic tasks. Raise only when the task genuinely needs reasoning. |
| `--session-dir <dir>` | Always; keeps child sessions isolated. |
| `--name <name>` | When you want a readable display name in the session dir. |

## Parallel subagents

Run multiple `bash` tool calls concurrently. Each child should have its own
`--session-dir` so they do not collide.

## Inspecting results

The child prints its final output via `--print`. If you need to read files it
wrote, use `read` on paths inside its `--session-dir`, or instruct the child to
print the results inline.

## Examples

### Read-only code review

```bash
pi \
  --model opencode-go/deepseek-v4-flash \
  --tools read,grep,find,ls \
  --no-extensions \
  --no-skills \
  --thinking off \
  --print \
  --session-dir /tmp/pi-subagent-review-$(date +%s) \
  "Review src/auth.ts for obvious bugs and style issues."
```

### Run tests and report failures

```bash
pi \
  --model opencode-go/deepseek-v4-flash \
  --tools read,bash,grep,find,ls \
  --exclude-tools edit,write \
  --no-extensions \
  --no-skills \
  --thinking off \
  --print \
  --session-dir /tmp/pi-subagent-tests-$(date +%s) \
  "Run npm test and summarize failures."
```

### Delegated edit with a single skill

```bash
pi \
  --model opencode-go/deepseek-v4-flash \
  --tools read,edit,write,bash,grep,find,ls \
  --no-extensions \
  --skill /home/denis/.pi/agent/skills/tdd \
  --thinking medium \
  --print \
  --session-dir /tmp/pi-subagent-edit-$(date +%s) \
  "Add a unit test for the new formatter in src/format.ts."
```

## What not to do

- Do not spawn interactive subagents (omit `--print` only if you intend to hand
  the terminal to a human).
- Do not give `edit`/`write` to a child whose only job is reading, searching, or
  reporting.
- Do not give `bash` to a child whose only job is reading files.
- Do not load extensions or skills unless the task explicitly requires them.
- Do not override the model with anything other than `opencode-go/deepseek-v4-flash`.
