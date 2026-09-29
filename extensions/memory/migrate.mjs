#!/usr/bin/env node
/**
 * One-time migration to the v2 memory layout.
 *
 *   node migrate.mjs [--root DIR] [--dry]
 *
 * The shared notes repo is already shaped like v2's "notes folder" (its root),
 * so nothing moves. This only:
 *   - renames memory.md -> USER.md (when USER.md is absent)
 *   - deletes the hand-written category index.md files (the generated root
 *     index replaces them)
 *   - leaves SOUL.md, all notes and archive/ in place
 *
 * Idempotent; the extension regenerates index.md on the next session start.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const rootArg = args.find((a) => !a.startsWith("--"));
const root = path.resolve(rootArg || process.env.PI_MEMORY_DIR || path.join(os.homedir(), ".pi/agent/memory"));

const isRepo = () => fs.existsSync(path.join(root, ".git"));
const git = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf-8" }).trim();
const exists = (rel) => fs.existsSync(path.join(root, rel));

if (!fs.existsSync(root)) {
  console.error(`migrate: no such root: ${root}`);
  process.exit(1);
}

const actions = [];
if (exists("memory.md") && !exists("USER.md")) actions.push({ kind: "rename", from: "memory.md", to: "USER.md" });
for (const dir of ["preferences", "projects", "knowledge", "personal", "research"]) {
  if (exists(`${dir}/index.md`)) actions.push({ kind: "remove", from: `${dir}/index.md` });
}

if (actions.length === 0) {
  console.log(`migrate: already current — ${root}`);
  process.exit(0);
}

for (const action of actions) {
  console.log(`  ${action.kind} ${action.from}${action.to ? ` -> ${action.to}` : ""}`);
}
if (dry) {
  console.log("migrate: dry run, nothing changed");
  process.exit(0);
}

for (const action of actions) {
  if (action.kind === "rename") {
    if (isRepo()) git("mv", action.from, action.to);
    else fs.renameSync(path.join(root, action.from), path.join(root, action.to));
  } else {
    if (isRepo()) git("rm", "-q", action.from);
    else fs.unlinkSync(path.join(root, action.from));
  }
}
console.log(`migrate: done — ${root} (staged; commit when ready)`);
