/**
 * gmail/guard — the read-only/drafts-only boundary, and the audit log.
 *
 * Gmail app passwords have full mailbox scope; there is no read-only variant.
 * The restriction therefore lives in this file: every IMAP command the tools
 * issue goes through these wrappers, and they refuse anything outside the
 * allowlist. What is impossible by construction:
 *
 *   - sending: there is no SMTP client in this extension at all
 *   - deleting real mail: EXPUNGE/STORE \Deleted are only reachable through
 *     `assertDraftMailbox`, which accepts the Drafts mailbox and nothing else
 *   - writing anywhere but Drafts: `assertAppendTarget` accepts Drafts only
 *   - touching unknown mailboxes: `mailboxPath` resolves from a fixed map
 *
 * Every tool call is appended to a JSONL audit log (ring buffer, last
 * AUDIT_LIMIT entries) so the human can see what the agent did, after the fact.
 */
import type { GmailConfig } from "./config.ts";
import { createAuditLog } from "../../lib/audit.ts";

export const AUDIT_LIMIT = 100;

/** Logical mailbox → IMAP path. Gmail's paths are localized, so the client
 *  resolves these through the server's SPECIAL-USE flags at connect time and
 *  only falls back to these English names. */
export const MAILBOX_FALLBACK = {
	inbox: "INBOX",
	all: "[Gmail]/All Mail",
	sent: "[Gmail]/Sent Mail",
	drafts: "[Gmail]/Drafts",
	spam: "[Gmail]/Spam",
	trash: "[Gmail]/Trash",
} as const;

export type MailboxKey = keyof typeof MAILBOX_FALLBACK;
export const MAILBOX_KEYS = Object.keys(MAILBOX_FALLBACK) as MailboxKey[];

/** SPECIAL-USE flag → logical key (RFC 6154). */
export const SPECIAL_USE: Record<string, MailboxKey> = {
	"\\inbox": "inbox",
	"\\all": "all",
	"\\sent": "sent",
	"\\drafts": "drafts",
	"\\junk": "spam",
	"\\trash": "trash",
};

export function isMailboxKey(value: string): value is MailboxKey {
	return Object.hasOwn(MAILBOX_FALLBACK, value);
}

export interface AuditEntry {
	op: string;
	[key: string]: unknown;
}

/**
 * Append one entry to the audit log, trimming the file to the last
 * AUDIT_LIMIT lines. Failures never break the tool call — the log is
 * diagnostics, not a transaction — but they are reported on stderr.
 */
export function audit(config: GmailConfig, entry: AuditEntry): void {
	createAuditLog(config.auditLog, AUDIT_LIMIT).write(entry);
}

/** Last `limit` audit entries, newest last. */
export function auditTail(config: GmailConfig, limit = AUDIT_LIMIT): AuditEntry[] {
	return createAuditLog(config.auditLog, AUDIT_LIMIT).tail(limit) as AuditEntry[];
}
