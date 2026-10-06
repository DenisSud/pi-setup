/**
 * gmail/mime — turn an IMAP body structure into readable text.
 *
 * Scope: what the tools need, nothing more. Transfer decoding (base64,
 * quoted-printable, 7bit/8bit/binary), charset conversion (iconv-lite), and
 * HTML → text (html-to-text). No remote content is ever fetched: images,
 * tracking pixels and stylesheets stay as links in the text.
 */
import { convert } from "html-to-text";
import iconv from "iconv-lite";

export interface BodyNode {
	type?: string;
	parameters?: Record<string, string>;
	encoding?: string;
	size?: number;
	disposition?: string;
	dispositionParameters?: Record<string, string>;
	part?: string;
	childNodes?: BodyNode[];
}

export interface AttachmentInfo {
	/** IMAP part id, pass to email_get_attachment. */
	part: string;
	type: string;
	filename: string;
	size?: number;
}

function parts(node: BodyNode | undefined, out: BodyNode[] = []): BodyNode[] {
	if (!node) return out;
	out.push(node);
	for (const child of node.childNodes ?? []) parts(child, out);
	return out;
}

/** Attachments and inline files (images, PDFs, …), in body order. */
export function attachmentsOf(root: BodyNode | undefined): AttachmentInfo[] {
	const found: AttachmentInfo[] = [];
	for (const node of parts(root)) {
		if (node.childNodes?.length) continue;
		const type = (node.type ?? "").toLowerCase();
		const isText = type.startsWith("text/");
		const isAttachment = node.disposition === "attachment" || (!isText && node.disposition !== "inline");
		if (!isAttachment) continue;
		found.push({
			part: node.part ?? "1",
			type: node.type ?? "application/octet-stream",
			filename: node.dispositionParameters?.filename ?? node.parameters?.name ?? "(unnamed)",
			size: node.size,
		});
	}
	return found;
}

/** Part ids holding the message text: plain preferred, HTML as fallback. */
export function bodyPartsOf(root: BodyNode | undefined): { text?: string; html?: string } {
	let text: string | undefined;
	let html: string | undefined;
	for (const node of parts(root)) {
		if (node.childNodes?.length || node.disposition === "attachment") continue;
		const type = (node.type ?? "").toLowerCase();
		const id = node.part ?? "TEXT";
		if (type === "text/plain" && !text) text = id;
		if (type === "text/html" && !html) html = id;
	}
	return { text, html };
}

/** Charset of the first text part — used to decode fetched part buffers. */
export function charsetOf(root: BodyNode | undefined): string {
	for (const node of parts(root)) {
		const type = (node.type ?? "").toLowerCase();
		if (!type.startsWith("text/") || node.childNodes?.length) continue;
		const charset = node.parameters?.charset;
		if (charset) return charset.replace(/^["']|["']$/g, "").trim();
	}
	return "utf-8";
}

/**
 * Undo the content-transfer-encoding. IMAP returns parts as stored, so base64
 * and quoted-printable arrive still encoded.
 */
export function decodeTransfer(buffer: Buffer, encoding?: string): Buffer {
	const enc = (encoding ?? "7bit").toLowerCase();
	if (enc === "base64") return Buffer.from(buffer.toString("latin1").replace(/\s+/g, ""), "base64");
	if (enc === "quoted-printable") {
		const input = buffer.toString("latin1");
		const out: number[] = [];
		for (let i = 0; i < input.length; i++) {
			const char = input[i];
			if (char === "=") {
				if (input[i + 1] === "\r" && input[i + 2] === "\n") {
					i += 2;
					continue;
				}
				if (input[i + 1] === "\n") {
					i += 1;
					continue;
				}
				const hex = input.slice(i + 1, i + 3);
				if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
					out.push(Number.parseInt(hex, 16));
					i += 2;
					continue;
				}
			}
			out.push(char.charCodeAt(0) & 0xff);
		}
		return Buffer.from(out);
	}
	return buffer;
}

/** Bytes → string, honouring the part charset (unknown charsets fall back to UTF-8). */
export function decodeText(buffer: Buffer, charset?: string): string {
	const name = (charset ?? "utf-8").toLowerCase();
	if (name === "utf-8" || name === "utf8" || name === "us-ascii" || name === "ascii") {
		return buffer.toString("utf8");
	}
	try {
		return iconv.decode(buffer, name);
	} catch {
		return buffer.toString("utf8");
	}
}

export function htmlToText(html: string): string {
	const text = convert(html, {
		wordwrap: false,
		selectors: [
			{ selector: "img", format: "skip" },
			{ selector: "a", options: { hideLinkHrefIfSameAsText: true } },
		],
	});
	return text.replace(/\n{3,}/g, "\n\n").trim();
}

/** RFC 2047 header encoding for non-ASCII header values. */
export function encodeHeader(value: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: header values must stay 7-bit
	if (/^[\x20-\x7e]*$/.test(value)) return value;
	return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}
