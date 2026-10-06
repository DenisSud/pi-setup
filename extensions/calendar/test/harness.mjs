/**
 * Harness tests for the calendar extension.
 *
 * ICS parsing/building and the CalDAV operations run against a mocked fetch
 * and a stub `rbw` binary, so ETag preconditions, the expand fallback, the
 * delete snapshot and the credential path are all exercised offline.
 *
 *   ./test/run.sh harness   mocked fetch + stub rbw (no network)
 *   ./test/run.sh live      real CalDAV on cal.sudakov.site
 *                           (CALENDAR_LIVE_WRITE=1 adds the event cycle)
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetState } from "../caldav.ts";
import { loadConfig } from "../config.ts";
import calendarExtension from "../index.ts";
import {
	buildEvent,
	caldavStamp,
	foldLine,
	formatInZone,
	formatTrigger,
	parseEvents,
	parseInstant,
	toDateOnly,
	zonedToUtcIso,
} from "../ics.ts";

// ── environment ───────────────────────────────────────────────────────────

const TMP = mkdtempSync(join(tmpdir(), "calendar-harness-"));
const CONFIG = join(TMP, "config.json");
const AUDIT = join(TMP, "audit.jsonl");
const BASE = "https://cal.test";

writeFileSync(
	CONFIG,
	JSON.stringify({
		baseUrl: BASE,
		collection: "/denis/main/",
		secretProfile: "radicale-agent",
		timezone: "Europe/Moscow",
		auditLog: AUDIT,
	}),
);
writeFileSync(join(TMP, "rbw"), "#!/bin/sh\necho harness-secret\n", { mode: 0o755 });
writeFileSync(
	join(TMP, "security.json"),
	JSON.stringify({
		profiles: {
			"radicale-agent": {
				vars: {
					RADICALE_USER: { item: "Radicale agent", field: "username", folder: "pi" },
					RADICALE_PASSWORD: { item: "Radicale agent", field: "password", folder: "pi" },
				},
			},
		},
		rbw: { command: join(TMP, "rbw"), timeoutMs: 5000 },
	}),
);
process.env.CALENDAR_CONFIG = CONFIG;
process.env.PI_SECURITY_CONFIG = join(TMP, "security.json");

// ── tiny test runner ──────────────────────────────────────────────────────

const tests = [];
const liveTests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
	tests.push({ name, fn });
}

function liveTest(name, fn) {
	if (process.env.CALENDAR_LIVE) liveTests.push({ name, fn });
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
	return { registerTool: (def) => tools.set(def.name, def), on: () => {}, tools };
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

// ── fetch mock ────────────────────────────────────────────────────────────

const REAL_FETCH = globalThis.fetch;
let requests = [];

function mockFetch(handler) {
	requests = [];
	globalThis.fetch = async (url, init = {}) => {
		const request = { url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body };
		requests.push(request);
		return handler(request);
	};
}

function lastRequest(method) {
	return [...requests].reverse().find((request) => request.method === method);
}

function xml(body, { status = 207, etag } = {}) {
	return new Response(body, {
		status,
		headers: { "content-type": "application/xml; charset=utf-8", ...(etag ? { etag } : {}) },
	});
}

function escapeXml(text) {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function multistatus(entries) {
	const responses = entries
		.map(
			({ href, ics, etag }) => `<D:response>
  <D:href>${href}</D:href>
  <D:propstat><D:prop>
    ${etag ? `<D:getetag>"${etag}"</D:getetag>` : ""}
    ${ics ? `<C:calendar-data>${escapeXml(ics)}</C:calendar-data>` : ""}
  </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
</D:response>`,
		)
		.join("\n");
	return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
${responses}
</D:multistatus>`;
}

function ics({ uid, summary = "Event", dtstart = "20260924T120000Z", dtend, rrule, recurrenceId, location, description, alarm }) {
	const lines = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"BEGIN:VEVENT",
		`UID:${uid}`,
		"DTSTAMP:20260920T000000Z",
		`SUMMARY:${summary}`,
		`DTSTART:${dtstart}`,
	];
	if (dtend) lines.push(`DTEND:${dtend}`);
	if (rrule) lines.push(`RRULE:${rrule}`);
	if (recurrenceId) lines.push(`RECURRENCE-ID:${recurrenceId}`);
	if (location) lines.push(`LOCATION:${location}`);
	if (description) lines.push(`DESCRIPTION:${description}`);
	if (alarm) lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${summary}`, `TRIGGER:${alarm}`, "END:VALARM");
	lines.push("END:VEVENT", "END:VCALENDAR");
	return `${lines.join("\r\n")}\r\n`;
}

function readAudit() {
	if (!existsSync(AUDIT)) return [];
	return readFileSync(AUDIT, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// ── ICS unit tests ────────────────────────────────────────────────────────

test("parseInstant: rfc3339, local time and date-only", () => {
	assertEqual(parseInstant("2026-09-24T15:00:00+03:00", "Europe/Moscow"), { iso: "2026-09-24T12:00:00.000Z", allDay: false });
	assertEqual(parseInstant("2026-09-24 15:00", "Europe/Moscow"), { iso: "2026-09-24T12:00:00.000Z", allDay: false });
	assertEqual(parseInstant("2026-09-24", "Europe/Moscow"), { iso: "2026-09-24", allDay: true });
	assertEqual(parseInstant("2026-09-24T15:00:00", "Europe/Moscow"), { iso: "2026-09-24T12:00:00.000Z", allDay: false });
});

test("time zones: Moscow offset, DST edge in Berlin, display", () => {
	assertEqual(zonedToUtcIso("2026-01-15T12:00:00", "Europe/Moscow"), "2026-01-15T09:00:00.000Z");
	assertEqual(zonedToUtcIso("2026-01-15T12:00:00", "Europe/Berlin"), "2026-01-15T11:00:00.000Z");
	assertEqual(zonedToUtcIso("2026-07-15T12:00:00", "Europe/Berlin"), "2026-07-15T10:00:00.000Z");
	assertEqual(formatInZone("2026-09-24T12:00:00.000Z", "Europe/Moscow"), "2026-09-24 15:00");
	assertEqual(toDateOnly("2026-09-24T21:30:00.000Z", "Europe/Moscow"), "2026-09-25");
});

test("parseEvents: folded lines, escaping, TZID, all-day, recurrence", () => {
	const source = `BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
UID:abc-1\r
DTSTAMP:20260920T000000Z\r
SUMMARY:Dinner with a very long title that has been folded by the cl\r
 ient into two lines\r
DTSTART;TZID=Europe/Moscow:20260924T190000\r
DTEND;TZID=Europe/Moscow:20260924T210000\r
LOCATION:Cafe\\, corner\\; table 4\r
DESCRIPTION:Line one\\nLine two\r
RRULE:FREQ=WEEKLY;BYDAY=TH\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:abc-2\r
DTSTAMP:20260920T000000Z\r
SUMMARY:Birthday\r
DTSTART;VALUE=DATE:20261001\r
END:VEVENT\r
END:VCALENDAR\r
`;
	const events = parseEvents({ ics: source, etag: "e1", url: `${BASE}/denis/main/abc-1.ics` }, "Europe/Moscow");
	assertEqual(events.length, 2);
	const [first, second] = events;
	assertEqual(first.uid, "abc-1");
	assertEqual(first.summary, "Dinner with a very long title that has been folded by the client into two lines");
	assertEqual(first.start, "2026-09-24T16:00:00.000Z");
	assertEqual(first.end, "2026-09-24T18:00:00.000Z");
	assertEqual(first.location, "Cafe, corner; table 4");
	assertEqual(first.description, "Line one\nLine two");
	assertEqual(first.rrule, "FREQ=WEEKLY;BYDAY=TH");
	assertEqual(first.etag, "e1");
	assertEqual(second.allDay, true);
	assertEqual(second.start, "2026-10-01");
});

test("buildEvent: round trips through parseEvents", () => {
	const icsText = buildEvent({
		uid: "round-1",
		summary: "Обед; с коллегами, в 13:00",
		start: { iso: "2026-09-24T10:00:00.000Z", allDay: false },
		end: { iso: "2026-09-24T11:00:00.000Z", allDay: false },
		location: "Офис",
		description: "First line\nSecond line",
		rrule: "FREQ=WEEKLY;COUNT=3",
		now: new Date("2026-09-20T00:00:00Z"),
	});
	assert(icsText.includes("DTSTAMP:20260920T000000Z"), icsText);
	assert(icsText.includes("\r\n"), "CRLF line endings");
	const [event] = parseEvents({ ics: icsText }, "Europe/Moscow");
	assertEqual(event.uid, "round-1");
	assertEqual(event.summary, "Обед; с коллегами, в 13:00");
	assertEqual(event.start, "2026-09-24T10:00:00.000Z");
	assertEqual(event.end, "2026-09-24T11:00:00.000Z");
	assertEqual(event.description, "First line\nSecond line");
	assertEqual(event.rrule, "FREQ=WEEKLY;COUNT=3");
});

test("buildEvent: all-day events use DATE values", () => {
	const icsText = buildEvent({
		uid: "allday-1",
		summary: "Holiday",
		start: { iso: "2026-10-01", allDay: true },
		end: { iso: "2026-10-05", allDay: true },
	});
	assert(icsText.includes("DTSTART;VALUE=DATE:20261001"), icsText);
	assert(icsText.includes("DTEND;VALUE=DATE:20261005"), icsText);
});

test("foldLine: folds at 75 octets without splitting a code point", () => {
	const line = `SUMMARY:${"п".repeat(80)}`;
	const folded = foldLine(line);
	assert(folded.length > 1, "expected folding");
	for (const part of folded.slice(0, -1)) {
		assert(Buffer.byteLength(part, "utf8") <= 75, `line too long: ${Buffer.byteLength(part, "utf8")}`);
	}
	const unfolded = folded.map((part, index) => (index === 0 ? part : part.slice(1))).join("");
	assertEqual(unfolded, line);
	assert(!folded.some((part) => part.includes("�")), "no broken characters");
});

test("caldavStamp: UTC compact form", () => {
	assertEqual(caldavStamp("2026-09-24T12:00:00.000Z"), "20260924T120000Z");
});

test("reminders: build event with alarms and parse them back", () => {
	const icsText = buildEvent({
		uid: "rem-1",
		summary: "Dentist",
		start: { iso: "2026-09-24T10:00:00.000Z", allDay: false },
		end: { iso: "2026-09-24T11:00:00.000Z", allDay: false },
		reminders: [10, 1440],
		now: new Date("2026-09-20T00:00:00Z"),
	});
	assert(icsText.includes("BEGIN:VALARM"), icsText);
	assert(icsText.includes("TRIGGER:-PT10M"), icsText);
	assert(icsText.includes("TRIGGER:-P1D"), icsText);
	assert(icsText.includes("ACTION:DISPLAY"), icsText);
	const [event] = parseEvents({ ics: icsText }, "Europe/Moscow");
	assertEqual(event.reminders, [10, 1440]);
});

test("reminders: parsed from a client-written alarm, and cleared when absent", () => {
	const [withAlarm] = parseEvents(
		{ ics: ics({ uid: "a", summary: "Call", dtstart: "20260924T120000Z", dtend: "20260924T123000Z", alarm: "-PT15M" }) },
		"Europe/Moscow",
	);
	assertEqual(withAlarm.reminders, [15]);

	const [without] = parseEvents({ ics: ics({ uid: "b", summary: "Call" }) }, "Europe/Moscow");
	assertEqual(without.reminders, undefined);
});

test("reminders: trigger relative to the end counts back to the start", () => {
	const source = ics({ uid: "c", summary: "Workshop", dtstart: "20260924T120000Z", dtend: "20260924T140000Z", alarm: "-PT30M" }).replace(
		"TRIGGER:-PT30M",
		"TRIGGER;RELATED=END:-PT30M",
	);
	const [event] = parseEvents({ ics: source }, "Europe/Moscow");
	assertEqual(event.reminders, [90]);
});

test("reminders: non-DISPLAY and absolute alarms are ignored", () => {
	const source = ics({ uid: "d", summary: "Noisy", alarm: "-PT5M" }).replace("ACTION:DISPLAY", "ACTION:EMAIL");
	assertEqual(parseEvents({ ics: source }, "Europe/Moscow")[0].reminders, undefined);
	const absolute = ics({ uid: "e", summary: "Absolute", alarm: "-PT5M" }).replace("TRIGGER:-PT5M", "TRIGGER;VALUE=DATE-TIME:20260924T110000Z");
	assertEqual(parseEvents({ ics: absolute }, "Europe/Moscow")[0].reminders, undefined);
});

test("formatTrigger: days, hours and minutes", () => {
	assertEqual(formatTrigger(10), "-PT10M");
	assertEqual(formatTrigger(1440), "-P1D");
	assertEqual(formatTrigger(90), "-PT1H30M");
	assertEqual(formatTrigger(1500), "-P1DT1H");
	assertEqual(formatTrigger(0), "-PT0M");
	assertEqual(formatTrigger(-5), "PT5M");
});

// ── tool tests (mocked fetch) ─────────────────────────────────────────────

const pi = makePi();
calendarExtension(pi);
const tool = (name) => pi.tools.get(name);

test("all five calendar tools are registered", () => {
	assertEqual(
		[...pi.tools.keys()].sort(),
		["calendar_create_event", "calendar_delete_event", "calendar_get_event", "calendar_list_events", "calendar_update_event"],
	);
});

test("list: sends an expanded time-range REPORT and formats the hits", async () => {
	mockFetch((request) => {
		assertEqual(request.method, "REPORT");
		assertEqual(request.url, `${BASE}/denis/main/`);
		assertEqual(request.headers.Depth, "1");
		assert(request.body.includes("<C:expand"), request.body);
		assert(request.body.includes("start="), request.body);
		return xml(
			multistatus([
				{ href: "/denis/main/a.ics", etag: "e-a", ics: ics({ uid: "a", summary: "Standup", dtstart: "20260924T090000Z", dtend: "20260924T091500Z" }) },
				{ href: "/denis/main/b.ics", etag: "e-b", ics: ics({ uid: "b", summary: "Lunch", dtstart: "20260924T100000Z", rrule: "FREQ=DAILY", recurrenceId: "20260925T100000Z" }) },
			]),
		);
	});
	const result = await runTool(tool("calendar_list_events"), { time_min: "2026-09-24", time_max: "2026-09-26", limit: 10 });
	const text = result.content[0].text;
	assert(!result.isError, text);
	assert(text.includes("Standup"), text);
	assert(text.includes("Lunch"), text);
	assert(text.includes("instance of a recurring event"), text);
	assertEqual(result.details.count, 2);
	assert(readAudit().at(-1).op === "list_events");
});

test("list: falls back to masters when the server refuses to expand", async () => {
	mockFetch((request) => {
		if (request.body.includes("<C:expand")) return new Response("expand not supported", { status: 403 });
		return xml(multistatus([{ href: "/denis/main/a.ics", ics: ics({ uid: "a", summary: "Weekly", dtstart: "20260924T090000Z", rrule: "FREQ=WEEKLY" }) }]));
	});
	const result = await runTool(tool("calendar_list_events"), { time_min: "2026-09-24", time_max: "2026-09-26" });
	assertEqual(requests.filter((request) => request.method === "REPORT").length, 2);
	assert(!lastRequest("REPORT").body.includes("<C:expand"));
	assertEqual(result.details.expanded, false);
	assert(result.content[0].text.includes("Weekly"), result.content[0].text);
});

test("get: reads the event by uid with credentials from the secrets profile", async () => {
	mockFetch((request) => {
		assertEqual(request.method, "GET");
		assertEqual(request.url, `${BASE}/denis/main/event-1.ics`);
		assert(request.headers.Authorization.startsWith("Basic "), "basic auth header");
		return new Response(ics({ uid: "event-1", summary: "Dentist", dtstart: "20260924T070000Z", location: "Clinic" }), {
			status: 200,
			headers: { etag: '"etag-1"' },
		});
	});
	const result = await runTool(tool("calendar_get_event"), { uid: "event-1" });
	assert(!result.isError, result.content[0].text);
	assert(result.content[0].text.includes("Dentist"), result.content[0].text);
	assert(result.content[0].text.includes("10:00"), result.content[0].text);
	assertEqual(result.details.etag, "etag-1");
});

test("get: falls back to a REPORT when the file is not at <uid>.ics", async () => {
	mockFetch((request) => {
		if (request.method === "GET") return new Response("not found", { status: 404 });
		assert(request.body.includes('<C:prop-filter name="UID">'), request.body);
		return xml(multistatus([{ href: "/denis/main/other-name.ics", etag: "e2", ics: ics({ uid: "event-2", summary: "Moved" }) }]));
	});
	const result = await runTool(tool("calendar_get_event"), { uid: "event-2" });
	assert(!result.isError, result.content[0].text);
	assert(result.content[0].text.includes("Moved"), result.content[0].text);
	assertEqual(result.details.etag, "e2");
});

test("create: PUTs with If-None-Match and returns the uid", async () => {
	mockFetch((request) => {
		assertEqual(request.method, "PUT");
		assert(request.url.startsWith(`${BASE}/denis/main/`) && request.url.endsWith(".ics"), request.url);
		assertEqual(request.headers["If-None-Match"], "*");
		assertEqual(request.headers["Content-Type"], "text/calendar; charset=utf-8");
		assert(request.body.includes("SUMMARY:Позвонить маме"), request.body);
		return new Response("", { status: 201, headers: { etag: '"new-etag"' } });
	});
	rmSync(AUDIT, { force: true });
	const result = await runTool(tool("calendar_create_event"), { summary: "Позвонить маме", start: "2026-09-24 19:00", end: "2026-09-24 19:30" });
	assert(!result.isError, result.content[0].text);
	assert(/^[0-9a-f-]{36}$/.test(result.details.uid), `uid: ${result.details.uid}`);
	assert(result.content[0].text.includes("19:00"), result.content[0].text);
	assertEqual(readAudit().at(-1).op, "create_event");
});

test("create: all-day events round trip as dates", async () => {
	mockFetch((request) => {
		assert(request.body.includes("DTSTART;VALUE=DATE:20261001"), request.body);
		return new Response("", { status: 201 });
	});
	const result = await runTool(tool("calendar_create_event"), { summary: "Holiday", start: "2026-10-01", end: "2026-10-05", all_day: true });
	assert(!result.isError, result.content[0].text);
	assert(result.content[0].text.includes("(all day)"), result.content[0].text);
});

test("create/update: reminders ride along, survive an unrelated update, and clear with []", async () => {
	let putBody = "";
	mockFetch((request) => {
		if (request.method === "PUT") {
			putBody = request.body;
			return new Response(null, { status: 204, headers: { etag: '"e"' } });
		}
		return new Response(ics({ uid: "event-7", summary: "Standup", dtstart: "20260924T090000Z", dtend: "20260924T091500Z", alarm: "-PT10M" }), {
			status: 200,
			headers: { etag: '"e7"' },
		});
	});

	const created = await runTool(tool("calendar_create_event"), {
		summary: "Standup",
		start: "2026-09-24 12:00",
		end: "2026-09-24 12:15",
		reminders: [10, 1440],
	});
	assert(!created.isError, created.content[0].text);
	assert(putBody.includes("BEGIN:VALARM") && putBody.includes("TRIGGER:-PT10M") && putBody.includes("TRIGGER:-P1D"), putBody);
	assert(created.content[0].text.includes("10 min before"), created.content[0].text);

	await runTool(tool("calendar_update_event"), { uid: "event-7", summary: "Standup (new room)" });
	assert(putBody.includes("TRIGGER:-PT10M"), `reminder lost on update: ${putBody}`);
	assert(putBody.includes("SUMMARY:Standup (new room)"), putBody);

	await runTool(tool("calendar_update_event"), { uid: "event-7", reminders: [] });
	assert(!putBody.includes("VALARM"), `reminder not cleared: ${putBody}`);
});

test("get: shows the reminders of an event", async () => {
	mockFetch(() =>
		new Response(ics({ uid: "event-8", summary: "Gym", dtstart: "20260924T160000Z", alarm: "-PT30M" }), { status: 200, headers: { etag: '"e8"' } }),
	);
	const result = await runTool(tool("calendar_get_event"), { uid: "event-8" });
	assert(!result.isError, result.content[0].text);
	assert(result.content[0].text.includes("30 min before"), result.content[0].text);
});

test("update: keeps unmentioned fields and PUTs with If-Match", async () => {
	mockFetch((request) => {
		if (request.method === "GET") {
			return new Response(
				ics({ uid: "event-3", summary: "Gym", dtstart: "20260924T160000Z", dtend: "20260924T170000Z", location: "Basement" }),
				{ status: 200, headers: { etag: '"etag-3"' } },
			);
		}
		assertEqual(request.method, "PUT");
		assertEqual(request.headers["If-Match"], '"etag-3"');
		assert(request.body.includes("SUMMARY:Gym with Pavel"), request.body);
		assert(request.body.includes("LOCATION:Basement"), request.body);
		assert(request.body.includes("DTSTART:20260924T160000Z"), request.body);
		return new Response(null, { status: 204, headers: { etag: '"etag-4"' } });
	});
	const result = await runTool(tool("calendar_update_event"), { uid: "event-3", summary: "Gym with Pavel" });
	assert(!result.isError, result.content[0].text);
	assert(result.content[0].text.includes("Gym with Pavel"), result.content[0].text);
	assertEqual(result.details.etag, "etag-4");
});

test("update: a stale etag surfaces as a 412 with a hint", async () => {
	mockFetch((request) => {
		if (request.method === "GET") return new Response(ics({ uid: "event-4", summary: "Race" }), { status: 200, headers: { etag: '"old"' } });
		return new Response("precondition failed", { status: 412 });
	});
	const result = await runTool(tool("calendar_update_event"), { uid: "event-4", summary: "Race (new)" });
	assert(result.isError, "expected an error");
	assert(result.content[0].text.includes("412"), result.content[0].text);
	assert(result.content[0].text.includes("changed the event"), result.content[0].text);
});

test("delete: snapshots the event into the audit log before deleting", async () => {
	mockFetch((request) => {
		if (request.method === "GET") {
			return new Response(ics({ uid: "event-5", summary: "Cancel me", dtstart: "20260924T080000Z" }), { status: 200, headers: { etag: '"e5"' } });
		}
		assertEqual(request.method, "DELETE");
		assertEqual(request.headers["If-Match"], '"e5"');
		return new Response(null, { status: 204 });
	});
	rmSync(AUDIT, { force: true });
	const result = await runTool(tool("calendar_delete_event"), { uid: "event-5" });
	assert(!result.isError, result.content[0].text);
	const entry = readAudit().at(-1);
	assertEqual(entry.op, "delete_event");
	assertEqual(entry.uid, "event-5");
	assert(entry.ics.includes("SUMMARY:Cancel me"), entry.ics);
});

test("errors: 401 explains the credential path", async () => {
	mockFetch(() => new Response("unauthorized", { status: 401 }));
	const result = await runTool(tool("calendar_get_event"), { uid: "event-6" });
	assert(result.isError, "expected an error");
	assert(result.content[0].text.includes("secrets profile"), result.content[0].text);
});

test("config: collection path is normalised", () => {
	const config = loadConfig();
	assertEqual(config.collection, "/denis/main/");
	assertEqual(config.baseUrl, BASE);
	assertEqual(config.timezone, "Europe/Moscow");
});

// ── live tests ────────────────────────────────────────────────────────────

if (process.env.CALENDAR_LIVE) {
	// The mocked tests ran with a stub rbw and a cal.test config; drop both
	// caches so the live tests talk to the real server with the real vault.
	const goLive = () => {
		globalThis.fetch = REAL_FETCH;
		delete process.env.CALENDAR_CONFIG;
		delete process.env.PI_SECURITY_CONFIG;
		resetState();
	};

	liveTest("live: caldav discovery + list events", async () => {
		goLive();
		const discovery = await REAL_FETCH("https://cal.sudakov.site/.well-known/caldav", { redirect: "follow" });
		assert([200, 301, 302, 401].includes(discovery.status), `discovery status ${discovery.status}`);
		const result = await runTool(tool("calendar_list_events"), { time_min: "2020-01-01", time_max: "2030-01-01", limit: 5 });
		assert(!result.isError, result.content[0].text);
		console.log(`    ${result.content[0].text.split("\n")[0]}`);
	});

	if (process.env.CALENDAR_LIVE_WRITE === "1") {
		liveTest("live: create → update → delete", async () => {
			goLive();
			const created = await runTool(tool("calendar_create_event"), {
				summary: "pi harness test",
				start: "2026-12-01 10:00",
				end: "2026-12-01 10:30",
				description: "Created by the calendar harness; safe to delete.",
				reminders: [10, 1440],
			});
			assert(!created.isError, created.content[0].text);
			const readBack = await runTool(tool("calendar_get_event"), { uid: created.details.uid });
			assert(readBack.content[0].text.includes("10 min before"), readBack.content[0].text);
			assert(readBack.content[0].text.includes("1 day before") || readBack.content[0].text.includes("1440 min before"), readBack.content[0].text);
			const updated = await runTool(tool("calendar_update_event"), { uid: created.details.uid, summary: "pi harness test (updated)" });
			assert(!updated.isError, updated.content[0].text);
			const afterUpdate = await runTool(tool("calendar_get_event"), { uid: created.details.uid });
			assert(afterUpdate.content[0].text.includes("10 min before"), `reminder lost on update: ${afterUpdate.content[0].text}`);
			const deleted = await runTool(tool("calendar_delete_event"), { uid: created.details.uid });
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
