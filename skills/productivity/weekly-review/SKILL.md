---
name: weekly-review
description: Sunday-evening review — reconcile the week (planned vs done), check every goal, build next week's list, prune the backlog, and propose skill/automation upgrades. Use when Denis says "weekly review", "Sunday review", or it is Sunday evening and the review has not run.
---

# Weekly Review

Sunday evening, manager-led. You do the mechanics; goals and kills are Denis's
calls. Keep it to ~20 minutes of his time: lead with proposals, not questions.
One question at a time, each with a suggested answer.

## State

- `~/Documents/Notes/personal/backlog.md` — week/month/year/someday tasks.
- `~/Documents/Notes/personal/tracker.json` — habits, goals, review dates
  (see the `tracker` skill).
- `~/Documents/Notes/personal/daily-routine.md` — the day's shape.
- `~/Documents/Notes/personal/briefs/` — the week's morning briefs (the planned
  side of the week).
- Last week's calendar events via `calendar_list_events`.
- Days since the last entry in `tracker.reviews`.

## Steps

1. **Load.** Pull the backlog, the tracker, and last week's calendar events.
   Note the last review date. Done when you can name each active goal, the open
   prep windows, and the week's fixed commitments.

2. **Reconcile the week.** Compare what was planned with what happened: tracker
   flags, calendar blocks, backlog ticks, the week's briefs. Name each miss in
   one line — no ceremony, no blame. Return unfinished tasks to the week list.

3. **Score the goals.** For every goal in the tracker: one line — *moved*,
   *stalled*, or *done*. For a stalled goal, propose the single next concrete
   step; for a dead one, propose killing it or parking it. Changing, killing,
   or setting a goal is Denis's call; update `progress` and `next` after he
   decides.

4. **Build next week.** Draft next week's list from the backlog horizons and
   the active prep windows. Respect the standing shape: deep academic blocks
   ×6 (3–4 h: math course first, LeetCode evening blocks), German 30–45 min
   daily inside blocks, gym 3–4 evening sessions (hard cap 4), one admin
   block, one job/scan block as needed, deload week every 5th (1–2 h,
   review-only — lighter days, same shape). **Book each day as an all-day
   day-card** naming the day's work — no times; times are cut in the morning
   plan. Times are only fixed now for true fixed commitments. Overload gets
   named with a proposed cut, never silently accepted.

   **Planning ladder:** the monthly planning event (1st of month, populated by
   the last Sunday review of the prior month) states what the month owns and
   distributes it to weeks; the weekly review distributes the month to the
   week and books day-cards; the morning plan cuts the day-card into timed
   blocks. Brain dumps stay in the morning — the ladder decides *what*, the
   morning decides *when in the day*.

   **Prep windows:** an all-day prep window for a deadline appears on the
   calendar only in the last 2–3 weeks before the deadline, opened here.
   Until then the deadline event + backlog is all he sees — no long multi-day
   all-day blobs.

5. **Prune.** A task that has slipped 3+ days gets split or killed — propose
   which. Remove dead weight and tasks that stopped mattering.

6. **Signals.** One compact readout, from the tracker: deep blocks, gym,
   scroll cap, reviews completed, menial tasks the agent took over. Compare to
   last week; flag the trend, not the absolute.

7. **Upgrade proposals.** Anything repeated during the week is a candidate for
   the self-improvement ladder (task → skill → automation) — propose at most
   two, name the trigger and the payoff, and apply only what he approves.

8. **Write.** Update the tracker (`reviews`, goals — the dashboard shows them
   live; goals render as a plain list, no progress bars), populate next
   month's planning event if this is the month's last Sunday, write the
   backlog, and apply any approved task/skill changes. End with a one-line
   summary of the week and the first thing Monday should move.
