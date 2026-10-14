---
name: daily-planning
description: Process Denis's morning brain dump into a time-blocked day — triage today's tasks, block them with the +20% buffer, anchor the routine around fixed commitments, write the blocks to the calendar, and write the morning brief. Use when Denis sends a brain dump or to-do dump, says "plan my day"/"let's plan today", asks what to do today, or wants the rest of the day re-planned.
---

# Daily Planning

The morning loop. Denis brain-dumps over breakfast; this turns the
dump into a realistic, time-blocked day on his calendar.

Denis decides *what* gets done; you decide *when* and *how long*. The plan is
flexible: times are proposals, the day-card's outcomes are the commitment —
Denis may reorder the day freely, and only the day-card's listed outcomes are
fixed. Where a fact is missing (date with Tanya tonight?), ask —
one question at a time, each with a proposed answer, not a questionnaire.

## State

- `~/Documents/Notes/personal/daily-routine.md` — anchors, caps, defaults.
  Single source of truth for the day's shape. Durable anchors: **wake 09:00,
  wind-down 23:00 (bed 00:00)** — build every plan around them; treat them as
  priority commitments, not preferences.
- `~/Documents/Notes/personal/backlog.md` — week/month/year/someday tasks.
  Today lives on the calendar, not here.
- `~/Documents/Notes/education/academic-plan.md` — the study strategy: a
  **majors** table (18.01 / 18.06 / 18.02) plus a **minors** table of light
  tracks (e.g. CS146S). The weekly/monthly layer decides what slice lands this
  week.
- `~/Documents/Notes/personal/daily briefs/YYYY-MM-DD.md` — the morning brief,
  the day in prose. That folder is the **only** brief output; there is no
  `today.md` mirror.
- **Gym is external.** Sessions live in opengym (gym.sudakov.site), never on
  the calendar — do not book gym blocks, and only plan around a session when
  Denis says one is happening.
- Today's events via `calendar_list_events` — fixed commitments already booked.
  Days may already carry an **all-day day-card** (from the weekly review)
  naming the day's work — cut it into timed blocks instead of re-triaging
  from scratch.

## Steps

1. **Load.** Read the routine, the backlog, the current week of
   `education/academic-plan.md` (majors rows + a minor slot, if one lands this
   week), and today's calendar events — including any **prep window**
   (deadline track) covering today. Done when you can name every fixed
   commitment today, the anchors around them, and which deadline tracks are
   active.

2. **Capture the brain dump.** Any form is fine: chat text, a photo of
   handwriting (RU/EN mixed is normal), a pasted list. Sort every item — *today
   candidate*, *backlog* (right horizon), or *dated* (offer a calendar event).
   Done when every dump item has landed somewhere.

3. **Reconcile yesterday.** List yesterday's task and Productivity blocks — not
   routine blocks — and ask what actually got done. Return unfinished tasks to
   the backlog's week list. One compact question, not one-by-one.

   The system must survive without the agent: Denis plans mornings manually
   when the day is obvious. If today's calendar/brief already exists, cut the
   day-card as usual; if the plan was made by hand, reconcile against what is
   on the calendar, do not re-plan from scratch.

4. **Triage today.** Candidates are the week list plus anything an active prep
   window still needs — read the window's checklist and ask what is already
   done. An active deadline track outranks backlog wants. Name each active
   goal in one line (the education plan's majors row and any minor slot are
   goals too) and whether today can move one. He picks; never silently
   take a task. Done when today's task list is agreed.

5. **Decompose, estimate, block.** An umbrella task ("prepare for admissions",
   "work on the beta") is not a block — first list the concrete actions that
   move it forward until each is small enough to finish in one sitting, then
   estimate them, add the **+20% buffer**, and round up to 5 minutes.
   - Focus work → its own block, titled for the action being finished, not the
     project it belongs to.
   - Small menial items (messages, admin, errands) → one **Productivity**
     block, estimates summed.
   - Order by energy fit — hardest work first, menial later — not list order.
   - What doesn't fit the day stays open for the next one.

6. **Anchor the day.** Lay the routine around the blocks and fixed commitments:
   wake 09:00, breakfast, wind-down 23:00, scroll breaks where needed.
   Lunch/dinner only when they're with someone. Check the coming
   days for the weekly nicer date with Tanya (baseline 3 casual + 1 nicer);
   propose one if missing. Done when every hour from wake to wind-down is
   either a block, a commitment, or deliberately empty — including the
   wind-down block itself, which is a real block, not an intention.

7. **Check the fit.** Compare the blocks to the hours actually left. On
   overflow, name it and propose what to cut or push to the week list — never
   stack two blocks on one slot. He decides.

8. **Confirm, then write.** Show the drafted day (blocks + anchor times); write
   the events with `calendar_create_event` once he approves, or immediately if
   he said "just write it". Use Moscow time on a 5-minute grid. Routine blocks
   carry no reminder; task, Productivity, social, and scroll blocks get one 10
   minutes before; dates get 60; anything needing prep gets a 1-week alarm.
   **Every event gets a reminder.** On a re-run, update today's existing
   blocks instead of duplicating them. Done when every drafted block exists on
   the calendar.

9. **Write the morning brief.** Two outputs: the calendar *and* the brief. Write
   `~/Documents/Notes/personal/daily briefs/YYYY-MM-DD.md` — that folder is the
   only destination, there is no `today.md` mirror. This is the page Denis
   re-reads during the day — free-form, human, not a schedule table (the
   calendar holds the times). Lead with what matters:
   - the day's one thing (at most two) and why it matters;
   - the shape: blocks and commitments in order, one line each;
   - watch-outs: tight transitions, dependencies, deadlines, energy notes;
   - what was deliberately pushed, and where it landed;
   - one line per active goal: does today move it;
   - anything from the dump worth re-reading (links, addresses, numbers).
   Under ~40 lines, no filler. On a re-run, overwrite the same dated file; the
   brief always matches the latest approved plan.

## Re-planning

When the day breaks — a block runs long, something appears — re-run steps 5–10
for the hours that are left. Leave past blocks alone, and refresh the brief so
it matches.
