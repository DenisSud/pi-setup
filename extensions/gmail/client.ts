/**
 * gmail/client — the IMAP side: connection, id resolution, message reads and
 * the drafts lifecycle.
 *
 * Deliberate properties:
 *   - one IMAP connection per pi process, opened lazily, no IDLE
 *   - message ids are Gmail's X-GM-MSGID (stable across folders and moves);
 *     thread ids are X-GM-THRID. ImapFlow maps both onto `emailId`/`threadId`.
 *   - every write goes through guard.ts (Drafts only)
 *   - credentials come from the security extension's secrets profiles, resolved
 *     at connect time and cached in memory only
 *
 * The IMAP client is created through `setImapFactory` so tests can drive the
 * tools against a fake server; production always uses the real ImapFlow.
 */
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { ImapFlow } from "imapflow";
import { loadConfig as loadSecurityConfig } from "../security/config.ts";
import { resolveProfile } from "../security/rbw.ts";
import type { GmailConfig } from "./config.ts";
import { loadConfig } from "./config.ts";
import { audit, type MailboxKey, MAILBOX_FALLBACK, SPECIAL_USE } from "./guard.ts";
import {
	type AttachmentInfo,
	attachmentsOf,
	type BodyNode,
	bodyPartsOf,
	charsetOf,
	decodeText,
	decodeTransfer,
	encodeHeader,
	htmlToText,
} from "./mime.ts";

// ── IMAP surface (subset of ImapFlow that this extension uses) ─────────────

export interface MailboxLock {
	release(): void;
}

export interface ImapEnvelope {
	subject?: string;
	date?: Date;
	messageId?: string;
	inReplyTo?: string;
	from?: { name?: string; address?: string }[];
	to?: { name?: string; address?: string }[];
	cc?: { name?: string; address?: string }[];
}

export interface ImapMessage {
	uid: number;
	seq: number;
	emailId?: string;
	threadId?: string;
	flags?: Set<string>;
	labels?: Set<string>;
	envelope?: ImapEnvelope;
	bodyStructure?: BodyNode;
	bodyParts?: Map<string, Buffer>;
	internalDate?: Date;
	size?: number;
}

export interface ImapClientLike {
	usable?: boolean;
	connect(): Promise<void>;
	logout(): Promise<void>;
	list(): Promise<{ path: string; specialUse?: string }[]>;
	getMailboxLock(path: string): Promise<MailboxLock>;
	search(query: unknown, options: { uid: true }): Promise<number[]>;
	fetchAll(range: unknown, query: unknown, options?: { uid?: boolean }): Promise<ImapMessage[]>;
	fetchOne(range: unknown, query: unknown, options?: { uid?: boolean }): Promise<ImapMessage | false>;
	append(path: string, content: string | Buffer, flags?: string[], date?: Date): Promise<{ uid?: number } | undefined>;
	messageDelete(range: unknown, options: { uid: true }): Promise<boolean>;
	download(
		range: unknown,
		part: string,
		options: { uid: true },
	): Promise<{ meta: { contentType?: string; filename?: string; encoding?: string; expectedSize?: number }; content: AsyncIterable<Buffer> }>;
	on(event: string, handler: (err: Error) => void): void;
	close(): void;
}

export type ImapFactory = (options: Record<string, unknown>) => ImapClientLike;

let imapFactory: ImapFactory = (options) => new ImapFlow(options) as unknown as ImapClientLike;

/** Test seam: swap the IMAP implementation (see test/harness.mjs). */
export function setImapFactory(factory: ImapFactory): void {
	imapFactory = factory;
}

/** Test seam: forget cached config, credentials and connection. */
export async function resetState(): Promise<void> {
	await closeClient();
	state().config = undefined;
	state().credentials = undefined;
}

// ── process-wide state ────────────────────────────────────────────────────
// pi loads extensions in isolated module instances; a module-level cache would
// be re-created (and the old connection leaked) on /reload. One process-wide
// store.

const STATE_KEY = Symbol.for("pi-personal.gmail.state");

interface IndexedMessage {
	mailbox: MailboxKey;
	uid: number;
}

interface State {
	config?: GmailConfig;
	client?: ImapClientLike;
	connecting?: Promise<ImapClientLike>;
	credentials?: { user: string; pass: string };
	mailboxes?: Record<MailboxKey, string>;
	/** X-GM-MSGID → where it was seen, so repeat reads skip a search. */
	index: Map<string, IndexedMessage>;
}

function state(): State {
	const host = globalThis as typeof globalThis & { [STATE_KEY]?: State };
	return (host[STATE_KEY] ??= { index: new Map() });
}

export function gmailConfig(): GmailConfig {
	const current = state();
	current.config ??= loadConfig();
	return current.config;
}

/**
 * Google displays app passwords as four space-separated groups
 * (`abcd efgh ijkl mnop`). The spaces are display sugar, not part of the
 * secret, and pasting them into the vault is the obvious mistake — drop them
 * when that's exactly the shape (16 alphanumerics). Anything else passes
 * through trimmed, so a real password is never silently mangled.
 */
export function normalizeAppPassword(raw: string): string {
	const compact = raw.replace(/\s+/g, "");
	return /^[a-z0-9]{16}$/i.test(compact) ? compact : raw.trim();
}

async function credentials(config: GmailConfig): Promise<{ user: string; pass: string }> {
	const current = state();
	if (current.credentials) return current.credentials;
	let env: Record<string, string>;
	try {
		env = await resolveProfile(loadSecurityConfig(), config.secretProfile);
	} catch (err) {
		throw new Error(
			`gmail: cannot read secrets profile "${config.secretProfile}": ${(err as Error).message}. ` +
				`Add the profile to ~/.pi/agent/security.json and run \`rbw unlock\`.`,
		);
	}
	const raw = env.GMAIL_APP_PASSWORD ?? env.PASSWORD ?? Object.values(env)[0];
	if (!raw) throw new Error(`gmail: secrets profile "${config.secretProfile}" resolved no password (expected GMAIL_APP_PASSWORD)`);
	current.credentials = { user: config.username, pass: normalizeAppPassword(raw) };
	return current.credentials;
}

function resetConnection(current: State, reason: string): void {
	if (current.client) {
		try {
			current.client.close();
		} catch {
			// already gone
		}
	}
	current.client = undefined;
	current.connecting = undefined;
	current.mailboxes = undefined;
	current.index.clear();
	process.stderr.write(`gmail: imap connection reset (${reason})\n`);
}

/** Lazily connected, shared IMAP client. */
export async function getClient(): Promise<ImapClientLike> {
	const current = state();
	const config = gmailConfig();
	if (current.client?.usable) return current.client;
	if (current.connecting) return current.connecting;

	current.connecting = (async () => {
		const auth = await credentials(config);
		const client = imapFactory({
			host: config.host,
			port: config.port,
			secure: true,
			auth,
			logger: false,
			disableAutoIdle: true,
			socketTimeout: 120_000,
			tls: { minVersion: "TLSv1.2" },
		});
		client.on("error", (err) => resetConnection(current, err.message));
		client.on("close", () => {
			if (current.client === client) resetConnection(current, "closed by server");
		});
		await client.connect();
		current.client = client;
		return client;
	})();

	try {
		return await current.connecting;
	} catch (err) {
		current.connecting = undefined;
		// A failed login usually means a stale cached password (rotated app
		// password) — drop it so the next call re-reads the vault.
		current.credentials = undefined;
		const failure = err as { message?: string; responseText?: string; serverResponseCode?: string; authenticationFailed?: boolean };
		const detail = failure.responseText ?? failure.serverResponseCode ?? failure.message ?? String(err);
		if (failure.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials/i.test(detail)) {
			throw new Error(
				`gmail: Gmail rejected the app password for ${config.username} (${detail.trim()}). ` +
					"App passwords stop working when the Google account password changes or 2FA is reset: create a new one " +
					"(Google Account → Security → 2-Step Verification → App passwords) and update the Bitwarden item `pi/Google-app-password`.",
			);
		}
		throw err;
	}
}

export async function closeClient(): Promise<void> {
	const current = state();
	const client = current.client;
	if (!client) return;
	resetConnection(current, "shutdown");
	try {
		await client.logout();
	} catch {
		// closing a dead connection is fine
	}
}

/** Logical mailbox → server path, from SPECIAL-USE flags (Gmail localizes
 *  folder names), falling back to the English Gmail names. */
export async function mailboxPaths(): Promise<Record<MailboxKey, string>> {
	const current = state();
	if (current.mailboxes) return current.mailboxes;
	const client = await getClient();
	const found = { ...MAILBOX_FALLBACK };
	for (const box of await client.list()) {
		const key = box.specialUse ? SPECIAL_USE[box.specialUse.toLowerCase()] : box.path === "INBOX" ? "inbox" : undefined;
		if (key) found[key] = box.path;
	}
	current.mailboxes = found;
	return found;
}

/** Run `fn` with `mailbox` selected. The lock is released even on throw. */
export async function withMailbox<T>(mailbox: MailboxKey, fn: (client: ImapClientLike, path: string) => Promise<T>): Promise<T> {
	const client = await getClient();
	const path = (await mailboxPaths())[mailbox];
	const lock = await client.getMailboxLock(path);
	try {
		return await fn(client, path);
	} finally {
		lock.release();
	}
}

// ── message lookup ────────────────────────────────────────────────────────

function remember(message: ImapMessage, mailbox: MailboxKey): void {
	if (!message.emailId) return;
	state().index.set(String(message.emailId), { mailbox, uid: message.uid });
}

export interface LocatedMessage {
	message: ImapMessage;
	mailbox: MailboxKey;
	path: string;
}

/**
 * Find a message by X-GM-MSGID. Cached from earlier searches first; otherwise
 * a server-side X-GM-MSGID search, All Mail before the other mailboxes
 * (All Mail covers every folder except Spam and Trash).
 */
export async function locate(id: string): Promise<LocatedMessage> {
	const current = state();
	const known = current.index.get(id);
	const all: MailboxKey[] = ["all", "inbox", "sent", "drafts", "spam", "trash"];
	// The cached mailbox is tried first, but a stale uid (a replaced draft)
	// must not end the search.
	const order = known ? [known.mailbox, ...all.filter((key) => key !== known.mailbox)] : all;

	for (const mailbox of order) {
		const found = await withMailbox(mailbox, async (client, path) => {
			const uids = await client.search({ emailId: id }, { uid: true });
			if (!uids.length) return undefined;
			const message = await client.fetchOne(uids[uids.length - 1], { envelope: true, flags: true, threadId: true }, { uid: true });
			return message || undefined;
		});
		if (found) {
			remember(found, mailbox);
			return { message: found, mailbox, path: (await mailboxPaths())[mailbox] };
		}
	}
	throw new Error(
		`gmail: no message with id ${id} (ids are Gmail X-GM-MSGID values from email_search; they are not IMAP UIDs)`,
	);
}

/** Fetch full body + headers for a message id. */
export async function readMessage(id: string): Promise<{ located: LocatedMessage; text: string; attachments: AttachmentInfo[]; truncated: boolean }> {
	const config = gmailConfig();
	const { message, mailbox, path } = await locate(id);
	const detail = await withMailbox(mailbox, async (client) => {
		const full = await client.fetchOne(message.uid, { bodyStructure: true, envelope: true, labels: true, threadId: true, flags: true }, { uid: true });
		if (!full?.bodyStructure) return undefined;
		const wanted = bodyPartsOf(full.bodyStructure);
		const partIds = [wanted.text, wanted.html].filter((part): part is string => Boolean(part));
		if (!partIds.length) return { full, parts: new Map<string, Buffer>() };
		const withParts = await client.fetchOne(message.uid, { bodyParts: partIds, bodyStructure: true, envelope: true, labels: true, threadId: true, flags: true }, { uid: true });
		return { full: withParts || full, parts: (withParts || full).bodyParts ?? new Map<string, Buffer>() };
	});
	if (!detail) throw new Error(`gmail: message ${id} has no readable MIME structure`);

	const structure = detail.full.bodyStructure;
	const wanted = bodyPartsOf(structure);
	const charset = charsetOf(structure);
	const decode = (partId: string | undefined, html: boolean): string => {
		if (!partId) return "";
		const raw = detail.parts.get(partId);
		if (!raw) return "";
		const text = decodeText(decodeTransfer(raw, partEncoding(structure, partId)), charset);
		return html ? htmlToText(text) : text;
	};
	let text = decode(wanted.text, false);
	if (!text.trim() && wanted.html) text = decode(wanted.html, true);
	text = text.replace(/\r\n/g, "\n").trim();

	const truncated = text.length > config.maxBodyChars;
	return {
		located: { message: detail.full, mailbox, path },
		text: truncated ? `${text.slice(0, config.maxBodyChars)}\n\n[... truncated, ${text.length} chars total]` : text,
		attachments: attachmentsOf(structure),
		truncated,
	};
}

function partEncoding(root: BodyNode | undefined, partId: string): string | undefined {
	const stack = [root];
	while (stack.length) {
		const node = stack.pop();
		if (!node) continue;
		if ((node.part ?? "TEXT") === partId) return node.encoding;
		stack.push(...(node.childNodes ?? []));
	}
	return undefined;
}

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** Download one attachment part to `attachmentDir`; returns the written path. */
export async function saveAttachment(id: string, part: string): Promise<{ path: string; type: string; size: number }> {
	const config = gmailConfig();
	const { message, mailbox } = await locate(id);
	return withMailbox(mailbox, async (client) => {
		const { meta, content } = await client.download(message.uid, part, { uid: true });
		const name = safeFilename(meta.filename || `attachment-${part}`);
		// IMAP streams the part as stored, so base64/quoted-printable still has
		// to be undone before the bytes hit the file.
		const chunks: Buffer[] = [];
		let total = 0;
		for await (const chunk of content) {
			total += chunk.length;
			if (total > MAX_ATTACHMENT_BYTES) {
				throw new Error(`gmail: attachment ${name} exceeds ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB — refusing to buffer it in memory`);
			}
			chunks.push(chunk as Buffer);
		}
		const decoded = decodeTransfer(Buffer.concat(chunks), meta.encoding);
		await mkdir(config.attachmentDir, { recursive: true });
		const target = freePath(join(config.attachmentDir, name));
		const temp = `${target}.part`;
		await writeFile(temp, decoded);
		await rename(temp, target);
		return { path: target, type: meta.contentType ?? "application/octet-stream", size: decoded.length };
	});
}

function safeFilename(name: string): string {
	const cleaned = basename(name)
		.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_")
		.trim();
	return (cleaned || "attachment").slice(0, 120);
}

function freePath(path: string): string {
	if (!existsSync(path)) return path;
	const ext = extname(path);
	const base = path.slice(0, path.length - ext.length);
	for (let n = 2; n < 100; n++) {
		const candidate = `${base} (${n})${ext}`;
		if (!existsSync(candidate)) return candidate;
	}
	throw new Error(`gmail: cannot find a free filename for ${path}`);
}

// ── search ────────────────────────────────────────────────────────────────

/**
 * Gmail search (X-GM-RAW), newest first, envelope only.
 *
 * No cursor: Gmail's own date operators (`before:`/`after:`) are the paging
 * mechanism — one less piece of state to keep consistent across sessions.
 */
export async function searchMessages(query: string, mailbox: MailboxKey, limit: number): Promise<ImapMessage[]> {
	return withMailbox(mailbox, async (client) => {
		const uids = await client.search({ gmraw: query }, { uid: true });
		const newest = uids.sort((a, b) => b - a).slice(0, limit);
		if (!newest.length) return [];
		const messages = await client.fetchAll(newest, { envelope: true, flags: true, threadId: true }, { uid: true });
		for (const message of messages) remember(message, mailbox);
		return messages.sort((a, b) => b.uid - a.uid);
	});
}

/** Every message of one thread (X-GM-THRID), oldest first. */
export async function threadMessages(threadId: string, limit: number): Promise<ImapMessage[]> {
	return withMailbox("all", async (client) => {
		const uids = await client.search({ threadId }, { uid: true });
		const newest = uids.sort((a, b) => b - a).slice(0, limit);
		if (!newest.length) return [];
		const messages = await client.fetchAll(newest, { envelope: true, flags: true, threadId: true }, { uid: true });
		for (const message of messages) remember(message, "all");
		return messages.sort((a, b) => b.uid - a.uid);
	});
}

// ── drafts ────────────────────────────────────────────────────────────────

export interface DraftFields {
	to: string;
	subject: string;
	body: string;
	cc?: string;
	bcc?: string;
	inReplyTo?: string;
}

function buildMessage(config: GmailConfig, fields: DraftFields): string {
	const headers = [`From: ${config.username}`, `To: ${fields.to}`];
	if (fields.cc) headers.push(`Cc: ${fields.cc}`);
	if (fields.bcc) headers.push(`Bcc: ${fields.bcc}`);
	headers.push(`Subject: ${encodeHeader(fields.subject)}`);
	if (fields.inReplyTo) {
		headers.push(`In-Reply-To: ${fields.inReplyTo}`, `References: ${fields.inReplyTo}`);
	}
	headers.push("MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit");
	// Drafts are stored with CRLF line endings, like any other RFC 5322 message.
	const body = fields.body.replace(/\r?\n/g, "\r\n");
	return `${headers.join("\r\n")}\r\n\r\n${body}\r\n`;
}

/** Append a draft and return its message id (X-GM-MSGID) + thread id. */
export async function createDraft(fields: DraftFields): Promise<{ id: string; threadId?: string; uid: number }> {
	const config = gmailConfig();
	const message = buildMessage(config, fields);
	const result = await withMailbox("drafts", async (client, path) => {
		const appended = await client.append(path, message, ["\\Draft"], new Date());
		let uid = appended?.uid;
		if (!uid) {
			// No UIDPLUS answer: the newest draft is the one we just wrote.
			const uids = await client.search({ all: true }, { uid: true });
			uid = uids.length ? uids[uids.length - 1] : undefined;
		}
		if (!uid) throw new Error("gmail: draft was appended but the server returned no UID");
		const stored = await client.fetchOne(uid, { envelope: true, threadId: true }, { uid: true });
		return { uid, stored: stored || undefined };
	});
	audit(config, { op: "create_draft", to: fields.to, subject: fields.subject, id: result.stored?.emailId, uid: result.uid });
	if (!result.stored?.emailId) throw new Error("gmail: draft created but its message id could not be read back");
	state().index.set(String(result.stored.emailId), { mailbox: "drafts", uid: result.uid });
	return { id: String(result.stored.emailId), threadId: result.stored.threadId, uid: result.uid };
}

export async function listDrafts(limit: number): Promise<ImapMessage[]> {
	return withMailbox("drafts", async (client) => {
		const uids = await client.search({ all: true }, { uid: true });
		const newest = uids.sort((a, b) => b - a).slice(0, limit);
		if (!newest.length) return [];
		const messages = await client.fetchAll(newest, { envelope: true, flags: true, threadId: true }, { uid: true });
		for (const message of messages) remember(message, "drafts");
		return messages.sort((a, b) => b.uid - a.uid);
	});
}

/** Delete a draft (the only delete this extension can do — Drafts only). */
export async function deleteDraft(id: string): Promise<{ uid: number; subject?: string }> {
	const config = gmailConfig();
	const found = await withMailbox("drafts", async (client) => {
		const uids = await client.search({ emailId: id }, { uid: true });
		if (!uids.length) return undefined;
		const uid = uids[uids.length - 1];
		const message = await client.fetchOne(uid, { envelope: true }, { uid: true });
		return { uid, subject: message ? message.envelope?.subject : undefined };
	});
	if (!found) throw new Error(`gmail: message ${id} is not in Drafts — refusing to delete anything else`);
	await withMailbox("drafts", async (client) => {
		await client.messageDelete(found.uid, { uid: true });
	});
	audit(config, { op: "delete_draft", id, uid: found.uid, subject: found.subject });
	state().index.delete(id);
	return { uid: found.uid, subject: found.subject };
}

/** Replace a draft: append the merged version, then delete the old one. */
export async function updateDraft(id: string, changes: Partial<DraftFields>): Promise<{ id: string; uid: number; previousUid: number }> {
	const { message, mailbox } = await locate(id);
	if (mailbox !== "drafts") throw new Error(`gmail: message ${id} is not a draft (found in ${mailbox}) — drafts are the only writable messages`);

	const current = await readMessage(id);
	const address = (list?: { name?: string; address?: string }[]): string =>
		(list ?? []).map((entry) => (entry.name ? `${entry.name} <${entry.address}>` : entry.address ?? "")).filter(Boolean).join(", ");

	const fields: DraftFields = {
		to: changes.to ?? address(current.located.message.envelope?.to),
		subject: changes.subject ?? current.located.message.envelope?.subject ?? "",
		body: changes.body ?? current.text,
		cc: (changes.cc ?? address(current.located.message.envelope?.cc)) || undefined,
		bcc: changes.bcc,
		inReplyTo: changes.inReplyTo ?? current.located.message.envelope?.inReplyTo,
	};
	if (!fields.to) throw new Error(`gmail: draft ${id} has no recipient; pass "to"`);

	const created = await createDraft(fields);
	await deleteDraft(id);
	return { id: created.id, uid: created.uid, previousUid: current.located.message.uid };
}

/** Fetch an attachment part id → metadata, for the attachment listing. */
export async function attachmentList(id: string): Promise<AttachmentInfo[]> {
	const { located } = await readMessage(id);
	return attachmentsOf(located.message.bodyStructure);
}
