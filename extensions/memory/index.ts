/**
 * memory — agent + shared notes with generated indexes.
 *
 * v2 (2026-09-28). v1 injected SOUL.md, memory.md, three category indexes and
 * a long policy into every agent, all from one shared clone; every agent was
 * the same person and paid ~10.5 KB per turn. v2 keeps a tiny always-on core
 * and puts everything else behind tools:
 *
 *   <agent dir>/SOUL.md   identity, human-authored, never auto-edited
 *   <agent dir>/notes/    agent notes (frontmatter + body)
 *   $PI_MEMORY_DIR/       shared notes; USER.md beside them
 *   notes/index.md        generated from note frontmatter; never agent-edited
 *
 * The base agent (no PI_CODING_AGENT_DIR) uses the shared repo for both, so
 * it has one note set. A bot (PI_CODING_AGENT_DIR set) has its own SOUL and
 * notes, and shares USER.md + the shared notes.
 *
 * Tools: memory_search, memory_read, memory_write. Writes default to the
 * agent scope; `scope: "global"` writes a note another agent will need.
 *
 * Provenance: v1 vendored 2026-09-23 from the archived su-memory package.
 * Design record: ~/Bots/docs/memory.md.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ── locations (lazy: tests set the env after import) ────────────────────────

const HOME = process.env.HOME || process.env.USERPROFILE || "";

function sharedDir(): string {
  return path.resolve(process.env.PI_MEMORY_DIR || path.join(HOME, ".pi/agent/memory"));
}

function agentDir(): string {
  return path.resolve(process.env.PI_CODING_AGENT_DIR || sharedDir());
}

export type Scope = "agent" | "global";

interface Root {
  kind: Scope;
  /** The repo root: holds SOUL.md / USER.md / git. */
  dir: string;
  /** Where notes are scanned. Bot notes live in <dir>/notes; the shared repo
   *  is itself the notes folder, so its existing paths keep working. */
  notes: string;
}

/**
 * The note sets. A bot has two: its own and the shared one. The base agent has
 * a single set (agent dir == shared dir), registered as "agent".
 */
function roots(): Root[] {
  const agent = agentDir();
  const shared = sharedDir();
  const list: Root[] = [];
  const seen = new Set<string>();

  const add = (kind: Scope, dir: string, notes: string) => {
    const key = path.resolve(notes);
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ kind, dir, notes: key });
  };

  if (agent === shared) {
    // Base agent: one generalist set, the shared repo.
    add("agent", agent, agent);
  } else {
    add("agent", agent, path.join(agent, "notes"));
    add("global", shared, shared);
  }
  return list;
}

function rootFor(kind: Scope): Root {
  const all = roots();
  return all.find((r) => r.kind === kind) ?? all[0];
}

function rootsFor(scope: Scope | "all"): Root[] {
  const all = roots();
  if (scope === "all") return all;
  const match = all.filter((r) => r.kind === scope);
  return match.length > 0 ? match : all;
}

// ── frontmatter ─────────────────────────────────────────────────────────────

export interface Meta {
  title: string;
  description: string;
  tags: string[];
  created?: string;
  updated?: string;
}

function unquote(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return v;
}

function quoteIfNeeded(value: string): string {
  return /^[\w][^{}[\]#:"']*$/.test(value) ? value : `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function parseList(value: string): string[] {
  const v = value.trim();
  if (v.startsWith("[") && v.endsWith("]")) {
    return v
      .slice(1, -1)
      .split(",")
      .map((s) => unquote(s))
      .filter(Boolean);
  }
  return v ? [unquote(v)] : [];
}

/** Minimal YAML-subset parser: flat `key: value`, arrays, quoted strings. */
export function parseFrontmatter(text: string): { meta: Record<string, string | string[]>; body: string } {
  const lines = text.split(/\r?\n/);
  const meta: Record<string, string | string[]> = {};
  if (lines[0] !== "---") return { meta, body: text };

  let i = 1;
  for (; i < lines.length; i++) {
    if (lines[i] === "---") break;
    const m = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) meta[m[1]] = /^\s*\[/.test(m[2]) ? parseList(m[2]) : unquote(m[2]);
  }
  const body = lines.slice(i + 1).join("\n").replace(/^\s*\n/, "");
  return { meta, body };
}

function firstHeading(body: string): string | undefined {
  return body.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

function firstLine(body: string): string | undefined {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("<!--") || line.startsWith(">")) continue;
    return line.length > 240 ? `${line.slice(0, 237)}…` : line;
  }
  return undefined;
}

function humanize(file: string): string {
  return path
    .basename(file, ".md")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function metaOf(text: string, rel: string): Meta {
  const { meta, body } = parseFrontmatter(text);
  const tags = Array.isArray(meta.tags) ? meta.tags : typeof meta.tags === "string" ? [meta.tags] : [];
  return {
    title: (typeof meta.title === "string" && meta.title) || firstHeading(body) || humanize(rel),
    description: (typeof meta.description === "string" && meta.description) || firstLine(body) || "",
    tags,
    created: typeof meta.created === "string" ? meta.created : undefined,
    updated: typeof meta.updated === "string" ? meta.updated : undefined,
  };
}

// ── scanning ────────────────────────────────────────────────────────────────

export interface NoteEntry extends Meta {
  root: Scope;
  /** Path relative to the root's notes folder. */
  path: string;
  /** ISO date, from frontmatter `updated` or the file mtime. */
  modified: string;
  body: string;
}

const SKIP_FILES = new Set(["index.md", "USER.md", "SOUL.md", "memory.md", "README.md"]);
const SKIP_DIRS = new Set([".git", "node_modules", "archive", "sessions", "experiments"]);

function walk(dir: string, base: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, base, out);
    } else if (entry.isFile() && entry.name.endsWith(".md") && !SKIP_FILES.has(entry.name)) {
      out.push(path.relative(base, full));
    }
  }
}

function dateOf(root: Root, rel: string): string {
  try {
    return fs.statSync(path.join(root.notes, rel)).mtime.toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

export function scanRoot(root: Root): NoteEntry[] {
  const files: string[] = [];
  walk(root.notes, root.notes, files);
  const entries: NoteEntry[] = [];
  for (const rel of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(root.notes, rel), "utf-8");
    } catch {
      continue;
    }
    const meta = metaOf(text, rel);
    entries.push({
      ...meta,
      root: root.kind,
      path: rel,
      modified: meta.updated || dateOf(root, rel),
      body: parseFrontmatter(text).body,
    });
  }
  entries.sort((a, b) => b.modified.localeCompare(a.modified) || a.title.localeCompare(b.title));
  return entries;
}

/** Regenerate a root's index.md. Generated only — the agent never edits it. */
export function writeIndex(root: Root): void {
  fs.mkdirSync(root.notes, { recursive: true });
  const entries = scanRoot(root);
  const lines = [
    "<!-- generated by the memory extension; do not edit — edit the notes -->",
    "",
    `# Notes (${entries.length})`,
    "",
  ];
  for (const e of entries) {
    const tags = e.tags.length > 0 ? ` {${e.tags.join(", ")}}` : "";
    lines.push(`- [${e.title}](${e.path}) — ${e.description}${tags} · ${e.modified}`);
  }
  fs.writeFileSync(path.join(root.notes, "index.md"), `${lines.join("\n")}\n`, "utf-8");
}

// ── tools ───────────────────────────────────────────────────────────────────

const text = (t: string) => [{ type: "text" as const, text: t }];

function match(entry: NoteEntry, terms: string[], tags: string[]): boolean {
  if (tags.length > 0) {
    const own = entry.tags.map((t) => t.toLowerCase());
    if (!tags.every((t) => own.some((o) => o === t.toLowerCase()))) return false;
  }
  if (terms.length === 0) return true;
  const haystack = `${entry.title}\n${entry.description}\n${entry.tags.join(" ")}\n${entry.path}\n${entry.body}`.toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

function safePath(root: Root, rel: string): string {
  const clean = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  const abs = path.resolve(root.notes, clean);
  const prefix = root.notes.endsWith(path.sep) ? root.notes : root.notes + path.sep;
  if (abs !== root.notes && !abs.startsWith(prefix)) {
    throw new Error(`memory: path escapes the notes folder: ${rel}`);
  }
  return abs;
}

function slug(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 64);
  return s || "note";
}

function serialize(meta: Meta, body: string): string {
  const lines = ["---", `title: ${quoteIfNeeded(meta.title)}`, `description: ${quoteIfNeeded(meta.description)}`];
  if (meta.tags.length > 0) lines.push(`tags: [${meta.tags.map(quoteIfNeeded).join(", ")}]`);
  if (meta.created) lines.push(`created: ${meta.created}`);
  if (meta.updated) lines.push(`updated: ${meta.updated}`);
  lines.push("---", "", body.trim(), "");
  return lines.join("\n");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── first-run setup ─────────────────────────────────────────────────────────

const USER_TEMPLATE = [
  "# Denis",
  "",
  "<!-- Shared profile: who Denis is, his environment, global preferences.",
  "     Every agent reads this. Change it rarely, through memory_write with",
  "     scope \"global\", and say so in chat. -->",
  "",
  "## Identity",
  "",
  "## Environment",
  "",
  "## How to work with him",
  "",
].join("\n");

function runGit(dir: string, args: string[]): { ok: boolean; out: string; err: string } {
  try {
    const out = execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out: out.trim(), err: "" };
  } catch (e: any) {
    return { ok: false, out: (e?.stdout ?? "").toString().trim(), err: ((e?.stderr ?? "").toString().trim() || e?.message || "").trim() };
  }
}

function ensureStructure(): void {
  const shared = sharedDir();
  const agent = agentDir();

  fs.mkdirSync(shared, { recursive: true });
  if (agent !== shared) fs.mkdirSync(path.join(agent, "notes"), { recursive: true });
  for (const root of roots()) fs.mkdirSync(root.notes, { recursive: true });

  const user = path.join(shared, "USER.md");
  if (!fs.existsSync(user) && !fs.existsSync(path.join(shared, "memory.md"))) {
    fs.writeFileSync(user, USER_TEMPLATE, "utf-8");
  }
  const soul = path.join(shared, "SOUL.md");
  if (!fs.existsSync(soul) && agent === shared) {
    fs.writeFileSync(
      soul,
      "# SOUL\n\n<!-- Identity, voice, values. Human-authored; the agent never edits this file. -->\n",
      "utf-8",
    );
  }

  // A fresh shared root becomes a git repo, like v1 did.
  if (!fs.existsSync(path.join(shared, ".git"))) {
    const res = runGit(shared, ["init", "--quiet"]);
    if (res.ok) {
      if (!runGit(shared, ["config", "user.email"]).ok) runGit(shared, ["config", "user.email", "pi-memory@local"]);
      if (!runGit(shared, ["config", "user.name"]).ok) runGit(shared, ["config", "user.name", "pi-memory"]);
      runGit(shared, ["add", "-A"]);
      runGit(shared, ["commit", "-m", "Initialize memory"]);
    }
  }
}

// ── system-prompt block ─────────────────────────────────────────────────────

function readCapped(file: string, cap: number): string {
  try {
    const content = fs.readFileSync(file, "utf-8").trim();
    if (!content) return "(empty)";
    return content.length > cap ? `${content.slice(0, cap)}\n…[truncated ${content.length - cap} chars]` : content;
  } catch {
    return "(missing)";
  }
}

function soulFile(): string {
  const agent = agentDir();
  const local = path.join(agent, "SOUL.md");
  if (fs.existsSync(local)) return local;
  return path.join(sharedDir(), "SOUL.md");
}

function userFile(): string {
  const shared = sharedDir();
  const user = path.join(shared, "USER.md");
  if (fs.existsSync(user)) return user;
  return path.join(shared, "memory.md");
}

function policyText(): string {
  const agent = agentDir();
  const shared = sharedDir();
  const agentNotes = agent === shared ? shared : path.join(agent, "notes");
  return [
    "Memory is a few files, not a database:",
    "",
    `- Agent notes: ${agentNotes}`,
    `- Shared notes: ${shared}`,
    "- SOUL.md is who you are. Read-only to you; never edit it.",
    "- USER.md is the shared profile of Denis. Read it; update it rarely.",
    "- Everything else is a note with frontmatter. Title + description are the",
    "  index; the body is read only when the description matches.",
    "- memory_search before researching anything; memory_read to load a note;",
    "  memory_write to create or update one. Update the existing note when the",
    "  topic exists.",
    "- Write durable findings, decisions and state as notes — never transcripts",
    "  or transient thoughts.",
    '- Default scope is "agent". Use scope "global" only when another agent',
    "  needs the fact (shared projects, machines, Denis's profile, cross-track",
    "  deadlines), and say in chat what you moved there.",
    "- Mark a replaced note `status: superseded` with a link instead of",
    "  deleting it.",
    "- Commit memory changes with a short message; pull --rebase before writing",
    "  and push after when the root is shared.",
  ].join("\n");
}

export function buildMemoryContext(): string {
  const parts = [
    "## Memory",
    "",
    policyText(),
    "",
    "=== SOUL.md ===",
    readCapped(soulFile(), 6000),
    "",
    "=== USER.md ===",
    readCapped(userFile(), 8000),
  ];
  return parts.join("\n");
}

// ── extension ───────────────────────────────────────────────────────────────

export default function memory(pi: ExtensionAPI) {
  ensureStructure();
  for (const root of roots()) {
    try {
      writeIndex(root);
    } catch {
      // A broken note must not take the session down; index regenerates later.
    }
  }

  pi.on("before_agent_start", (event) => {
    return { systemPrompt: `${event.systemPrompt}\n\n${buildMemoryContext()}` };
  });

  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search your notes and the shared notes by text or tags. Returns note titles, descriptions, tags and paths; load one with memory_read. Use before researching anything, and when looking for an earlier decision or state.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Words to match anywhere in title, description, path, tags or body" })),
      tags: Type.Optional(Type.Array(Type.String({ description: "Tag that must be present (all must match)" }))),
      scope: Type.Optional(
        Type.Union([Type.Literal("agent"), Type.Literal("global"), Type.Literal("all")], {
          description: 'Where to search (default "all": your notes plus the shared ones)',
        }),
      ),
      limit: Type.Optional(Type.Number({ description: "Maximum results (default 20, max 50)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const terms = (params.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const tags = params.tags ?? [];
      const limit = Math.min(50, Math.max(1, Math.round(params.limit ?? 20)));
      const matches: NoteEntry[] = [];
      for (const root of rootsFor(params.scope ?? "all")) {
        for (const entry of scanRoot(root)) {
          if (match(entry, terms, tags)) matches.push(entry);
        }
      }
      matches.sort((a, b) => b.modified.localeCompare(a.modified) || a.title.localeCompare(b.title));
      const shown = matches.slice(0, limit);

      const formatted =
        shown.length === 0
          ? `No notes match${params.query ? ` "${params.query}"` : ""}.`
          : shown
              .map((e) => {
                const tags = e.tags.length > 0 ? ` {${e.tags.join(", ")}}` : "";
                return `- ${e.root}:${e.path} — ${e.title} — ${e.description}${tags} · ${e.modified}`;
              })
              .join("\n") + (matches.length > limit ? `\n… ${matches.length - limit} more` : "");

      return {
        content: text(formatted),
        details: { count: matches.length, entries: shown.map((e) => ({ root: e.root, path: e.path, title: e.title })) },
      };
    },
  });

  pi.registerTool({
    name: "memory_read",
    label: "Memory Read",
    description: "Read one note by root and path, as returned by memory_search.",
    parameters: Type.Object({
      root: Type.Union([Type.Literal("agent"), Type.Literal("global")], { description: "Which note set" }),
      path: Type.String({ description: "Path relative to the notes folder, from memory_search" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const root = rootFor(params.root);
      const abs = safePath(root, params.path);
      if (!fs.existsSync(abs)) throw new Error(`memory_read: no such note: ${params.root}:${params.path}`);
      return {
        content: text(fs.readFileSync(abs, "utf-8")),
        details: { root: root.kind, path: params.path },
      };
    },
  });

  pi.registerTool({
    name: "memory_write",
    label: "Memory Write",
    description:
      "Create or update a note with frontmatter (title, description, tags). Description is the retrieval key — write it as \"use when…\". Defaults to your own notes; scope \"global\" writes to the shared set when another agent will need the fact, and you should say so in chat.",
    parameters: Type.Object({
      title: Type.String({ description: "Short note title" }),
      description: Type.String({ description: 'One line: when this note is useful ("use when…")' }),
      body: Type.String({ description: "The note, markdown" }),
      tags: Type.Optional(Type.Array(Type.String())),
      scope: Type.Optional(Type.Union([Type.Literal("agent"), Type.Literal("global")], { description: 'Default "agent"' })),
      path: Type.Optional(
        Type.String({ description: "Existing note path to update, or a new path (e.g. projects/work.md); default: slug of the title" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const root = rootFor(params.scope ?? "agent");
      const tags = params.tags ?? [];
      if (!params.title.trim()) throw new Error("memory_write: title is required");
      if (!params.description.trim()) throw new Error("memory_write: description is required");

      let rel: string;
      let created: string | undefined;
      if (params.path) {
        rel = params.path.replace(/\\/g, "/").replace(/^\/+/, "");
        if (!rel.endsWith(".md")) rel += ".md";
        const abs = safePath(root, rel);
        if (fs.existsSync(abs)) {
          const existing = parseFrontmatter(fs.readFileSync(abs, "utf-8")).meta;
          created = typeof existing.created === "string" ? existing.created : undefined;
        }
      } else {
        rel = `${slug(params.title)}.md`;
        let candidate = rel;
        let n = 2;
        while (fs.existsSync(safePath(root, candidate))) candidate = `${rel.replace(/\.md$/, "")}-${n++}.md`;
        rel = candidate;
      }

      const abs = safePath(root, rel);
      const meta: Meta = {
        title: params.title.trim(),
        description: params.description.trim(),
        tags: tags.map((t) => t.trim()).filter(Boolean),
        created: created ?? today(),
        updated: today(),
      };
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, serialize(meta, params.body), "utf-8");
      writeIndex(root);

      const verb = created ? "updated" : "wrote";
      return {
        content: text(`${verb} ${root.kind}:${rel} — commit it when it matters.`),
        details: { root: root.kind, path: rel },
      };
    },
  });
}
