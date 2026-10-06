/**
 * gmail — read-and-draft email tools for pi, over Gmail IMAP (no OAuth).
 *
 * Eight tools, one per operation: search, read a message, read a thread,
 * download an attachment, and the draft lifecycle. There is deliberately no
 * send tool and no way to delete received mail — see guard.ts for the
 * boundary and the audit log.
 *
 * Message ids are Gmail's X-GM-MSGID (stable when a message moves between
 * folders); thread ids are X-GM-THRID.
 */
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	attachmentList,
	closeClient,
	createDraft,
	deleteDraft,
	type ImapMessage,
	gmailConfig,
	listDrafts,
	readMessage,
	saveAttachment,
	searchMessages,
	threadMessages,
	updateDraft,
} from "./client.ts";
import { audit, MAILBOX_KEYS } from "./guard.ts";

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function address(list?: { name?: string; address?: string }[]): string {
	const rendered = (list ?? [])
		.map((entry) => (entry.name ? `${entry.name} <${entry.address ?? ""}>` : entry.address ?? ""))
		.filter(Boolean);
	return rendered.length ? rendered.join(", ") : "(none)";
}

/** Timestamps are UTC instants; the zone marker is explicit so a reader never
 * mistakes them for local time ("14:10" in Moscow is 17:10). */
function stamp(date?: Date): string {
	if (!date) return "(no date)";
	return `${new Date(date).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

/** One compact block per message: what it is, and the ids needed to read it. */
function formatEnvelope(message: ImapMessage): string {
	const flags = message.flags ?? new Set<string>();
	const marks = [flags.has("\\Seen") ? "" : "unread", flags.has("\\Flagged") ? "flagged" : ""].filter(Boolean).join(", ");
	const lines = [
		`[${message.uid}] ${stamp(message.envelope?.date)} — ${address(message.envelope?.from)}`,
		`    ${message.envelope?.subject || "(no subject)"}`,
		`    id: ${message.emailId ?? "?"}  thread: ${message.threadId ?? "?"}${marks ? `  (${marks})` : ""}`,
	];
	return lines.join("\n");
}

/** Shared renderers — the eight tools differ only in their summary line. */
function renderer(title: string, summarize: (details: Record<string, unknown>) => string) {
	return {
		renderCall(args: Record<string, unknown>, theme: { fg: (color: string, text: string) => string; bold: (text: string) => string }, context: { lastComponent?: unknown }) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const detail = Object.entries(args)
				.filter(([, value]) => value !== undefined)
				.map(([key, value]) => `${key}=${truncate(String(value), 60)}`)
				.join(" ");
			text.setText(theme.fg("toolTitle", theme.bold(`${title} `)) + theme.fg("dim", detail));
			return text;
		},
		renderResult(
			result: { content: { type: string; text?: string }[]; details?: unknown },
			options: { expanded: boolean; isPartial: boolean },
			theme: { fg: (color: string, text: string) => string; bold: (text: string) => string },
			context: { lastComponent?: unknown; isError?: boolean },
		) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			if (options.isPartial) {
				text.setText(theme.fg("warning", `${title}…`));
				return text;
			}
			if (context.isError) {
				const body = result.content[0]?.type === "text" ? result.content[0].text ?? "" : `${title} failed`;
				text.setText(theme.fg("error", truncate(body, 500)));
				return text;
			}
			const details = (result.details ?? {}) as Record<string, unknown>;
			let content = theme.fg("success", "✓ ") + theme.fg("toolTitle", summarize(details));
			if (options.expanded) content += `\n${theme.fg("dim", truncate(result.content[0]?.text ?? "", 2000))}`;
			text.setText(content);
			return text;
		},
	};
}

const MAILBOX_PARAM = Type.Optional(
	Type.Union(
		MAILBOX_KEYS.map((key) => Type.Literal(key)),
		{
			description:
				"Which mailbox to search: all (default, All Mail), inbox, sent, drafts, spam, trash. All Mail excludes Spam and Trash.",
		},
	),
);

export default function gmailExtension(pi: ExtensionAPI): void {
	pi.on("session_shutdown", async () => {
		await closeClient();
	});

	pi.registerTool({
		name: "email_search",
		label: "Email Search",
		description:
			"Search Gmail with Gmail's own search syntax (from:, to:, subject:, is:unread, has:attachment, newer_than:7d, in:inbox, label:…). Searches All Mail by default, newest first, envelope only — no bodies. Page with date operators (before:2026/09/01) instead of a cursor. Returns ids for email_get_message.",
		parameters: Type.Object({
			query: Type.String({ description: "Gmail search query, e.g. \"from:alice subject:invoice newer_than:30d\"" }),
			mailbox: MAILBOX_PARAM,
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Max results (default 20)" })),
		}),
		...renderer("Email Search", (details) => `${details.count ?? 0} message(s)`),
		async execute(_toolCallId, params) {
			const limit = Math.min(100, Math.max(1, Math.round(params.limit ?? 20)));
			const mailbox = params.mailbox ?? "all";
			const messages = await searchMessages(params.query, mailbox, limit);
			audit(gmailConfig(), { op: "search", query: params.query, mailbox, limit, count: messages.length });
			const body = messages.length
				? messages.map(formatEnvelope).join("\n\n")
				: `No messages match ${JSON.stringify(params.query)} in ${mailbox}.`;
			return {
				content: [{ type: "text" as const, text: body }],
				details: { count: messages.length, query: params.query, mailbox },
			};
		},
	});

	pi.registerTool({
		name: "email_get_message",
		label: "Email Read",
		description:
			"Read one email: headers, decoded text body (plain preferred, HTML converted to text) and attachment metadata. Pass the id from email_search. Bodies are capped at 20k characters (the truncated flag says so). No remote content is fetched; use email_get_attachment to download a file.",
		parameters: Type.Object({
			id: Type.String({ description: "Message id (X-GM-MSGID) from email_search" }),
		}),
		...renderer("Email Read", (details) => String(details.subject ?? "message")),
		async execute(_toolCallId, params) {
			const config = gmailConfig();
			const { located, text, attachments, truncated } = await readMessage(params.id);
			audit(config, { op: "get_message", id: params.id, mailbox: located.mailbox, subject: located.message.envelope?.subject });
			const envelope = located.message.envelope;
			const labels = located.message.labels ? [...located.message.labels].join(", ") : "";
			const header = [
				`From: ${address(envelope?.from)}`,
				`To: ${address(envelope?.to)}`,
				envelope?.cc?.length ? `Cc: ${address(envelope.cc)}` : "",
				`Subject: ${envelope?.subject ?? ""}`,
				`Date: ${stamp(envelope?.date)}`,
				`Folder: ${located.mailbox}${labels ? `  Labels: ${labels}` : ""}`,
				`Message-ID: ${envelope?.messageId ?? "?"}`,
				envelope?.inReplyTo ? `In-Reply-To: ${envelope.inReplyTo}` : "",
				`id: ${params.id}  thread: ${located.message.threadId ?? "?"}`,
				attachments.length
					? `Attachments:\n${attachments
							.map((file) => `  part ${file.part}: ${file.filename} (${file.type}${file.size ? `, ${Math.round(file.size / 1024)} KB` : ""})`)
							.join("\n")}`
					: "",
				"",
				"--- body ---",
			]
				.filter((line) => line !== "")
				.join("\n");
			return {
				content: [{ type: "text" as const, text: `${header}\n${text || "(no text body)"}` }],
				details: {
					id: params.id,
					subject: envelope?.subject,
					from: address(envelope?.from),
					truncated,
					attachmentCount: attachments.length,
					chars: text.length,
				},
			};
		},
	});

	pi.registerTool({
		name: "email_get_thread",
		label: "Email Thread",
		description:
			"List every message of a Gmail conversation (same thread id), oldest first, envelope only — no bodies. Pass the thread id from email_search and read individual messages with email_get_message.",
		parameters: Type.Object({
			thread_id: Type.String({ description: "Gmail thread id (X-GM-THRID) from email_search" }),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Max messages (default 50)" })),
		}),
		...renderer("Email Thread", (details) => `${details.count ?? 0} message(s) in thread`),
		async execute(_toolCallId, params) {
			const limit = Math.min(100, Math.max(1, Math.round(params.limit ?? 50)));
			const messages = await threadMessages(params.thread_id, limit);
			audit(gmailConfig(), { op: "get_thread", thread_id: params.thread_id, count: messages.length });
			const ordered = [...messages].sort((a, b) => (a.envelope?.date?.getTime() ?? 0) - (b.envelope?.date?.getTime() ?? 0));
			const body = ordered.length ? ordered.map(formatEnvelope).join("\n\n") : `No messages in thread ${params.thread_id}.`;
			return {
				content: [{ type: "text" as const, text: body }],
				details: { count: messages.length, threadId: params.thread_id },
			};
		},
	});

	pi.registerTool({
		name: "email_get_attachment",
		label: "Email Attachment",
		description:
			"Download one attachment from a message to ~/Downloads/email-attachments/ and return its absolute path, MIME type and size. Pass the id from email_search; part is the part number listed by email_get_message (omit it when the message has exactly one attachment). Existing files are never overwritten.",
		parameters: Type.Object({
			id: Type.String({ description: "Message id from email_search" }),
			part: Type.Optional(Type.String({ description: "MIME part number, e.g. \"2\" (from email_get_message)" })),
		}),
		...renderer("Email Attachment", (details) => String(details.path ?? "attachment")),
		async execute(_toolCallId, params) {
			const config = gmailConfig();
			let part = params.part;
			if (!part) {
				const files = await attachmentList(params.id);
				if (!files.length) throw new Error(`gmail: message ${params.id} has no attachments`);
				if (files.length > 1) {
					throw new Error(
						`gmail: message ${params.id} has ${files.length} attachments — pass "part": ${files
							.map((file) => `${file.part} (${file.filename})`)
							.join(", ")}`,
					);
				}
				part = files[0].part;
			}
			const saved = await saveAttachment(params.id, part);
			audit(config, { op: "get_attachment", id: params.id, part, path: saved.path });
			return {
				content: [
					{ type: "text" as const, text: `Saved to ${saved.path}\nType: ${saved.type}\nSize: ${Math.round(saved.size / 1024)} KB` },
				],
				details: { path: saved.path, part, type: saved.type, size: saved.size },
			};
		},
	});

	pi.registerTool({
		name: "email_list_drafts",
		label: "Email Drafts",
		description: "List saved Gmail drafts, newest first, with the ids used by email_update_draft and email_delete_draft.",
		parameters: Type.Object({
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Max drafts (default 20)" })),
		}),
		...renderer("Email Drafts", (details) => `${details.count ?? 0} draft(s)`),
		async execute(_toolCallId, params) {
			const limit = Math.min(100, Math.max(1, Math.round(params.limit ?? 20)));
			const drafts = await listDrafts(limit);
			audit(gmailConfig(), { op: "list_drafts", count: drafts.length });
			const body = drafts.length ? drafts.map(formatEnvelope).join("\n\n") : "No drafts.";
			return {
				content: [{ type: "text" as const, text: body }],
				details: { count: drafts.length },
			};
		},
	});

	pi.registerTool({
		name: "email_create_draft",
		label: "Email Draft New",
		description:
			"Create a Gmail draft with a plain-text body. It shows up in Gmail and on the phone right away; sending stays a human action — this tool cannot send mail. Pass in_reply_to (the Message-ID header of the message being answered) to keep the draft in the same conversation. Returns the new draft id.",
		parameters: Type.Object({
			to: Type.String({ description: "Recipient(s), comma separated" }),
			subject: Type.String({ description: "Subject line" }),
			body: Type.String({ description: "Plain-text body" }),
			cc: Type.Optional(Type.String({ description: "Cc recipients, comma separated" })),
			bcc: Type.Optional(Type.String({ description: "Bcc recipients, comma separated" })),
			in_reply_to: Type.Optional(Type.String({ description: "Message-ID being answered (threads the draft)" })),
		}),
		...renderer("Email Draft New", (details) => `draft ${details.id ?? ""}`),
		async execute(_toolCallId, params) {
			const created = await createDraft({
				to: params.to,
				subject: params.subject,
				body: params.body,
				cc: params.cc,
				bcc: params.bcc,
				inReplyTo: params.in_reply_to,
			});
			return {
				content: [
					{
						type: "text" as const,
						text: `Draft created (not sent).\nid: ${created.id}\nthread: ${created.threadId ?? "?"}\nTo: ${params.to}\nSubject: ${params.subject}`,
					},
				],
				details: { id: created.id, uid: created.uid, threadId: created.threadId, to: params.to, subject: params.subject },
			};
		},
	});

	pi.registerTool({
		name: "email_update_draft",
		label: "Email Draft Edit",
		description:
			"Replace an existing draft: fields you pass override the stored ones, the others are kept as they are. Implemented as a new draft plus removal of the old one, so the returned id differs from the input id (update any stored id).",
		parameters: Type.Object({
			id: Type.String({ description: "Draft id from email_list_drafts / email_search" }),
			to: Type.Optional(Type.String({ description: "New recipient(s)" })),
			subject: Type.Optional(Type.String({ description: "New subject" })),
			body: Type.Optional(Type.String({ description: "New plain-text body" })),
			cc: Type.Optional(Type.String({ description: "New Cc list (empty string clears it)" })),
			bcc: Type.Optional(Type.String({ description: "New Bcc list" })),
		}),
		...renderer("Email Draft Edit", (details) => `draft ${details.id ?? ""}`),
		async execute(_toolCallId, params) {
			const updated = await updateDraft(params.id, {
				to: params.to,
				subject: params.subject,
				body: params.body,
				cc: params.cc,
				bcc: params.bcc,
			});
			return {
				content: [{ type: "text" as const, text: `Draft ${params.id} replaced by draft ${updated.id} (old draft removed).` }],
				details: { id: updated.id, uid: updated.uid, previousId: params.id },
			};
		},
	});

	pi.registerTool({
		name: "email_delete_draft",
		label: "Email Draft Delete",
		description:
			"Delete a draft. Drafts are the only messages this agent can delete — received and sent mail are untouchable. The deletion is written to the audit log before it happens.",
		parameters: Type.Object({
			id: Type.String({ description: "Draft id from email_list_drafts" }),
		}),
		...renderer("Email Draft Delete", (details) => `deleted ${details.id ?? ""}`),
		async execute(_toolCallId, params) {
			const deleted = await deleteDraft(params.id);
			return {
				content: [{ type: "text" as const, text: `Draft deleted${deleted.subject ? `: ${deleted.subject}` : ""}.` }],
				details: { id: params.id, uid: deleted.uid, subject: deleted.subject },
			};
		},
	});
}
