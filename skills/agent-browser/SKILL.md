---
name: agent-browser
description: Drive a real browser from the terminal — the way to read a page that plain curl cannot. Use when a page needs JavaScript to render (curl returns an empty shell), when the task needs interaction (clicking, filling forms, logging in, downloading), or when you need screenshots, accessibility/DOM inspection, console or network capture, or to test a web app. Complements web_search (source discovery) and curl (static HTML/JSON) — reach for the browser when the page must actually run or be driven.
---

# agent-browser

Fast native Rust browser-automation CLI: Chrome/Chromium over CDP, with
accessibility-tree snapshots and compact `@eN` element refs instead of raw DOM.

Provided by the NixOS config (`agent-browser` + `chromium`), so the CLI finds a
declared browser on `PATH` and needs no `agent-browser install` download. On a
machine without it: `npm i -g agent-browser && agent-browser install`.

## Before running any command, load the guide

This skill is a pointer, so the guidance always matches the installed version:

```bash
agent-browser skills get core          # the workflow content — start here
agent-browser skills get core --full   # plus the full command reference
agent-browser skills list              # specialized guides
agent-browser skills get <name>        # e.g. dogfood, electron, slack, derive-client
```

`agent-browser --help` lists every command.
