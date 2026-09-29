# Agent Knowledge Memory System (AKMS) v0.1

> **Superseded 2026-09-28 by v2** (`index.ts`). v2 keeps the file-based,
> progressive-disclosure core but replaces the shared SOUL / memory.md /
> category-index injection with per-agent SOUL + notes, a shared USER.md,
> generated indexes, and `memory_search` / `memory_read` / `memory_write`.
> Design record: `~/Bots/docs/memory.md`.

> Vendored 2026-09-23 from the `su-memory` package (archived) as the original
design record. The implementation deviates in one place: there is no `skills/`
category — reusable procedures live in pi's skill system, not in memory. See
`index.ts` for what the code actually does.

## 1. Core Principle

Memory exists to minimize future reasoning cost.

The agent should convert:

* repeated explanations
* discovered solutions
* user preferences
* workflows
* project context
* failed approaches

into persistent knowledge that reduces future effort.

Memory is not a transcript.

Memory is compressed experience.

---

# 2. Memory Repository Structure

The agent has access to a persistent git repository:

```
memory/
│
├── SOUL.md
│
├── memory.md
│
├── preferences/
│   ├── index.md
│   └── *.md
│
├── skills/
│   ├── index.md
│   └── *.md
│
├── projects/
│   ├── index.md
│   └── *.md
│
├── knowledge/
│   ├── index.md
│   └── *.md
│
└── archive/
```

---

# 3. File Roles

## SOUL.md

Purpose:

Defines the agent identity, values, and operating principles.

Properties:

* Human authored
* Never automatically modified
* Always loaded

Example:

```
You are a technical AI assistant.
Optimize for correctness and long-term usefulness.
Prefer understanding over quick answers.
```

---

# memory.md

Purpose:

The global memory entry point.

Always loaded.

Must remain small (<2000 tokens).

Contains:

1. Active user context
2. Important global preferences
3. Memory navigation instructions

Example:

```md
# User Context

Software engineer focused on ML systems.

# Important Preferences

- Prefer technical depth.
- Prefer practical implementation details.

# Available Memory

## Skills
Debugging workflows and engineering practices.
See skills/index.md

## Projects
Active projects and architecture notes.
See projects/index.md

## Knowledge
Long-term technical knowledge.
See knowledge/index.md
```

---

# 4. Progressive Disclosure

Only the following are injected into context:

```
SOUL.md

memory.md

*/index.md
```

All other files are loaded only when needed.

The model should never receive the entire memory repository.

---

# 5. Index Format

Every directory contains an `index.md`.

Example:

```
skills/index.md
```

```md
# Skills

Reusable procedures.

## debugging.md

Systematic debugging process.

Use when:
- fixing bugs
- investigating failures
- performance issues


## research.md

Research workflow.

Use when:
- exploring unfamiliar topics
- comparing technologies
```

Indexes contain:

* filename
* short description
* when to use

Nothing else.

---

# 6. Memory Categories

The system has exactly four categories.

## Preferences

Stable information about how the user/agent operates.

Examples:

```
preferences/coding.md

- Uses Python + PyTorch.
- Prefers minimal dependencies.
- Likes implementation-first explanations.
```

---

## Skills

Reusable procedures.

Format:

```
skills/<name>.md
```

Template:

```md
# Skill Name

## Purpose

What problem this solves.

## Procedure

Step-by-step reusable workflow.

## Rules

Important constraints.

## Failure Modes

Common mistakes.
```

Example:

```
skills/debugging.md

Purpose:
Debug complex ML failures.

Procedure:
1. Reproduce.
2. Minimize.
3. Inspect assumptions.
4. Instrument.
5. Fix.
6. Add regression test.
```

---

## Projects

Current or recurring work.

Format:

```
projects/<project>.md
```

Contains:

```md
# Project

## Goal

## Architecture

## Decisions

## Current State

## Open Problems
```

---

## Knowledge

General reusable information.

Examples:

* technical concepts
* domain knowledge
* explanations

Format:

```
knowledge/<topic>.md
```

---

# 7. Memory Creation Rules

The agent should create memory only when:

```
Future work will likely become easier because this exists.
```

Good candidates:

* A solved difficult problem
* A repeated user preference
* A reusable workflow
* A project decision
* A discovered constraint

Bad candidates:

* Conversation summaries
* Temporary thoughts
* Facts unlikely to matter again

---

# 8. Memory Promotion

Information follows this lifecycle:

```
Conversation
      |
      v
Temporary understanding
      |
      v
Candidate memory
      |
      v
Permanent document
```

The agent should periodically promote useful knowledge.

Example:

Conversation:

> "CUDA failed because my driver version was incompatible."

Bad:

```
We discussed CUDA on July 11.
```

Good:

```
knowledge/cuda/troubleshooting.md

When CUDA initialization fails:
1. Check driver version.
2. Check torch CUDA compatibility.
3. Verify LD_LIBRARY_PATH.
```

---

# 9. Memory Maintenance Prompt

Injected into system prompt:

```
Memory Maintenance:

You have a persistent knowledge repository.

Your goal is to reduce future reasoning cost.

Maintain memory like a software repository:

- Write reusable knowledge.
- Keep indexes concise.
- Refactor outdated information.
- Split large files.
- Remove useless information.
- Prefer procedures and abstractions over transcripts.

Before saving information ask:

"Will future instances of myself solve problems faster because this exists?"

If yes, store it.
If no, do not.
```

---

# 10. Task Completion Prompt

After completing significant tasks:

```
Before finishing:

Review the interaction.

Identify:
- new user preferences
- reusable procedures
- important decisions
- solved problems

If any reduce future effort:

Update memory.

Do not store summaries.
Store reusable knowledge.
```

---

# 11. Git Usage

Memory is version controlled.

The agent may:

```
git diff
git add
git commit
git log
git revert
```

Commit messages should describe knowledge changes.

Examples:

```
Add CUDA debugging workflow

Update user coding preferences

Refactor ML project notes
```

---

# 12. Design Invariants

A valid implementation must satisfy:

### Small context

The agent never loads all memory.

### Human readable

All memory is plain text.

### Agent editable

The model manages its own knowledge.

### Versioned

Changes are reversible.

### Progressive

Memory grows in depth, not prompt size.

### Self improving

Experience produces reusable knowledge.

---

## Summary Architecture

```
                 SYSTEM PROMPT
                      |
        +-------------+--------------+
        |                            |
     SOUL.md                    memory.md
                                      |
                         +------------+------------+
                         |            |            |
                     skills       projects    preferences
                         |
                    index.md
                         |
                  lazy loaded files
```

---

I think this is the smallest system that captures the core idea. The important decisions are:

1. **Markdown repository instead of database**
2. **Indexes instead of retrieval everywhere**
3. **Skills and memory are the same abstraction**
4. **The agent manages organization**
5. **The optimization target is reduced future reasoning**

Everything else (embeddings, vector DBs, memory APIs, ranking models) becomes an optimization layer on top of this rather than the foundation.
