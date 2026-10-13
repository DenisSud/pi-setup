/**
 * calendar/caldav — CalDAV over fetch(), against the personal Radicale.
 *
 * Only the five operations the tools expose, with ETag preconditions
 * (`If-None-Match: *` on create, `If-Match` on update/delete) so a concurrent
 * edit from GNOME Calendar or the phone fails loudly instead of being
 * silently overwritten.
 *
 * Time-range listing asks the server to `expand` recurrences, and falls back
 * to unexpanded masters (RRULE pass-through) if the server refuses.
 */
import { randomUUID } from "node:crypto";
import { requireEnvVars } from "../../lib/credentials.ts";
import { createAuditLog } from "../../lib/audit.ts";
import { type CalendarConfig, loadConfig } from "./config.ts";
import { buildEvent, caldavStamp, parseEvents, parseInstant, toDateOnly, unfoldLines } from "./ics.ts";
import type { CalendarEvent, EventInput } from "./types.ts";

const REPORT_NS = 'xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"';
const REQUEST_TIMEOUT_MS = 20_000;

interface State {
	config?: CalendarConfig;
	auth?: string;
}

const STATE_KEY = Symbol.for("pi-personal.calendar.state");

function state(): State {
	const host = globalThis as typeof globalThis & { [STATE_KEY]?: State };
	return (host[STATE_KEY] ??= {});
}

export function calendarConfig(): CalendarConfig {
	const current = state();
	current.config ??= loadConfig();
	return current.config;
}

export function auditLog(config: CalendarConfig = calendarConfig()) {
	return createAuditLog(config.auditLog);
}

async function authorization(): Promise<string> {
	const current = state();
	if (current.auth) return current.auth;
	const config = calendarConfig();
	const env = requireEnvVars([config.userVar, config.passwordVar], "calendar");
	current.auth = `Basic ${Buffer.from(`${env[config.userVar]}:${env[config.passwordVar]}`).toString("base64")}`;
	return current.auth;
}

function eventUrl(config: CalendarConfig, uid: string): string {
	return `${config.baseUrl}${config.collection}${encodeURIComponent(uid)}.ics`;
}

async function request(method: string, url: string, options: { body?: string; headers?: Record<string, string> } = {}): Promise<Response> {
	const response = await fetch(url, {
		method,
		headers: {
			Authorization: await authorization(),
			"User-Agent": "pi-personal-calendar/0.1",
			...(options.body ? { "Content-Type": "application/xml; charset=utf-8" } : {}),
			...options.headers,
		},
		body: options.body,
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	}).catch((err: unknown) => {
		throw new Error(`calendar: ${method} ${url} failed: ${(err as Error).message}`);
	});
	return response;
}

/** Entity-tags travel with their quotes on the wire (RFC 7232). */
function ifMatch(etag: string): string {
	return etag.startsWith('"') || etag.startsWith('W/"') ? etag : `"${etag}"`;
}

/** Drop the quoting: the tools hand etags back as opaque tokens. */
function unquote(etag: string | null | undefined): string | undefined {
	return etag ? etag.replace(/^W\//, "").replace(/^"|"$/g, "") : undefined;
}

async function failure(response: Response, action: string): Promise<Error> {
	const text = (await response.text().catch(() => "")).slice(0, 300).replace(/\s+/g, " ").trim();
	const hints: Record<number, string> = {
		401: "check the CalDAV credentials named by userVar / passwordVar in ~/.pi/agent/env.json, and the Radicale htpasswd entry",
		403: "the user is authenticated but not allowed here (Radicale rights file)",
		404: "the calendar collection may not exist yet",
		412: "someone else changed the event since it was read (ETag mismatch)",
	};
	const hint = hints[response.status] ? ` — ${hints[response.status]}` : "";
	return new Error(`calendar: ${action} failed with HTTP ${response.status}${hint}${text ? `: ${text}` : ""}`);
}

// ── multistatus parsing ───────────────────────────────────────────────────

function unescapeXml(value: string): string {
	return value
		.replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

interface DavResponse {
	href: string;
	etag?: string;
	ics?: string;
}

function parseMultistatus(xml: string): DavResponse[] {
	const responses: DavResponse[] = [];
	for (const match of xml.matchAll(/<(?:[A-Za-z0-9]+:)?response[\s>][\s\S]*?<\/(?:[A-Za-z0-9]+:)?response>/gi)) {
		const block = match[0];
		const href = /<(?:[A-Za-z0-9]+:)?href[^>]*>([^<]*)</i.exec(block)?.[1] ?? "";
		const etag = /<(?:[A-Za-z0-9]+:)?getetag[^>]*>([^<]*)</i.exec(block)?.[1];
		const data = /<(?:[A-Za-z0-9]+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?calendar-data>/i.exec(block)?.[1];
		responses.push({
			href,
			etag: unquote(etag),
			ics: data ? unescapeXml(data) : undefined,
		});
	}
	return responses;
}

function parseResponses(xml: string, config: CalendarConfig): CalendarEvent[] {
	const events: CalendarEvent[] = [];
	for (const response of parseMultistatus(xml)) {
		if (!response.ics) continue;
		const parsed = parseEvents({ ics: response.ics, etag: response.etag, url: `${config.baseUrl}${response.href}` }, config.timezone);
		events.push(...parsed);
	}
	return events;
}

// ── operations ────────────────────────────────────────────────────────────

function calendarQuery(uid: string | undefined, start?: string, end?: string, expand = true): string {
	const timeRange = start && end ? `<C:time-range start="${caldavStamp(start)}" end="${caldavStamp(end)}"/>` : "";
	const propFilter = uid
		? `<C:prop-filter name="UID"><C:text-match collation="i;octet">${uid}</C:text-match></C:prop-filter>`
		: timeRange;
	const expandElement = expand && start && end ? `<C:expand start="${caldavStamp(start)}" end="${caldavStamp(end)}"/>` : "";
	return `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query ${REPORT_NS}>
  <D:prop><D:getetag/><C:calendar-data>${expandElement}</C:calendar-data></D:prop>
  <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">${propFilter}</C:comp-filter></C:comp-filter></C:filter>
</C:calendar-query>`;
}

export interface ListOptions {
	timeMin: string;
	timeMax: string;
	limit: number;
}

export async function listEvents(options: ListOptions): Promise<{ events: CalendarEvent[]; expanded: boolean }> {
	const config = calendarConfig();
	const url = `${config.baseUrl}${config.collection}`;
	const send = async (expand: boolean): Promise<Response> =>
		request("REPORT", url, { body: calendarQuery(undefined, options.timeMin, options.timeMax, expand), headers: { Depth: "1" } });

	let response = await send(true);
	let expanded = true;
	if (!response.ok && [400, 403, 409, 500, 501].includes(response.status)) {
		// Server cannot expand recurrences — ask for the masters instead.
		response = await send(false);
		expanded = false;
	}
	if (!response.ok) throw await failure(response, "listing events");

	const events = parseResponses(await response.text(), config).filter((event) => {
		const start = event.allDay ? `${event.start}T00:00:00Z` : event.start;
		return start < options.timeMax;
	});
	events.sort((a, b) => a.start.localeCompare(b.start) || (a.recurrenceId ?? "").localeCompare(b.recurrenceId ?? ""));
	return { events: events.slice(0, options.limit), expanded };
}

export interface StoredEvent {
	event: CalendarEvent;
	etag?: string;
	url: string;
	ics: string;
}

export async function getEvent(uid: string): Promise<StoredEvent> {
	const config = calendarConfig();
	const url = eventUrl(config, uid);
	const direct = await request("GET", url, { headers: { Accept: "text/calendar" } });
	if (direct.ok) {
		const ics = await direct.text();
		const [event] = parseEvents({ ics, etag: unquote(direct.headers.get("etag")), url }, config.timezone);
		if (!event) throw new Error(`calendar: ${uid} contains no VEVENT`);
		return { event, etag: event.etag, url, ics };
	}
	if (direct.status !== 404) throw await failure(direct, `reading event ${uid}`);

	// Not stored under the conventional name — look it up by UID.
	const report = await request("REPORT", `${config.baseUrl}${config.collection}`, {
		body: calendarQuery(uid),
		headers: { Depth: "1" },
	});
	if (!report.ok) throw await failure(report, `searching for event ${uid}`);
	const [response] = parseMultistatus(await report.text()).filter((entry) => entry.ics);
	if (!response?.ics) throw new Error(`calendar: no event with uid ${uid}`);
	const [event] = parseEvents({ ics: response.ics, etag: response.etag, url: `${config.baseUrl}${response.href}` }, config.timezone);
	if (!event) throw new Error(`calendar: ${uid} contains no VEVENT`);
	return { event, etag: response.etag, url: `${config.baseUrl}${response.href}`, ics: response.ics };
}

export async function createEvent(input: EventInput): Promise<CalendarEvent> {
	const config = calendarConfig();
	const uid = randomUUID();
	let start = parseInstant(input.start, config.timezone);
	let end = input.end ? parseInstant(input.end, config.timezone) : undefined;
	if (input.allDay) {
		start = { iso: toDateOnly(start.iso, config.timezone), allDay: true };
		if (end) end = { iso: toDateOnly(end.iso, config.timezone), allDay: true };
	}
	if (end && end.iso < start.iso) throw new Error(`calendar: end (${end.iso}) is before start (${start.iso})`);

	const ics = buildEvent({
		uid,
		summary: input.summary,
		start,
		end,
		location: input.location,
		description: input.description,
		rrule: input.rrule,
		reminders: input.reminders,
	});
	const url = eventUrl(config, uid);
	const response = await request("PUT", url, {
		body: ics,
		headers: { "Content-Type": "text/calendar; charset=utf-8", "If-None-Match": "*" },
	});
	if (!response.ok) throw await failure(response, `creating event "${input.summary}"`);
	const [event] = parseEvents({ ics, etag: unquote(response.headers.get("etag")), url }, config.timezone);
	return event ?? { uid, summary: input.summary, start: start.iso, allDay: start.allDay };
}

export async function updateEvent(uid: string, changes: Partial<EventInput>): Promise<CalendarEvent> {
	const config = calendarConfig();
	const current = await getEvent(uid);
	const merged: EventInput = {
		summary: changes.summary ?? current.event.summary,
		start: changes.start ?? current.event.start,
		end: changes.end ?? current.event.end,
		allDay: changes.allDay,
		location: changes.location ?? current.event.location,
		description: changes.description ?? current.event.description,
		rrule: changes.rrule ?? current.event.rrule,
		// Undefined keeps the alarms already on the event; [] clears them.
		reminders: changes.reminders ?? current.event.reminders,
	};
	let start = parseInstant(merged.start, config.timezone);
	let end = merged.end ? parseInstant(merged.end, config.timezone) : undefined;
	if (changes.allDay) {
		start = { iso: toDateOnly(start.iso, config.timezone), allDay: true };
		if (end) end = { iso: toDateOnly(end.iso, config.timezone), allDay: true };
	}
	if (end && end.iso < start.iso) throw new Error(`calendar: end (${end.iso}) is before start (${start.iso})`);

	const ics = buildEvent({
		uid,
		summary: merged.summary,
		start,
		end,
		location: merged.location,
		description: merged.description,
		rrule: merged.rrule,
		reminders: merged.reminders,
	});
	const response = await request("PUT", current.url, {
		body: ics,
		headers: {
			"Content-Type": "text/calendar; charset=utf-8",
			...(current.etag ? { "If-Match": ifMatch(current.etag) } : {}),
		},
	});
	if (!response.ok) throw await failure(response, `updating event ${uid}`);
	const [event] = parseEvents({ ics, etag: unquote(response.headers.get("etag")), url: current.url }, config.timezone);
	return event ?? { uid, summary: merged.summary, start: start.iso, allDay: start.allDay };
}

export async function deleteEvent(uid: string): Promise<{ event: CalendarEvent; snapshot: string }> {
	const config = calendarConfig();
	const current = await getEvent(uid);
	// Snapshot before the DELETE: the audit log is the only place the event
	// survives, and it is written even if the DELETE then fails.
	auditLog(config).write({ op: "delete_event", uid, summary: current.event.summary, start: current.event.start, ics: current.ics });
	const response = await request("DELETE", current.url, {
		headers: current.etag ? { "If-Match": ifMatch(current.etag) } : {},
	});
	if (!response.ok) throw await failure(response, `deleting event ${uid}`);
	return { event: current.event, snapshot: current.ics };
}

/** PROPFIND on a URL — used by the live test to check /.well-known/caldav. */
export async function propfind(url: string, depth = "0"): Promise<Response> {
	return request("PROPFIND", url, {
		body: `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>`,
		headers: { Depth: depth },
	});
}

/** Test seam: forget the cached config and credentials (see test/harness.mjs). */
export function resetState(): void {
	state().config = undefined;
	state().auth = undefined;
}

/** All VEVENT lines of a raw ICS — the audit snapshot format. */
export function icsLineCount(ics: string): number {
	return unfoldLines(ics).length;
}
