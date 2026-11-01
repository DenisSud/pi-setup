#!/usr/bin/env node
// Guards the skill catalog: the invocation split, names, and relative links.
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const skillsRoot = path.join(root, "skills");

const MODEL_INVOKED = new Set([
	"agent-browser",
	"babysit-pr",
	"codebase-design",
	"diagnosing-bugs",
	"domain-modeling",
	"full-send",
	"latex-pdf",
	"pr",
	"prototype",
	"research",
	"review-loop",
	"self-improvement",
	"tdd",
	"unslop",
	"wizard",
	"workflow-engineering",
	"writing-for-agents",
]);

const USER_INVOKED = new Set([
	"ascii-animation",
	"deep-research",
	"grill",
	"handoff",
	"improve-codebase-architecture",
	"just-do-it",
	"show-me",
	"spec",
	"teach",
	"wait-what",
]);

function walk(dir) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else if (entry.name === "SKILL.md") out.push(full);
	}
	return out;
}

function frontmatter(text) {
	const match = text.match(/^---\n([\s\S]*?)\n---\n/);
	if (!match) throw new Error("missing frontmatter");
	return match[1];
}

const errors = [];
const seen = new Set();
const files = walk(skillsRoot).sort();

for (const file of files) {
	const rel = path.relative(root, file);
	const text = fs.readFileSync(file, "utf8");
	let fm;
	try {
		fm = frontmatter(text);
	} catch {
		errors.push(`${rel}: missing frontmatter`);
		continue;
	}
	const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim();
	if (!name) {
		errors.push(`${rel}: missing name`);
		continue;
	}
	if (name !== path.basename(path.dirname(file))) {
		errors.push(`${rel}: name "${name}" does not match directory`);
	}
	if (seen.has(name)) errors.push(`${rel}: duplicate skill name "${name}"`);
	seen.add(name);

	const disabled = /^disable-model-invocation:\s*true$/m.test(fm);
	if (MODEL_INVOKED.has(name) === disabled) {
		errors.push(`${rel}: ${name} is ${disabled ? "user-invoked" : "model-invoked"} but the list says otherwise`);
	}
	if (MODEL_INVOKED.has(name) && !/Use when|Use after|Use before|Use from/.test(fm)) {
		errors.push(`${rel}: model-invoked description needs a trigger ("Use when ...")`);
	}

	const dir = path.dirname(file);
	for (const match of text.matchAll(/`(\.\.?\/[^`]*?SKILL\.md)`/g)) {
		const target = path.resolve(dir, match[1]);
		if (!fs.existsSync(target)) errors.push(`${rel}: broken link ${match[1]}`);
	}
}

for (const name of MODEL_INVOKED) if (!seen.has(name)) errors.push(`missing model-invoked skill: ${name}`);
for (const name of USER_INVOKED) if (!seen.has(name)) errors.push(`missing user-invoked skill: ${name}`);

if (errors.length) {
	for (const error of errors) console.error(`- ${error}`);
	process.exit(1);
}
console.log(`ok: ${MODEL_INVOKED.size} model-invoked, ${USER_INVOKED.size} user-invoked, ${files.length} total`);
