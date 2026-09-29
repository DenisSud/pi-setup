/**
 * Harness tests for the v2 memory extension.
 *
 * Drives the registered tools directly against temp roots with a stubbed
 * ExtensionAPI: no model, no network, no real memory repo.
 *
 *   ./test/run.sh harness
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── environment (must be set before the factory runs) ─────────────────────

const TMP = mkdtempSync(join(tmpdir(), "memory-harness-"));
const AGENT = join(TMP, "agent");
const SHARED = join(TMP, "shared");
process.env.PI_CODING_AGENT_DIR = AGENT;
process.env.PI_MEMORY_DIR = SHARED;

const mod = await import("../index.ts");
const factory = mod.default;

// ── tiny test runner ──────────────────────────────────────────────────────

const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || "values differ"}\n  actual:   ${a}\n  expected: ${e}`);
}

function stubPi() {
  const tools = new Map();
  const handlers = {};
  return {
    registerTool: (def) => tools.set(def.name, def),
    on: (event, fn) => (handlers[event] = fn),
    registerCommand: () => {},
    tools,
    handlers,
  };
}

async function runTool(tool, params) {
  try {
    const result = await tool.execute("call-1", params, undefined, undefined, undefined);
    if ("isError" in result) throw new Error("execute returned `isError` — pi ignores it; throw instead");
    return result;
  } catch (err) {
    return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], details: {}, isError: true };
  }
}

const resultText = (res) => res.content[0].text;

// ── setup ─────────────────────────────────────────────────────────────────

const pi = stubPi();
factory(pi);
const search = pi.tools.get("memory_search");
const read = pi.tools.get("memory_read");
const write = pi.tools.get("memory_write");

assert(search && read && write, "memory tools registered");

// ── tests ─────────────────────────────────────────────────────────────────

test("first run creates the layout", () => {
  assert(existsSync(join(AGENT, "notes")), "agent notes dir");
  assert(existsSync(join(SHARED, "notes")) || existsSync(SHARED), "shared root");
  assert(existsSync(join(SHARED, "USER.md")), "USER.md template");
  assert(existsSync(join(SHARED, ".git")), "shared root is a repo");
});

test("write creates a note with frontmatter and an index", async () => {
  const res = await runTool(write, {
    title: "GKS-U deadlines",
    description: "Key dates of the Korean scholarship application — use when planning education deadlines.",
    body: "# GKS-U\n\nEmbassy deadline 30 Sep 12:00.",
    tags: ["education", "grants"],
  });
  assert(!res.isError, `write failed: ${resultText(res)}`);
  assertEqual(res.details.root, "agent");
  assertEqual(res.details.path, "gks-u-deadlines.md");

  const file = readFileSync(join(AGENT, "notes", "gks-u-deadlines.md"), "utf-8");
  assert(file.startsWith("---\n"), "frontmatter");
  assert(file.includes("title: GKS-U deadlines"), "title in frontmatter");
  assert(file.includes("tags: [education, grants]"), "tags in frontmatter");

  const index = readFileSync(join(AGENT, "notes", "index.md"), "utf-8");
  assert(index.includes("GKS-U deadlines"), "index lists the note");
  assert(index.includes("do not edit"), "index marks itself generated");
});

test("search finds by text, tag and body", async () => {
  let res = await runTool(search, { query: "korean" });
  assert(!res.isError, resultText(res));
  assert(resultText(res).includes("gks-u-deadlines.md"), "query matches description/title");

  res = await runTool(search, { tags: ["grants"] });
  assert(resultText(res).includes("gks-u-deadlines.md"), "tag matches");

  res = await runTool(search, { query: "embassy" });
  assert(resultText(res).includes("gks-u-deadlines.md"), "body text matches");

  res = await runTool(search, { query: "no-such-thing-anywhere" });
  assert(resultText(res).includes("No notes match"), "empty search is clean");
});

test("read returns the full note", async () => {
  const res = await runTool(read, { root: "agent", path: "gks-u-deadlines.md" });
  assert(!res.isError, resultText(res));
  assert(resultText(res).includes("Embassy deadline"), "body present");
  assert(resultText(res).includes("title: GKS-U deadlines"), "frontmatter present");
});

test("scope global writes to the shared root and stays out of agent scope", async () => {
  const res = await runTool(write, {
    title: "PC GPU",
    description: "Denis's desktop has an RTX 5070 — use when picking local models or CUDA builds.",
    body: "RTX 5070, 12 GB.",
    tags: ["machines"],
    scope: "global",
  });
  assert(!res.isError, resultText(res));
  assertEqual(res.details.root, "global");
  assert(existsSync(join(SHARED, "pc-gpu.md")), "note in shared root");

  const agentOnly = await runTool(search, { query: "RTX", scope: "agent" });
  assert(!resultText(agentOnly).includes("pc-gpu.md"), "not in agent scope");

  const globalOnly = await runTool(search, { query: "RTX", scope: "global" });
  assert(resultText(globalOnly).includes("pc-gpu.md"), "in global scope");

  const all = await runTool(search, { query: "RTX" });
  assert(resultText(all).includes("global:pc-gpu.md"), "root is labelled in results");
});

test("update keeps the original created date and path", async () => {
  const before = readFileSync(join(AGENT, "notes", "gks-u-deadlines.md"), "utf-8");
  const created = before.match(/created: (\S+)/)?.[1];
  const res = await runTool(write, {
    title: "GKS-U deadlines",
    description: "Updated description — use when planning education deadlines.",
    body: "# GKS-U\n\nEmbassy deadline moved.",
    path: "gks-u-deadlines.md",
  });
  assert(!res.isError, resultText(res));
  const after = readFileSync(join(AGENT, "notes", "gks-u-deadlines.md"), "utf-8");
  assert(after.includes(`created: ${created}`), "created preserved");
  assert(after.includes("Updated description"), "description replaced");
  const files = readFileSync(join(AGENT, "notes", "index.md"), "utf-8");
  assertEqual(files.match(/gks-u-deadlines\.md/g).length, 1, "no duplicate entry");
});

test("notes without frontmatter get a fallback title and description", async () => {
  mkdirSync(join(SHARED, "knowledge"), { recursive: true });
  writeFileSync(join(SHARED, "knowledge", "plain-note.md"), "# Zeigarnik result\n\nNo memory advantage for interrupted tasks.\n");
  const res = await runTool(search, { query: "Zeigarnik" });
  assert(resultText(res).includes("knowledge/plain-note.md"), "found by heading");
  assert(resultText(res).includes("Zeigarnik result"), "title from H1");
  assert(resultText(res).includes("No memory advantage"), "description from first line");
});

test("generated index skips itself, system files and archive", async () => {
  mkdirSync(join(SHARED, "archive"), { recursive: true });
  writeFileSync(join(SHARED, "archive", "old.md"), "# Old\n\nSuperseded.\n");
  const res = await runTool(write, {
    title: "Index hygiene",
    description: "Check generated index contents.",
    body: "x",
    scope: "global",
  });
  assert(!res.isError, resultText(res));
  const index = readFileSync(join(SHARED, "index.md"), "utf-8");
  assert(!index.includes("archive/old.md"), "archive excluded");
  assert(!index.includes("USER.md"), "USER excluded");
  assert(!index.includes("memory.md"), "memory.md excluded");
  assert(index.includes("Index hygiene"), "own note included");
});

test("path traversal is rejected", async () => {
  const res = await runTool(write, {
    title: "Escape",
    description: "Should not land outside the notes root.",
    body: "x",
    path: "../escape.md",
  });
  assert(res.isError, "traversal should fail");
  assert(!existsSync(join(AGENT, "escape.md")), "nothing written outside");
});

test("description with a colon survives the round trip", async () => {
  const res = await runTool(write, {
    title: "Colons: a test",
    description: "Use when: testing quoting.",
    body: "body",
  });
  assert(!res.isError, resultText(res));
  const found = await runTool(search, { query: "testing quoting" });
  assert(resultText(found).includes("Colons: a test"), "survived");
});

test("injection carries policy, SOUL and USER", () => {
  writeFileSync(join(AGENT, "SOUL.md"), "# SOUL\n\nCalm and curious.\n");
  writeFileSync(join(SHARED, "USER.md"), "# Denis\n\nWorks on ML systems.\n");
  const context = mod.buildMemoryContext();
  assert(context.includes("Memory is a few files"), "policy present");
  assert(context.includes("Calm and curious"), "agent SOUL present");
  assert(context.includes("Works on ML systems"), "USER present");
  assert(!context.includes("index.md"), "no index content injected");
});

test("base agent (agent dir == shared dir) collapses to one note set", async () => {
  const BASE = join(TMP, "base");
  process.env.PI_CODING_AGENT_DIR = BASE;
  process.env.PI_MEMORY_DIR = BASE;
  try {
    const basePi = stubPi();
    factory(basePi);
    const baseWrite = basePi.tools.get("memory_write");
    const res = await runTool(baseWrite, {
      title: "Base note",
      description: "Written by the base agent.",
      body: "x",
      scope: "global",
    });
    assert(!res.isError, resultText(res));
    assertEqual(res.details.root, "agent", "single root is the agent root");
    assert(existsSync(join(BASE, "base-note.md")), "note at the root of the repo");

    const baseSearch = basePi.tools.get("memory_search");
    const found = await runTool(baseSearch, { query: "Base note" });
    assert(resultText(found).includes("base-note.md"), "searchable");
    assertEqual((resultText(found).match(/base-note\.md/g) || []).length, 1, "no duplicate roots");
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = AGENT;
    process.env.PI_MEMORY_DIR = SHARED;
  }
});

// ── run ───────────────────────────────────────────────────────────────────

for (const t of tests) {
  try {
    await t.fn();
    passed++;
    console.log(`  ok    ${t.name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${t.name}`);
    console.error(`        ${String(err.message).split("\n").slice(0, 8).join("\n        ")}`);
  }
}
console.log(`\n${passed}/${tests.length} passed, ${failed} failed`);
rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
