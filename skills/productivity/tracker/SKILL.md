---
name: tracker
description: Maintain and render Denis's productivity tracker — habit flags, goals with progress, and the visual consistency page. Use when recording daily habit actuals, setting or scoring goals, or when Denis asks to see/refresh the tracker.
---

# Tracker

The visual feedback layer: a habit-consistency grid and a goals list,
generated from one JSON file. Denis views the page; the agent maintains the
data — he should never have to edit tracker.json or manage the page himself.
Never edit the generated HTML.

- Data: `~/Documents/Notes/personal/tracker.json`
- Page: `http://localhost:8787/tracker` (`http://192.168.1.10:8787` from the LAN
  once the firewall allows it) — the dashboard app (`~/dev/dashboard`, systemd
  user unit `pi-dashboard`) renders it live from the JSON on every request,
  so writing the JSON is enough. Briefs are at `/` and `/briefs`.
- Standalone file (optional): `node
  ~/.pi/agent/packages/productivity/skills/tracker/render.mjs` (`--open` opens
  it, `--month YYYY-MM` renders another month).

## Data format

```json
{
  "version": 1,
  "habits": [
    { "id": "wake", "label": "Wake by 09:00", "kind": "daily" },
    { "id": "gym", "label": "Gym", "kind": "count", "target": 3, "period": "week" },
    { "id": "review", "label": "Sunday review", "kind": "weekly" }
  ],
  "days": { "2026-10-03": { "wake": true, "gym": false } },
  "reviews": ["2026-10-04"],
  "goals": [
    { "id": "uni", "title": "...", "target": "2027-09-01", "progress": 20, "next": "..." }
  ]
}
```

- `days` keys are `YYYY-MM-DD`; only store days with at least one flag.
- `true` = done, `false` = explicitly missed, absent = no data.
- `progress` is 0–100, set only at weekly reviews (rendered nowhere — the
  Goals page is a plain list: title, target + days left, "Next" step).
- `next` is the single concrete next step.
- `reviews` holds the dates of completed Sunday reviews.

### Rendering rules (render.mjs)

- Daily habits: percent = flagged-true ÷ days elapsed this month.
- Count habits (gym): rolling 7-day window ending today — done = sessions in
  that window, denominator = the week target verbatim; percent may exceed
  100 (bar clamps, number doesn't). No month-proration.
- Weekly habits (Sunday review): strip shows the rendered month's weeks
  (Monday-based, Sunday-dated) only — no neighboring-month labels.
- All events have reminders: 10 min for work/social, 1 day for dates and
  results, 1 week before anything needing prep.

## Rules

- Mark only what is evidenced — Denis's answers, the calendar, the planning
  loop. Never invent a flag.
- The agent owns the data end-to-end: during morning planning, reconcile
  yesterday's flags by asking (one compact question: wake, deep, gym, scroll,
  personal time, wind-down) and write them; during the weekly review, score
  `goals`, append to `reviews`. Denis answers questions and views the page —
  he has no edit path at all (the UI is read-only).
- Casual brain-dump mentions of habits ("gym was great", "slept badly") are
  flag-worthy — write them immediately, same turn.
- Discrepancies beat silence: if the calendar says gym but Denis's day says
  otherwise, ask directly — do not silently pick one.
- Adding, removing, or renaming a habit or goal is Denis's call; propose, ask,
  then do.
- After any change, no render step is needed — the dashboard reads the JSON
  live; just say what changed.
