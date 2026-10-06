/**
 * Harness tests for the gmail extension.
 *
 * Drives the registered tools directly against a stubbed ExtensionAPI, a fake
 * IMAP server (setImapFactory) and a stub `rbw` binary, so the whole path runs
 * — guard, id resolution, MIME decoding, drafts lifecycle, audit log — without
 * touching the network or the real vault.
 *
 *   ./test/run.sh harness   fake IMAP + stub rbw (no network)
 *   ./test/run.sh live      real Gmail login, read-only checks
 *                           (GMAIL_LIVE_WRITE=1 adds the draft cycle)
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { ImapFlow } from "imapflow";
import { closeClient, normalizeAppPassword, resetState, setImapFactory } from "../client.ts";
import { AUDIT_LIMIT, isMailboxKey, MAILBOX_KEYS } from "../guard.ts";
import gmailExtension from "../index.ts";
import { attachmentsOf, bodyPartsOf, decodeTransfer, encodeHeader, htmlToText } from "../mime.ts";

// ── environment ───────────────────────────────────────────────────────────

const TMP = mkdtempSync(join(tmpdir(), "gmail-harness-"));
const CONFIG = join(TMP, "config.json");
const AUDIT = join(TMP, "audit.jsonl");
const ATTACHMENTS = join(TMP, "attachments");

/** Stub rbw: prints one password for any item, so the security module is
 *  exercised for real (config parsing, execFile, env handoff). */
function stubRbw() {
	const path = join(TMP, "rbw");
	writeFileSync(path, '#!/bin/sh\necho "${RBW_STUB_PASSWORD:-harness-app-password}"\n', { mode: 0o755 });
	writeFileSync(
		join(TMP, "security.json"),
		JSON.stringify({
			profiles: { gmail: { vars: { GMAIL_APP_PASSWORD: { item: "Test", field: "password", folder: "pi" } } } },
			rbw: { command: path, timeoutMs: 5000 },
		}),
	);
	process.env.PI_SECURITY_CONFIG = join(TMP, "security.json");
}

function writeConfig(extra = {}) {
	writeFileSync(
		CONFIG,
		JSON.stringify({ username: "denis@example.com", auditLog: AUDIT, attachmentDir: ATTACHMENTS, ...extra }),
	);
}

writeConfig();
stubRbw();
process.env.GMAIL_CONFIG = CONFIG;
rmSync(AUDIT, { force: true });

// ── tiny test runner ──────────────────────────────────────────────────────

const tests = [];
const liveTests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
	tests.push({ name, fn });
}

function liveTest(name, fn) {
	if (process.env.GMAIL_LIVE) liveTests.push({ name, fn });
}

function assert(cond, msg) {
	if (!cond) throw new Error(msg || "assertion failed");
}

function assertEqual(actual, expected, msg) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) throw new Error(`${msg || "values differ"}\n  actual:   ${a}\n  expected: ${e}`);
}

function makePi() {
	const tools = new Map();
	return {
		registerTool: (def) => tools.set(def.name, def),
		on: () => {},
		tools,
	};
}

async function runTool(tool, params) {
	try {
		const result = await tool.execute("call-1", params, undefined, undefined, undefined);
		if ("isError" in result) throw new Error("execute returned `isError` — pi ignores that field; throw instead");
		return result;
	} catch (err) {
		return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], details: {}, isError: true };
	}
}

// ── fake IMAP server ──────────────────────────────────────────────────────

const SPECIAL_USE = {
	INBOX: "\\Inbox",
	"[Gmail]/All Mail": "\\All",
	"[Gmail]/Sent Mail": "\\Sent",
	"[Gmail]/Drafts": "\\Drafts",
	"[Gmail]/Spam": "\\Junk",
	"[Gmail]/Trash": "\\Trash",
};

let nextUid = 100;
let nextEmailId = 9000;

/** Build one stored message with an IMAP-ish body structure. */
function message({ mailbox = "[Gmail]/All Mail", from = "alice@example.com", to = "denis@example.com", subject = "Hello", text, html, date = new Date("2026-09-20T10:00:00Z"), flags = [], attachments = [], searchable = "", threadId }) {
	const uid = nextUid++;
	const emailId = String(nextEmailId++);
	const bodyParts = new Map();
	let bodyStructure;

	if (attachments.length) {
		const children = [];
		let part = 1;
		if (text !== undefined) {
			children.push({ type: "text/plain", parameters: { charset: "utf-8" }, encoding: "quoted-printable", part: String(part) });
			bodyParts.set(String(part), Buffer.from(quotedPrintable(text)));
			part++;
		}
		if (html !== undefined) {
			children.push({ type: "text/html", parameters: { charset: "utf-8" }, encoding: "quoted-printable", part: String(part) });
			bodyParts.set(String(part), Buffer.from(quotedPrintable(html)));
			part++;
		}
		for (const attachment of attachments) {
			children.push({
				type: attachment.type,
				disposition: "attachment",
				dispositionParameters: { filename: attachment.filename },
				encoding: "base64",
				size: attachment.content.length,
				part: String(part),
			});
			bodyParts.set(String(part), Buffer.from(attachment.content.toString("base64")));
			part++;
		}
		bodyStructure = { type: "multipart/mixed", childNodes: children };
	} else if (html !== undefined && text === undefined) {
		bodyStructure = { type: "text/html", parameters: { charset: "utf-8" }, encoding: "base64" };
		bodyParts.set("TEXT", Buffer.from(html, "utf8").toString("base64"));
	} else {
		bodyStructure = { type: "text/plain", parameters: { charset: "utf-8" }, encoding: "quoted-printable" };
		bodyParts.set("TEXT", Buffer.from(quotedPrintable(text ?? "")));
	}

	return {
		mailbox,
		uid,
		seq: uid,
		emailId,
		threadId: threadId ?? `T${emailId}`,
		flags: new Set(flags),
		labels: new Set(["\\Inbox"]),
		envelope: { from: [{ name: "Alice", address: from }], to: [{ name: "", address: to }], subject, date, messageId: `<${emailId}@example.com>`, inReplyTo: undefined },
		bodyStructure,
		bodyParts,
		searchable: `${searchable} ${from} ${to} ${subject} ${text ?? ""} ${html ?? ""}`,
	};
}

/** Quoted-printable encoder good enough for the fixtures (and it forces the
 *  decoder to do real work: soft breaks, =XX escapes, a Cyrillic line). */
function quotedPrintable(text) {
	const encoded = Buffer.from(text, "utf8")
		.toString("latin1")
		.replace(/[^\x20-\x7e\t\r\n]/g, (char) => `=${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
	const lines = encoded.split("\n").map((line) => (line.length > 60 ? `${line.slice(0, 60)}=\r\n${line.slice(60)}` : line));
	return lines.join("\n");
}

class FakeImap {
	constructor(messages) {
		this.boxes = new Map();
		for (const message of messages) {
			if (!this.boxes.has(message.mailbox)) this.boxes.set(message.mailbox, []);
			this.boxes.get(message.mailbox).push(message);
		}
		for (const path of Object.keys(SPECIAL_USE)) if (!this.boxes.has(path)) this.boxes.set(path, []);
		this.selected = undefined;
		this.appended = [];
		this.deleted = [];
		this.usable = false;
	}

	async connect() {
		this.usable = true;
	}

	async logout() {
		this.usable = false;
	}

	close() {
		this.usable = false;
	}

	on() {}

	async list() {
		return [...this.boxes.keys()].map((path) => ({ path, specialUse: SPECIAL_USE[path] }));
	}

	async getMailboxLock(path) {
		this.selected = path;
		return { release: () => (this.selected = undefined) };
	}

	matches(query) {
		const messages = this.boxes.get(this.selected) ?? [];
		if (query.gmraw !== undefined) {
			const tokens = String(query.gmraw).split(/\s+/).filter(Boolean);
			return messages.filter((message) =>
				tokens.every((token) => {
					const negated = token.startsWith("-");
					const word = (negated ? token.slice(1) : token).toLowerCase();
					const hit = message.searchable.toLowerCase().includes(word);
					return negated ? !hit : hit;
				}),
			);
		}
		if (query.emailId !== undefined) return messages.filter((message) => message.emailId === String(query.emailId));
		if (query.threadId !== undefined) return messages.filter((message) => message.threadId === String(query.threadId));
		if (query.all) return messages;
		throw new Error(`fake imap: unsupported search ${JSON.stringify(query)}`);
	}

	async search(query, _options) {
		return this.matches(query).map((message) => message.uid);
	}

	async fetchAll(uids, _query, _options) {
		const wanted = new Set(uids);
		return (this.boxes.get(this.selected) ?? []).filter((message) => wanted.has(message.uid));
	}

	async fetchOne(uid, query, _options) {
		const message = (this.boxes.get(this.selected) ?? []).find((entry) => entry.uid === Number(uid));
		if (!message) return false;
		if (query?.bodyParts) {
			const parts = new Map();
			for (const part of query.bodyParts) if (message.bodyParts.has(part)) parts.set(part, message.bodyParts.get(part));
			return { ...message, bodyParts: parts };
		}
		return message;
	}

	async append(path, content, flags, _date) {
		this.appended.push({ path, content, flags });
		const text = String(content);
		const stored = message({
			mailbox: path,
			subject: /^Subject: (.*)$/m.exec(text)?.[1] ?? "",
			to: /^To: (.*)$/m.exec(text)?.[1] ?? "",
			text: text.split("\r\n\r\n").slice(1).join("\r\n\r\n"),
			flags,
			searchable: "draft",
		});
		stored.mailbox = path;
		this.boxes.get(path).push(stored);
		return { uid: stored.uid, uidValidity: 1, destination: path };
	}

	async messageDelete(uid, _options) {
		const messages = this.boxes.get(this.selected) ?? [];
		const index = messages.findIndex((message) => message.uid === Number(uid));
		if (index < 0) return false;
		this.deleted.push({ path: this.selected, uid: Number(uid) });
		messages.splice(index, 1);
		return true;
	}

	async download(uid, part, _options) {
		const message = (this.boxes.get(this.selected) ?? []).find((entry) => entry.uid === Number(uid));
		const node = flatten(message.bodyStructure).find((entry) => (entry.part ?? "TEXT") === part);
		const raw = message.bodyParts.get(part) ?? Buffer.alloc(0);
		return {
			meta: {
				contentType: node?.type ?? "application/octet-stream",
				filename: node?.dispositionParameters?.filename,
				encoding: node?.encoding,
				expectedSize: raw.length,
			},
			content: Readable.from([raw]),
		};
	}
}

function flatten(node, out = []) {
	out.push(node);
	for (const child of node?.childNodes ?? []) flatten(child, out);
	return out;
}

// ── fixtures ──────────────────────────────────────────────────────────────

const PLAIN = message({ subject: "Invoice 42", text: "Hi Denis,\nThe invoice is attached.\n\n— Alice", searchable: "invoice" });
const HTML_ONLY = message({ subject: "Newsletter", html: "<html><body><h1>Weekly</h1><p>Nothing <b>important</b> happened.</p></body></html>", searchable: "newsletter" });
const ATTACHED = message({
	subject: "Report",
	text: "See attached.",
	attachments: [{ filename: "report.pdf", type: "application/pdf", content: Buffer.from("%PDF-1.4 fake") }],
	searchable: "report",
});
const DRAFT = message({ mailbox: "[Gmail]/Drafts", subject: "Draft: lunch", to: "bob@example.com", text: "Lunch tomorrow?", flags: ["\\Draft"], searchable: "draft" });

const ALL_MESSAGES = [PLAIN, HTML_ONLY, ATTACHED, DRAFT];
const REAL_FETCH = globalThis.fetch;
/** Auth the fake IMAP client was handed on its last connect. */
let lastAuth;

async function useServer(messages = ALL_MESSAGES) {
	await closeClient();
	const server = new FakeImap(messages);
	setImapFactory((options) => {
		lastAuth = options?.auth;
		return server;
	});
	return server;
}

function readAudit() {
	return readFileSync(AUDIT, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// ── unit tests: mime ──────────────────────────────────────────────────────

test("decodeTransfer: base64 round trip", () => {
	const encoded = Buffer.from("Grüße, Denis!", "utf8").toString("base64");
	assertEqual(decodeTransfer(Buffer.from(encoded), "base64").toString("utf8"), "Grüße, Denis!");
});

test("decodeTransfer: quoted-printable with soft breaks and escapes", () => {
	const input = Buffer.from("Gr=C3=BC=C3=9Fe, soft=\r\n break", "latin1");
	assertEqual(decodeTransfer(input, "quoted-printable").toString("utf8"), "Grüße, soft break");
});

test("encodeHeader: ascii passes through, cyrillic is RFC2047", () => {
	assertEqual(encodeHeader("Plain subject"), "Plain subject");
	const encoded = encodeHeader("Обед завтра");
	assert(encoded.startsWith("=?UTF-8?B?"), `expected RFC2047, got ${encoded}`);
	assertEqual(Buffer.from(encoded.slice(10, -2), "base64").toString("utf8"), "Обед завтра");
});

test("htmlToText: drops tags and images", () => {
	const text = htmlToText("<p>Hello <b>world</b></p><img src='x'><p><a href='https://e.com'>link</a></p>");
	assert(text.includes("Hello world"), text);
	assert(!text.includes("<"), text);
});

test("attachmentsOf/bodyPartsOf: multipart structure", () => {
	const parts = attachmentsOf(ATTACHED.bodyStructure);
	assertEqual(parts.map((part) => [part.part, part.filename, part.type]), [["2", "report.pdf", "application/pdf"]]);
	assertEqual(bodyPartsOf(ATTACHED.bodyStructure), { text: "1", html: undefined });
});

test("guard: mailbox keys", () => {
	assert(isMailboxKey("drafts"));
	assert(!isMailboxKey("Drafts"));
	assertEqual(MAILBOX_KEYS.length, 6);
});

// ── tool tests ────────────────────────────────────────────────────────────

const pi = makePi();
gmailExtension(pi);
const tool = (name) => pi.tools.get(name);

test("all eight email tools are registered", () => {
	assertEqual(
		[...pi.tools.keys()].sort(),
		[
			"email_create_draft",
			"email_delete_draft",
			"email_get_attachment",
			"email_get_message",
			"email_get_thread",
			"email_list_drafts",
			"email_search",
			"email_update_draft",
		],
	);
});

test("email_search: newest first, limit, audit entry, ids in the output", async () => {
	await useServer();
	rmSync(AUDIT, { force: true });
	const result = await runTool(tool("email_search"), { query: "alice", limit: 2 });
	const text = result.content[0].text;
	assert(!result.isError, text);
	const ids = [...text.matchAll(/id: (\d+)/g)].map((match) => match[1]);
	assertEqual(ids.length, 2, text);
	assert(Number(ids[0]) > Number(ids[1]), "newest first");
	assert(text.includes("thread: T"), text);
	const audit = readAudit();
	assertEqual(audit.at(-1).op, "search");
	assertEqual(audit.at(-1).count, 2);
});

test("email_search: mailbox parameter selects that folder", async () => {
	const server = await useServer();
	await runTool(tool("email_search"), { query: "draft", mailbox: "drafts" });
	assertEqual(server.selected, undefined, "lock released");
	assert(server.boxes.get("[Gmail]/Drafts").length === 1);
});

test("email_get_message: decodes the body and lists attachments", async () => {
	await useServer();
	const result = await runTool(tool("email_get_message"), { id: ATTACHED.emailId });
	const text = result.content[0].text;
	assert(!result.isError, text);
	assert(text.includes("See attached."), text);
	assert(text.includes("part 2: report.pdf (application/pdf"), text);
	assert(text.includes(`id: ${ATTACHED.emailId}`), text);
});

test("email_get_message: html-only mail is converted to text", async () => {
	await useServer();
	const result = await runTool(tool("email_get_message"), { id: HTML_ONLY.emailId });
	assert(result.content[0].text.includes("Nothing important happened."), result.content[0].text);
});

test("email_get_message: body truncation is reported", async () => {
	writeConfig({ maxBodyChars: 40 });
	await resetState();
	await useServer([message({ subject: "Long", text: "x".repeat(200), searchable: "long" })]);
	const result = await runTool(tool("email_get_message"), { id: String(nextEmailId - 1) });
	const text = result.content[0].text;
	assert(text.includes("truncated, 200 chars total"), `${text.length} chars: ${text.slice(0, 120)}`);
	assertEqual(result.details.truncated, true);
	writeConfig();
	await resetState();
});

test("email_get_message: unknown id fails with a useful message", async () => {
	await useServer();
	const result = await runTool(tool("email_get_message"), { id: "123456789" });
	assert(result.isError, "expected an error");
	assert(result.content[0].text.includes("X-GM-MSGID"), result.content[0].text);
});

test("email_get_thread: oldest first", async () => {
	const first = message({ subject: "Trip", text: "when?", date: new Date("2026-09-01T08:00:00Z"), searchable: "trip" });
	const second = message({ subject: "Re: Trip", text: "friday", date: new Date("2026-09-02T08:00:00Z"), searchable: "trip", threadId: first.threadId });
	await useServer([first, second]);
	const result = await runTool(tool("email_get_thread"), { thread_id: first.threadId });
	const text = result.content[0].text;
	assert(text.indexOf("2026-09-01") < text.indexOf("2026-09-02"), text);
	assertEqual(result.details.count, 2);
});

test("email_get_attachment: writes the file and never overwrites", async () => {
	await useServer();
	const first = await runTool(tool("email_get_attachment"), { id: ATTACHED.emailId });
	assert(!first.isError, first.content[0].text);
	assertEqual(first.details.path, join(ATTACHMENTS, "report.pdf"));
	assertEqual(readFileSync(first.details.path, "utf8"), "%PDF-1.4 fake");
	const second = await runTool(tool("email_get_attachment"), { id: ATTACHED.emailId });
	assertEqual(second.details.path, join(ATTACHMENTS, "report (2).pdf"));
});

test("email_get_attachment: multiple attachments need an explicit part", async () => {
	const multi = message({
		subject: "Two files",
		text: "both",
		attachments: [
			{ filename: "a.txt", type: "text/plain", content: Buffer.from("a") },
			{ filename: "b.txt", type: "text/plain", content: Buffer.from("b") },
		],
		searchable: "two",
	});
	await useServer([multi]);
	const result = await runTool(tool("email_get_attachment"), { id: multi.emailId });
	assert(result.isError, "expected an error");
	assert(result.content[0].text.includes("a.txt"), result.content[0].text);
	const explicit = await runTool(tool("email_get_attachment"), { id: multi.emailId, part: "3" });
	assertEqual(explicit.details.path, join(ATTACHMENTS, "b.txt"));
});

test("email_list_drafts: lists the drafts folder", async () => {
	await useServer();
	const result = await runTool(tool("email_list_drafts"), {});
	assert(result.content[0].text.includes("Draft: lunch"), result.content[0].text);
	assertEqual(result.details.count, 1);
});

test("email_create_draft: appends to Drafts with the \\Draft flag", async () => {
	const server = await useServer();
	const result = await runTool(tool("email_create_draft"), { to: "bob@example.com", subject: "Обед", body: "Завтра в 13:00?" });
	assert(!result.isError, result.content[0].text);
	assertEqual(server.appended.length, 1);
	assertEqual(server.appended[0].path, "[Gmail]/Drafts");
	assertEqual(server.appended[0].flags, ["\\Draft"]);
	const content = server.appended[0].content;
	assert(content.includes("To: bob@example.com"), content);
	assert(content.includes("Subject: =?UTF-8?B?"), content);
	assert(content.includes("Content-Type: text/plain; charset=utf-8"), content);
	assert(/^id: \d+$/m.test(result.content[0].text), result.content[0].text);
});

test("email_update_draft: replaces the old draft", async () => {
	const server = await useServer();
	const created = await runTool(tool("email_create_draft"), { to: "bob@example.com", subject: "Lunch", body: "Tomorrow?" });
	const id = created.details.id;
	const updated = await runTool(tool("email_update_draft"), { id, subject: "Lunch (moved)" });
	assert(!updated.isError, updated.content[0].text);
	assert(updated.details.id !== id, "a new id is issued");
	assertEqual(server.deleted, [{ path: "[Gmail]/Drafts", uid: created.details.uid }]);
	const drafts = server.boxes.get("[Gmail]/Drafts").filter((message) => message.searchable.includes("draft"));
	assert(drafts.some((message) => message.envelope.subject === "Lunch (moved)"), "new draft stored");
	assert(!drafts.some((message) => message.envelope.subject === "Lunch"), "old draft gone");
});

test("email_delete_draft: deletes only in Drafts and audits it", async () => {
	const server = await useServer();
	rmSync(AUDIT, { force: true });
	const result = await runTool(tool("email_delete_draft"), { id: DRAFT.emailId });
	assert(!result.isError, result.content[0].text);
	assertEqual(server.deleted, [{ path: "[Gmail]/Drafts", uid: DRAFT.uid }]);
	const audit = readAudit().at(-1);
	assertEqual(audit.op, "delete_draft");
	assertEqual(audit.id, DRAFT.emailId);
});

test("email_delete_draft: refuses a message that is not a draft", async () => {
	const server = await useServer();
	const result = await runTool(tool("email_delete_draft"), { id: PLAIN.emailId });
	assert(result.isError, "expected an error");
	assert(result.content[0].text.includes("not in Drafts"), result.content[0].text);
	assertEqual(server.deleted, []);
});

test("audit log: ring buffer keeps the last entries", async () => {
	await useServer();
	const before = readAudit().length;
	for (let i = 0; i < AUDIT_LIMIT + 5; i++) await runTool(tool("email_list_drafts"), {});
	const audit = readAudit();
	assertEqual(audit.length, AUDIT_LIMIT);
	assertEqual(audit.at(-1).op, "list_drafts");
	assert(before <= AUDIT_LIMIT);
});

test("normalizeAppPassword: strips Google's display spaces", () => {
	assertEqual(normalizeAppPassword("abcd efgh ijkl mnop"), "abcdefghijklmnop");
	assertEqual(normalizeAppPassword("abcdefghijklmnop"), "abcdefghijklmnop");
	assertEqual(normalizeAppPassword("  hunter2 with spaces  "), "hunter2 with spaces");
});

test("credentials: a spaced app password reaches IMAP compacted", async () => {
	await useServer();
	process.env.RBW_STUB_PASSWORD = "abcd efgh ijkl mnop";
	await resetState();
	try {
		const result = await runTool(tool("email_list_drafts"), {});
		assert(!result.isError, result.content[0].text);
		assertEqual(lastAuth, { user: "denis@example.com", pass: "abcdefghijklmnop" });
	} finally {
		delete process.env.RBW_STUB_PASSWORD;
		await resetState();
	}
});

test("timestamps are marked UTC", async () => {
	await useServer();
	const result = await runTool(tool("email_search"), { query: "invoice" });
	assert(result.content[0].text.includes("2026-09-20 10:00 UTC"), result.content[0].text);
});

// ── live tests ────────────────────────────────────────────────────────────

if (process.env.GMAIL_LIVE) {
	// The mocked tests run with a fake IMAP server, a stub rbw and a temp
	// config; the live tests swap all three back inside the test body so the
	// harness tests keep their isolation.
	const goLive = async () => {
		setImapFactory((options) => new ImapFlow(options));
		delete process.env.GMAIL_CONFIG;
		delete process.env.PI_SECURITY_CONFIG;
		await resetState();
	};

	liveTest("live: search + read + drafts", async () => {
		await goLive();
		const search = await runTool(tool("email_search"), { query: "in:anywhere newer_than:60d", limit: 3 });
		assert(!search.isError, search.content[0].text);
		console.log(`    search: ${search.content[0].text.split("\n")[0]}`);
		const id = search.content[0].text.match(/id: (\d+)/)?.[1];
		if (id) {
			const read = await runTool(tool("email_get_message"), { id });
			assert(!read.isError, read.content[0].text);
			console.log(`    read: ${read.details.subject} (${read.details.chars} chars, ${read.details.attachmentCount} attachments)`);
		}
		const drafts = await runTool(tool("email_list_drafts"), { limit: 5 });
		assert(!drafts.isError, drafts.content[0].text);
		console.log(`    drafts: ${drafts.details.count}`);
	});

	if (process.env.GMAIL_LIVE_WRITE === "1") {
		liveTest("live: draft create → update → delete", async () => {
			await goLive();
			const created = await runTool(tool("email_create_draft"), {
				to: "sudakov.denis.2007@gmail.com",
				subject: "pi harness test",
				body: "Created by the gmail harness.",
			});
			assert(!created.isError, created.content[0].text);
			const updated = await runTool(tool("email_update_draft"), { id: created.details.id, body: "Updated by the gmail harness." });
			assert(!updated.isError, updated.content[0].text);
			const deleted = await runTool(tool("email_delete_draft"), { id: updated.details.id });
			assert(!deleted.isError, deleted.content[0].text);
		});
	}
}

// ── main ──────────────────────────────────────────────────────────────────

for (const { name, fn } of [...tests, ...liveTests]) {
	try {
		await fn();
		passed++;
		console.log(`ok   ${name}`);
	} catch (err) {
		failed++;
		console.log(`FAIL ${name}\n     ${(err instanceof Error ? err.stack : String(err)).split("\n").slice(0, 4).join("\n     ")}`);
	}
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
if (!process.env.KEEP_TMP) rmSync(TMP, { recursive: true, force: true });
