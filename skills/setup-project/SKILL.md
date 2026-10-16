---
name: setup-project
description: Bootstrap a dev project with Matt Pocock's engineering skills. Run once in a new or existing project.
disable-model-invocation: true
---

# Setup Project

Clone Matt Pocock's engineering skills and set this project up with them.
Nothing is vendored in pi-setup: the skills are fetched fresh and then owned by
this project, free to adapt to its workflow.

## 1. Fetch upstream

```sh
rm -rf /tmp/mattpocock-skills
git clone --depth 1 https://github.com/mattpocock/skills /tmp/mattpocock-skills
```

## 2. Install the skills into this project

`npx skills` is upstream's own installer, for the agents it has no managed
route for (`pi` is a supported target). It asks which skills to take and copies
editable files into the project:

```sh
npx skills@latest add mattpocock/skills -a pi
```

Take the engineering skills this project needs. Always take
`setup-matt-pocock-skills` (step 3 follows it), and take `tdd` and `research`:
`implement` and `wayfinder` call those by name, and the flow dead-ends without
them.

## 3. Configure the repo

Read `/tmp/mattpocock-skills/skills/engineering/setup-matt-pocock-skills/SKILL.md`
and follow it. It asks about the issue tracker and the triage labels, then
writes `docs/agents/*.md` and the `## Agent skills` block into `AGENTS.md`.

## 4. Commit

Commit the installed skills and the `docs/agents/` files. The skills belong to
this project now: edit them to fit its workflow. Re-run steps 1 and 3 for
upstream changes.
