/**
 * calendar — the personal calendar tools, over CalDAV against Radicale on the
 * home RPi (cal.sudakov.site).
 *
 * Five tools: list, read, create, update, delete. Times are stored in UTC
 * (all-day events as dates), so no VTIMEZONE is needed and every client shows
 * them correctly; input and output are rendered in the configured zone.
 *
 * Out of scope by design: attendees, and editing single instances of a
 * recurring series — an update rewrites the whole series. Reminders are
 * supported as DISPLAY alarms (VALARM) that the client fires; the server only
 * stores them.
 */
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	auditLog,
	calendarConfig,
	createEvent,
	deleteEvent,
	getEvent,
	listEvents,
	updateEvent,
} from "./caldav.ts";
import { formatInZone } from "./ics.ts";
import type { CalendarEvent } from "./types.ts";

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function when(event: CalendarEvent, timezone: string): string {
	if (event.allDay) {
		const end = event.end ? ` → ${event.end}` : "";
		return `${event.start} (all day)${end}`;
	}
	const start = formatInZone(event.start, timezone);
	const end = event.end ? `–${formatInZone(event.end, timezone).slice(-5)}` : "";
	return `${start}${end} (${timezone})`;
}

function describe(event: CalendarEvent, timezone: string, verbose: boolean): string {
	const lines = [`- ${when(event, timezone)} — ${event.summary}`];
	if (event.location) lines.push(`  at ${event.location}`);
	if (event.reminders?.length) {
		lines.push(`  reminder(s): ${event.reminders.map((minutes) => (minutes < 0 ? `${-minutes} min after start` : `${minutes} min before`)).join(", ")}`);
	}
	if (event.recurrenceId) lines.push(`  (instance of a recurring event, recurrence-id ${event.recurrenceId})`);
	else if (event.rrule) lines.push(`  repeats: ${event.rrule}`);
	if (verbose && event.description) lines.push(`  ${event.description.replace(/\n/g, "\n  ")}`);
	lines.push(`  uid: ${event.uid}${event.etag ? `  etag: ${event.etag}` : ""}`);
	return lines.join("\n");
}

function renderer(title: string, summarize: (details: Record<string, unknown>) => string) {
	return {
		renderCall(
			args: Record<string, unknown>,
			theme: { fg: (color: string, text: string) => string; bold: (text: string) => string },
			context: { lastComponent?: unknown },
		) {
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

const START = Type.String({
	description:
		'Event start: RFC3339 ("2026-09-24T15:00:00+03:00"), local time ("2026-09-24 15:00", interpreted in the calendar timezone) or a date ("2026-09-24") for an all-day event',
});
const END = Type.Optional(Type.String({ description: "Event end, same formats as start. For all-day events, the exclusive end date" }));
const UID = Type.String({ description: "Event uid (from calendar_list_events / calendar_get_event)" });
const REMINDERS = Type.Array(Type.Integer({ minimum: -10_080, maximum: 40_320 }), {
	description:
		"Reminders as DISPLAY alarms, in minutes before the start: [10, 1440] = 10 minutes and 1 day before (negative = after the start). The calendar client (GNOME Calendar, DAVx⁵/phone) shows the notification — this server only stores the alarm.",
});

export default function calendarExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "calendar_list_events",
		label: "Calendar List",
		description:
			"List events in Denis's personal calendar (cal.sudakov.site) between two times, ordered by start. Recurring events are expanded by the server, so each occurrence appears separately. Returns uid + etag for follow-up calls. Use it to answer \"what's on my calendar\" questions and before creating an event.",
		parameters: Type.Object({
			time_min: Type.Optional(Type.String({ description: "Range start, RFC3339 or a date (default: now)" })),
			time_max: Type.Optional(Type.String({ description: "Range end, RFC3339 or a date (default: 30 days after time_min)" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Max events (default 50)" })),
		}),
		...renderer("Calendar List", (details) => `${details.count ?? 0} event(s)`),
		async execute(_toolCallId, params) {
			const config = calendarConfig();
			const now = new Date();
			const timeMin = params.time_min ? new Date(params.time_min).toISOString() : now.toISOString();
			const timeMax = params.time_max
				? new Date(params.time_max).toISOString()
				: new Date(Date.parse(timeMin) + 30 * 24 * 3600 * 1000).toISOString();
			const limit = Math.min(500, Math.max(1, Math.round(params.limit ?? 50)));
			const { events, expanded } = await listEvents({ timeMin, timeMax, limit });
			auditLog(config).write({ op: "list_events", time_min: timeMin, time_max: timeMax, count: events.length, expanded });

			const header = `${events.length} event(s) between ${formatInZone(timeMin, config.timezone)} and ${formatInZone(timeMax, config.timezone)} (${config.timezone})${expanded ? "" : " — server returned recurring masters, not expanded instances"}`;
			const body = events.length ? events.map((event) => describe(event, config.timezone, false)).join("\n") : "Nothing scheduled in that range.";
			return {
				content: [{ type: "text" as const, text: `${header}\n\n${body}` }],
				details: { count: events.length, timeMin, timeMax, expanded },
			};
		},
	});

	pi.registerTool({
		name: "calendar_get_event",
		label: "Calendar Read",
		description: "Read one event of Denis's personal calendar by uid: times, location, description, recurrence rule and the etag needed for an update.",
		parameters: Type.Object({ uid: UID }),
		...renderer("Calendar Read", (details) => String(details.summary ?? "event")),
		async execute(_toolCallId, params) {
			const config = calendarConfig();
			const stored = await getEvent(params.uid);
			auditLog(config).write({ op: "get_event", uid: params.uid });
			return {
				content: [{ type: "text" as const, text: describe(stored.event, config.timezone, true) }],
				details: { uid: params.uid, summary: stored.event.summary, etag: stored.etag },
			};
		},
	});

	pi.registerTool({
		name: "calendar_create_event",
		label: "Calendar Create",
		description:
			"Create an event in Denis's personal calendar. Times are stored in UTC; pass local Moscow times or RFC3339 with an offset. All-day events use plain dates (end date is exclusive). Recurrence is supported by passing an RRULE (e.g. FREQ=WEEKLY;BYDAY=MO), and reminders by passing how many minutes before the start to notify (the phone/laptop calendar app fires them). No attendees — that field is not part of this calendar. Returns the new event's uid.",
		parameters: Type.Object({
			summary: Type.String({ description: "Event title" }),
			start: START,
			end: END,
			all_day: Type.Optional(Type.Boolean({ description: "Treat start/end as dates (default: derived from the date format)" })),
			location: Type.Optional(Type.String({ description: "Where it happens" })),
			description: Type.Optional(Type.String({ description: "Free-form notes (plain text)" })),
			rrule: Type.Optional(Type.String({ description: 'Recurrence rule, e.g. "FREQ=WEEKLY;BYDAY=TU" or "FREQ=DAILY;COUNT=5"' })),
			reminders: Type.Optional(REMINDERS),
		}),
		...renderer("Calendar Create", (details) => String(details.summary ?? "event")),
		async execute(_toolCallId, params) {
			const config = calendarConfig();
			const event = await createEvent({
				summary: params.summary,
				start: params.start,
				end: params.end,
				allDay: params.all_day,
				location: params.location,
				description: params.description,
				rrule: params.rrule,
				reminders: params.reminders,
			});
			auditLog(config).write({ op: "create_event", uid: event.uid, summary: event.summary, start: event.start, end: event.end });
			return {
				content: [{ type: "text" as const, text: `Created:\n${describe(event, config.timezone, true)}` }],
				details: { uid: event.uid, summary: event.summary, start: event.start, end: event.end, etag: event.etag },
			};
		},
	});

	pi.registerTool({
		name: "calendar_update_event",
		label: "Calendar Update",
		description:
			"Change an existing event: fields you pass replace the stored ones, the rest stay. Read the event first (calendar_get_event) so the etag is current — the update is rejected if someone else changed it in the meantime. Recurring series are updated as a whole (single instances are not editable); reminders carry over unless you pass new ones (`reminders: []` removes them).",
		parameters: Type.Object({
			uid: UID,
			summary: Type.Optional(Type.String({ description: "New title" })),
			start: Type.Optional(START),
			end: END,
			location: Type.Optional(Type.String({ description: "New location" })),
			description: Type.Optional(Type.String({ description: "New notes" })),
			rrule: Type.Optional(Type.String({ description: "New recurrence rule (empty string clears it)" })),
			reminders: Type.Optional(REMINDERS),
		}),
		...renderer("Calendar Update", (details) => String(details.summary ?? details.uid ?? "event")),
		async execute(_toolCallId, params) {
			const config = calendarConfig();
			const event = await updateEvent(params.uid, {
				summary: params.summary,
				start: params.start,
				end: params.end,
				location: params.location,
				description: params.description,
				rrule: params.rrule,
				// Omitted = keep the reminders already on the event; [] = remove them.
				reminders: params.reminders,
			});
			auditLog(config).write({ op: "update_event", uid: event.uid, summary: event.summary, start: event.start, end: event.end });
			return {
				content: [{ type: "text" as const, text: `Updated:\n${describe(event, config.timezone, true)}` }],
				details: { uid: event.uid, summary: event.summary, start: event.start, end: event.end, etag: event.etag },
			};
		},
	});

	pi.registerTool({
		name: "calendar_delete_event",
		label: "Calendar Delete",
		description:
			"Delete an event from Denis's personal calendar. A full copy of the event is written to the audit log first, so an accidental delete can be recovered by hand. Confirm with Denis before deleting anything you did not create yourself.",
		parameters: Type.Object({ uid: UID }),
		...renderer("Calendar Delete", (details) => `deleted ${details.summary ?? details.uid ?? ""}`),
		async execute(_toolCallId, params) {
			const config = calendarConfig();
			const { event } = await deleteEvent(params.uid);
			return {
				content: [{ type: "text" as const, text: `Deleted: ${event.summary} (${when(event, config.timezone)}). Snapshot kept in ${config.auditLog}.` }],
				details: { uid: params.uid, summary: event.summary, start: event.start },
			};
		},
	});
}
