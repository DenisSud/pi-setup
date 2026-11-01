---
name: workflow-engineering
description: "Design and run a fan-out workflow with subagents: choose the graph, write the script, load each child, and verify the result. Use when a task splits into independent subtasks, needs parallel workers, or an existing workflow script needs changing."
---

# Workflow engineering

A workflow is a graph of LLM calls and tools on a fixed path. An agent decides
its own path. Use a workflow when you already know the steps and the fan-out is
independent; use one direct child for a bounded task; keep the work in the
parent when it is tightly coupled.

The cost is real: a multi-agent run uses roughly 15x the tokens of a chat turn.
Fan-out width is the cost knob. A question one search answers is not a workflow.

## Pick the shape

| pattern | shape | use when |
|---|---|---|
| prompt chaining | `runs.run` A → B → C | fixed subtasks, each easier than the whole |
| routing | parent classifies, one specialized child | the input type decides the specialist |
| parallelization | `runs.all([...])` | independent slices of the same job |
| orchestrator-workers | parent plans, `runs.all` the plan, one writer | the split is not known until you look |
| evaluator-optimizer | produce → judge → revise, capped | quality matters more than one pass |

Do not use a workflow for coding with tight coupling between files, or when every
step needs the same context. Those are one writer's job.

## Write the script

In this setup `subagent` is deferred and reached from codemode. A custom graph is
a `.js` file next to the skill that owns it, called by absolute path:

```js
const run = await tools.subagent({
  workflow: "/abs/path/to/workflow.js",
  args: { outdir: "/abs/path/run", plan: [...] },
  cwd: "/abs/path/repo",
  async: true,
});
text(run);
```

`workflow: true` reads a fenced block from the model reply; a codemode script
cannot produce that block. Use a file. `workflow: "parallel"` is the packaged
shortcut for independent children, but it only forwards `agent`, `task`, `cwd`
and `model`, so use a script when a child needs a skill or tool loadout.

Inside the script:

- `await runs.run("key", { agent, task, ... })` for a step. The key is stable.
- `await runs.all([{ key, agent, task }, ...])` for a fan-out. It returns an
  ordered array, not a key map.
- `await runs.lanes([...])` for independent chains that each have stages.
- `emit(value)` for progress the parent can see. `args` is frozen plain JSON.
- No filesystem, shell, or host globals. Use `output` paths, not `fs`.

Child fields that matter:

| field | why |
|---|---|
| `agent` | `researcher`, `reviewer`, or `worker` in this setup |
| `task` | the full brief; a fresh child has no history |
| `output` | durable artifact path; return `outputReference` to the parent |
| `outputSchema` | structured result; read `structuredOutput`, not prose |
| `context: "fresh"` | default for a stage that judges files, not the chat |
| `skill` | per-task skill list, e.g. `["tdd"]`; `false` for none |
| `tools` | per-task tool allowlist (fork patch); replaces the profile's list |
| `worktree: true` | a writer in its own tree; required for parallel writers |
| `acceptance` | host-run verification; the `gate` shorthand is disabled here |

Do not pass `model`. Every child inherits DeepSeek V4.1 Flash at high thinking
from the setup default.

## Design rules

- **One writer per tree.** Parallel writers need `worktree: true`, or disjoint
  files and a merge step. Two workers in one tree race.
- **A brief is a contract.** The child has no history. Put the goal, the input
  paths, the output path, the format and the stop condition in `task`.
- **Files carry state.** Each stage writes its artifact and returns a short
  digest. The next stage reads the file. Nothing load-bearing survives a summary
  chain.
- **A judge needs a schema.** Give a reviewer `outputSchema` with a `verdict` and
  check `structuredOutput.verdict`; do not parse prose.
- **`ok` is not "the work happened".** A child can finish normally and decline.
  When a later step depends on the work, require a structured status or a host
  check.
- **Cap the loop.** Evaluator-optimizer gets a round limit. A retry gets one
  retry, not a while-loop.
- **Outputs are paths, not hope.** A later `runs.run` reads
  `result.outputReference` or the known path, not a filename mentioned in prose.

## The reference graph

`skills/engineering/deep-research/` is the worked example:

```
seek        one researcher per sub-question, parallel
coverage    one reviewer, structured verdict, up to 3 named gaps
gap-fill    one researcher per gap
draft       one worker, the only writer
audit       one researcher that refetches every cited URL
revise      one worker, fixes only what the audit flagged
```

It uses `runs.all` for the fan-out, a schema for the coverage verdict, one
writer, and file artifacts under the run directory. Copy its shape, not its
prompts.

## Before launch

1. Validate the script without launching children:

   ```js
   await tools.subagent({ action: "validate", workflow: "/abs/path/workflow.js" });
   ```

2. Check every child has a bounded task, a durable output, and a stop condition.
3. Check the graph does not read a result it did not await.
4. Check there is one writer per tree.
5. Estimate the cost: children x expected tool calls. If it is more than the
   task is worth, use one child.

Launch it in the background and inspect with the fleet:

```js
await tools.subagent({ action: "status", id: run.id, options: { view: "fleet" } });
```

`action: "interrupt"` pauses a child; `action: "resume"` continues it;
`action: "stop"` ends it. Do not leave an idle workflow running.
