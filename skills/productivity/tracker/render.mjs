#!/usr/bin/env node
/**
 * tracker/render.mjs — render tracker.json into a static HTML page.
 *
 * Usage:
 *   node render.mjs [--month YYYY-MM] [--data PATH] [--out PATH] [--open]
 *
 * Defaults: current month, ~/Documents/Notes/personal/tracker.json,
 * ~/.local/share/pi-personal/tracker.html.
 *
 * No dependencies. The page is generated for viewing only; the source of truth
 * stays in tracker.json.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const HOME = os.homedir();
const args = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(name);

const DATA = arg("--data", path.join(HOME, "Documents/Notes/personal/tracker.json"));
const OUT = arg("--out", path.join(HOME, ".local/share/pi-personal/tracker.html"));
const now = new Date();
const monthArg = arg("--month", `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
const [year, month] = monthArg.split("-").map(Number);
const monthStart = new Date(year, month - 1, 1);
const monthEnd = new Date(year, month, 0);
const daysInMonth = monthEnd.getDate();
const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
const monthName = monthStart.toLocaleDateString("en-GB", { month: "long", year: "numeric" });

let data = { habits: [], days: {}, goals: [], reviews: [] };
try {
	data = JSON.parse(fs.readFileSync(DATA, "utf8"));
} catch (err) {
	process.stderr.write(`tracker: cannot read ${DATA}: ${err.message}\n`);
	process.exit(1);
}
const days = data.days ?? {};
const habits = data.habits ?? [];
const goals = data.goals ?? [];
const reviews = data.reviews ?? [];

const iso = (d) =>
	`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;
const elapsed = isCurrentMonth ? Math.max(today.getDate(), 1) : today < monthStart ? 0 : daysInMonth;

const dayKeys = [];
for (let d = 1; d <= daysInMonth; d++) dayKeys.push(iso(new Date(year, month - 1, d)));

function weekKeys() {
	// current calendar week, Monday-based
	const mon = new Date(today);
	mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
	const keys = [];
	for (let i = 0; i < 7; i++) {
		const k = new Date(mon);
		k.setDate(k.getDate() + i);
		if (k <= today) keys.push(iso(k));
	}
	return keys;
}

function monthStats(habit) {
	const marked = dayKeys.filter((k) => days[k]?.[habit.id] === true).length;
	if (habit.kind === "count") {
		// rolling: this week's expected = sessions logged in the 7 days ending today (incl. last week's carry-in days),
		// denominator = expected pace for that same span; can exceed 100%
		const keys7 = [];
		for (let i = 6; i >= 0; i--) {
			const k = new Date(today);
			k.setDate(k.getDate() - i);
			keys7.push(iso(k));
		}
		const done = keys7.filter((k) => days[k]?.[habit.id] === true).length;
		const total = habit.target ?? 0;
		return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
	}
	return { done: marked, total: elapsed, pct: elapsed ? Math.round((marked / elapsed) * 100) : 0 };
}

function cell(key, habit) {
	const v = days[key]?.[habit.id];
	const cls = v === true ? "ok" : v === false ? "no" : "none";
	const mark = v === true ? "✓" : v === false ? "✗" : "·";
	const isToday = key === iso(today);
	return `<td class="c ${cls}${isToday ? " today" : ""}">${mark}</td>`;
}

function bar(pct, kind = "") {
	return `<span class="bar"><span class="fill ${kind}" style="width:${Math.min(100, Math.max(0, pct))}%"></span></span>`;
}

const dailyHabits = habits.filter((h) => h.kind !== "weekly");
const weeklyHabits = habits.filter((h) => h.kind === "weekly");

// ISO weeks overlapping the rendered month (Monday-based), Sunday date as key
function weekLabel(date) {
	const d = new Date(date);
	const day = (d.getDay() + 6) % 7;
	d.setDate(d.getDate() - day);
	const end = new Date(d);
	end.setDate(end.getDate() + 6);
	const key = iso(end);
	return { key, label: `${end.getDate()}/${end.getMonth() + 1}`, done: reviews.includes(key) };
}
const weeks = [];
{
	const first = new Date(year, month - 1, 1);
	const last = new Date(year, month - 1, daysInMonth);
	// walk from the week containing the 1st through the week containing the last day
	let d = new Date(first);
	d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday of week 1
	while (d <= last) {
		weeks.push(weekLabel(d));
		d = new Date(d);
		d.setDate(d.getDate() + 7);
	}
}

const goalCards =
	goals.length === 0
		? `<p class="muted">No goals yet — set them in a weekly review, then they appear here with their progress.</p>`
		: goals
				.map((g) => {
					let meta = g.target ? `target ${g.target}` : "";
					if (g.target) {
						const t = new Date(g.target);
						const left = Math.ceil((t - today) / 86400000);
						if (!Number.isNaN(left)) meta += left >= 0 ? ` · ${left} days left` : ` · overdue`;
					}
					return `<div class="goal">
        <div class="goal-head"><strong>${esc(g.title)}</strong><span class="muted">${meta}</span></div>
        ${g.next ? `<div class="next">Next: ${esc(g.next)}</div>` : ""}${g.notes ? `<div class="next">${esc(g.notes)}</div>` : ""}
      </div>`;
				})
				.join("\n");

function esc(s) {
	return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

const headCells = dayKeys.map((k) => {
	const d = Number(k.slice(-2));
	const isToday = k === iso(today);
	return `<th class="${isToday ? "today" : ""}">${d}</th>`;
});
const dow = ["M", "T", "W", "T", "F", "S", "S"];
const dowCells = dayKeys.map((k) => `<th class="dow">${dow[(new Date(k).getDay() + 6) % 7]}</th>`);

const rows = dailyHabits
	.map((h) => {
		const s = monthStats(h);
		const count = h.kind === "count" ? `<span class="muted">${s.done}/${s.total} · wk of ${today.getDate()}/${today.getMonth()+1}</span>` : "";
		return `<tr>
      <td class="label">${esc(h.label)}</td>
      ${dayKeys.map((k) => cell(k, h)).join("")}
      <td class="summary">${count}${bar(s.pct, s.pct >= 70 ? "good" : s.pct >= 40 ? "mid" : "low")}<span class="pct">${s.pct}%</span></td>
    </tr>`;
	})
	.join("\n");

const weeklyRows = weeklyHabits
	.map((h) => {
		return `<tr>
      <td class="label">${esc(h.label)}</td>
      <td class="weekly-strip" colspan="${daysInMonth}">${weeks
				.map((w) => `<span class="wk ${w.done ? "ok" : "none"}" title="${w.key}">${w.done ? "✓" : "·"}<small>${w.label}</small></span>`)
				.join("")}</td>
      <td class="summary"></td>
    </tr>`;
	})
	.join("\n");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tracker — ${monthName}</title>
<style>
  :root { --ink:#1a1a1a; --muted:#8a8a8a; --line:#e4e4e4; --ok:#d9f2e0; --no:#fde3e3; --accent:#4a90d9; }
  * { box-sizing: border-box; }
  body { margin:0; padding:28px 20px 60px; font: 14px/1.45 system-ui, "Segoe UI", sans-serif; color:var(--ink); background:#fafafa; }
  .wrap { max-width: 1080px; margin:0 auto; }
  h1 { font-size:20px; margin:0 0 2px; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:32px 0 10px; }
  .muted { color:var(--muted); font-weight:400; }
  .grid { border-collapse:collapse; width:100%; background:#fff; border:1px solid var(--line); }
  .grid th, .grid td { border:1px solid var(--line); padding:3px 2px; text-align:center; font-size:12px; }
  .grid th { color:var(--muted); font-weight:600; }
  .grid th.dow { font-size:10px; border-bottom:none; color:#b5b5b5; }
  .grid td.label { text-align:left; padding-left:8px; min-width:150px; white-space:nowrap; }
  .c { width:20px; min-width:20px; }
  .c.ok { background:var(--ok); }
  .c.no { background:var(--no); color:#c05050; }
  .c.none { color:#ccc; }
  .today { outline:2px solid var(--accent); outline-offset:-2px; }
  td.summary { text-align:left; padding:2px 8px; min-width:130px; white-space:nowrap; }
  .bar { display:inline-block; vertical-align:middle; width:64px; height:8px; background:#ececec; border-radius:4px; overflow:hidden; margin:0 6px; }
  .fill { display:block; height:100%; background:#9cc3ea; max-width:100%; }
  .fill.good { background:#7fc79a; } .fill.mid { background:#e8c76a; } .fill.low { background:#e69a9a; }
  .pct { color:var(--muted); font-size:11px; }
  .weekly-strip { text-align:left; padding-left:10px; }
  .wk { display:inline-block; width:42px; text-align:center; margin-right:8px; border-radius:4px; padding:2px 0; }
  .wk.ok { background:var(--ok); }
  .wk.none { color:#ccc; }
  .wk small { display:block; font-size:10px; color:var(--muted); }
  .goal { background:#fff; border:1px solid var(--line); border-radius:6px; padding:12px 14px; margin-bottom:10px; }
  .goal-head { display:flex; justify-content:space-between; gap:12px; margin-bottom:2px; }
  .goal-head strong { font-weight:600; }
  .next { font-size:12px; color:#555; margin-top:6px; }
  footer { margin-top:36px; font-size:11px; color:var(--muted); }
</style>
</head>
<body>
<div class="wrap">
  <h1>Tracker</h1>
  <div class="muted">${monthName} · generated ${now.toISOString().slice(0, 16).replace("T", " ")}Z · source: ${esc(path.relative(HOME, DATA))}</div>

  <h2>Consistency</h2>
  <table class="grid">
    <tr><th class="label"></th>${dowCells.join("")}<th class="dow"></th></tr>
    <tr><th class="label">Habit</th>${headCells.join("")}<th class="dow">%</th></tr>
    ${rows}
    ${weeklyRows}
  </table>

  <h2>Goals</h2>
  ${goalCards}

  <footer>✓ done · ✗ missed · · no data. Managed by the tracker skill — do not edit the HTML.</footer>
</div>

</body>
</html>
`;

if (flag("--stdout")) {
	process.stdout.write(html);
} else {
	fs.mkdirSync(path.dirname(OUT), { recursive: true });
	fs.writeFileSync(OUT, html);
	process.stdout.write(`${OUT}\n`);
	if (flag("--open")) {
		try {
			execFileSync("xdg-open", [OUT], { stdio: "ignore" });
		} catch {
			/* viewer is optional */
		}
	}
}
