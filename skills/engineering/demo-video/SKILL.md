---
name: demo-video
description: Record a click-through demo of a built UI and publish it for a pull request. Use from full-send when a change alters what a user sees, as an end-to-end proof and a review aid.
---

# Demo video

A pull request that changes what a user sees carries a recording of that surface
working. The recording is both the end-to-end proof (a real browser, a real
server, real requests) and the reviewer's tour. It is a check on the change,
not a marketing clip.

Run it as a child: `demo-recorder` is the profile (`agents/demo-recorder.md`),
`thinking: low` is enough, and the child needs `agent-browser` plus `bash`. Do
not do this in the parent's context: the browser output is large, and the
parent has the diff in its head already.

## When

Run it when the diff changes a screen a person looks at: layout, a flow, a form,
a table, navigation, empty and error states, motion.

Skip it, and say one line about why in the PR body, when:

- the change is backend, docs, CI, or tests only;
- the diff has no visible effect (a rename, a type, a dead rule);
- the app cannot be driven headlessly here (no credentials, a native-only
  surface). Report that as a finding; never fake a recording.

## Inputs the parent passes

The child starts fresh, so the task carries all of it:

- absolute repo path and branch;
- the exact command that serves the built interface, and the port;
- the demo accounts (`README.md` has them; they are synthetic);
- three to five user-visible changes to show, in review order, each with the
  screen and the action;
- the PR number, or `none yet`.

## Recipe

Everything for one recording runs in a single shell: `agent-browser` holds the
browser for the length of one command, and a session does not survive to the
next call.

```bash
# 1. Serve the build the PR carries. Throwaway database, own port.
cd <repo> && LINKERS_DB=/tmp/demo-<slug>.db PORT=<free port> <run command> &
sleep 3 && curl -sf http://127.0.0.1:<port>/api/health

# 2. Record. Browser first, then recording, then the flow.
export AGENT_BROWSER_SESSION=demo-<slug>
agent-browser open http://127.0.0.1:<port>
agent-browser set viewport 1280 800
agent-browser wait '<a selector the login form has>'
agent-browser record start /tmp/demo-<slug>/raw.webm
sleep 1
agent-browser fill '<email selector>' '<demo email>'
agent-browser fill '<password selector>' '<demo password>'
agent-browser find text 'Войти' click
sleep 2
# ... the steps, each with a 1.5-2 s pause after it lands
agent-browser record stop

# 3. Publish: mp4 and gif, then upload.
<skill dir>/scripts/publish.sh /tmp/demo-<slug>/raw.webm <repo>-pr<number>-<sha8>

# 4. Tear down.
kill %1
```

Notes that save a second take:

- `agent-browser` prints an accessibility snapshot; click by `@ref` from a fresh
  `snapshot -i`, by text with `find text '<label>' click`, or by
  `eval '[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "…").click()'`.
  Refs die on navigation.
- Wait for the screen, not for the clock: `agent-browser wait '<selector>'`
  before clicking into it.
- Leave a beat after each action. A GIF at 12 fps turns a 300 ms jump into two
  frames, and the reviewer cannot follow it.
- 30 to 60 seconds is the length. One flow, no scrolling for its own sake.
- The server prints the demo accounts on first boot; never record a real
  database or a real token.
- `agent-browser console` and `agent-browser errors` before the stop: an error
  in the recording is a finding for the parent.

## Publishing

`scripts/publish.sh` writes an h264 mp4 and a 960px GIF, copies both to the
artifact host, checks the public URL, and prints the markdown block:

```
![demo](https://artifacts.sudakov.site/<slug>.gif)

[full quality mp4](https://artifacts.sudakov.site/<slug>.mp4) (1.2 MB)
```

The host is `pi:/srv/artifacts`, served by caddy at `artifacts.sudakov.site`
with a one-year cache and the right content type (see the caddy block for that
host). GitHub renders the GIF inline and the mp4 as a link. The host is public:
the recording shows a demo cohort, nothing real.

Keep the GIF under 6 MB. Over that, `publish.sh` retries at 800px and 10 fps; if
it still overshoots, shorten the flow rather than shrink it further.

## What the child returns

```
Recorded: <what was shown, in one line>
Length: <n> s, gif <n> MB, mp4 <n> MB
Markdown:
<the block from publish.sh>
Findings: <console errors, a step that would not work, or none>
```

If a step cannot be driven, that is the finding. Do not record around it, and
do not report a passing demo for a surface that failed. The parent puts the
markdown under `Evidence` in the PR body and reports the findings.

## Retention

Files accumulate on the pi, one gif and one mp4 per PR, a few MB each. They are
permanent references from merged PRs, so prune by age, not by hand:

```bash
ssh pi 'find /srv/artifacts -type f -mtime +180 -print'
```

Delete only what the listing shows, and only when the PR is closed or merged.
