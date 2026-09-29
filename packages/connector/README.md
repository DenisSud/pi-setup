# @pi-bots/connector — core (S1)

The shared decision layer: which bots exist, which session a bot should open,
and where that choice is recorded. No pi imports, no transports, no UI. The
launcher (S2), the TUI patch (S3) and the web app (S4) all use this package.

## Model

A bot is an agent dir at `$PI_BOTS_HOME/<name>` (default `~/Bots`). A dir is a
bot when it has `settings.json` — the same rule as `pi-bot list`.

State root: `$PI_CONNECTOR_DIR` (default `~/.pi/bots`), machine-local.

```
~/.pi/bots/
  servers/             PI_SERVER_DIR shared by all bot servers (M0)
  routes/<bot>.json    { serverId, socketPath, pid, startedAt }  (launcher, S2)
  sessions/<bot>.json  { serverId, sessionId, updatedAt }        (clients, S1)
```

One file per bot per concern: each register is sharded by key, so updates to
different bots touch disjoint files and cannot overwrite each other. Writes
replace a file atomically (temp + rename); a reader sees the old or the new
file, never a torn one. Same-bot races are last-write-wins, which is exactly
the rule "the last attached session is the default".

`updatedAt` is informational. Ordering comes from the filesystem serializing
`rename()`, never from comparing wall clocks.

## API

```
listBots(): BotInfo[]                        // name, dir, hasRoute
readRoute(name): Route | undefined
writeRoute(name, route): void
clearRoute(name): void

readSession(name): SessionRef | undefined
recordAttached(name, ref): void
newSessionId(): string                       // crypto.randomUUID()
```

## Guarantees

- `recordAttached` is idempotent; once it returns, the calling process reads
  that value back. Nothing is promised about other processes.
- `resolveSession`-style reads never throw: missing, malformed or botless
  state reads as "no pointer". A pointer to a session that no longer exists is
  not an error — attaching with that id creates the session (`--session-id`
  semantics), so stale pointers self-heal.
- New session, in order: generate id -> record -> attach. If the process dies
  between record and attach, the next attach materializes exactly that
  session; the retry cannot create a second one.
- The pointer's `serverId` is informational. Attach uses the route's socket
  plus the pointer's `sessionId`; a server restart does not invalidate a
  session pointer, because sessions live in the bot's agent dir, not in the
  server. Verify this in S2.
- Clients never cache the pointer; it is read at attach time. A rendered view
  may lag, but the filesystem is the only copy, so nothing needs reconciling.

## Distributed system model

| Property | Value |
| --- | --- |
| Nodes | Client processes (TUI, web bridge) and one server process per bot, on one host today (pc or g14); multiple hosts at M5 |
| Network | Chord/RPC over unix sockets for the data plane; the state root is a shared filesystem for control |
| Temporal model | Asynchronous; no clock bounds. Wall clock is display-only |
| Faults | Crash-stop; no partitions today. M5 adds partitions between hosts, never between co-located processes |
| Topology | Single owner per bot: one server owns the session store; clients attach. No replication |
| Consistency | Control plane: linearizable per key via `rename()`. Data plane: upstream's single-writer harness with presentation attachments |

## Not doing (and why)

- **Vector clocks.** They exist to detect concurrent updates so a merge can
  respect causality. Our same-key conflict — two clients attaching different
  sessions to one bot — has no meaningful merge: one attach is the default, by
  definition. Causal metadata would add state with no decision to make.
- **FIFO-total-order broadcast / state machine replication.** There is no
  replica set. The state root lives on one host and `rename()` already totally
  orders writes to a file; cross-key updates are independent and commute. No
  client serves reads from replicated state, so there is nothing to replicate.
- **Anti-entropy / eventual consistency for client state.** Clients hold no
  authoritative state; every attach reads the pointer fresh.
- **Merging parallel writers in the event log.** One harness writes a
  session's event tree; extra attachments are presentations. Undo and fork are
  sequential tree operations upstream. If multi-agent parallel writes become a
  product need, that is an upstream Chord/services question, not ours.

Deferred to M5 (multi-host): reconnect and retry, prompt deduplication, auth.
Solve those with upstream mechanisms first.

## Layout

```
src/paths.ts     state root, env overrides
src/files.ts     atomic JSON read/write primitives
src/registry.ts  bot scan + route files
src/sessions.ts  per-bot session register
src/index.ts     re-exports
```

## Tests

`node --test test/*.test.ts` (Node strips types; no test deps). Each test
points `PI_CONNECTOR_DIR` and `PI_BOTS_HOME` at a temp dir.

## Open decisions

- `bots.yaml` (job text for the web UI) is not read here yet. A small parser
  or a dependency in S4, when the UI actually needs descriptions.
- "Last focused bot" is a global register, not a per-bot one; it gets its own
  file when a client needs it.

## Launcher (S2a)

`bin/pi-bot` becomes a thin shell script: resolve the repo root and
`exec node packages/connector/src/bin.ts "$@"`. All verbs live in TypeScript;
`list` is `listBots()`. `new` still delegates to `pi-bot-new`.

```
pi-bot attach <bot> [--new]   ensure server, resolve session, run the client
pi-bot message <bot> <text...> [--new]  send a prompt, print the reply
pi-bot compact <bot> [--new]            compact the bot's session
pi-bot stop <bot>                       stop the bot's server
pi-bot resolve <bot> [--new]  ensure server, print the ref (for the S3 fork)
pi-bot list [--json]          list bots (JSON for the TUI picker)
pi-bot new <name>
pi-bot <bot> [--new]          sugar for attach
```

There is no `serve` verb. A bot runs only as a server; the stock in-process TUI
path for bots is gone.

### Server runtime per bot

```
PI_SERVER_DIR  ~/.pi/bots/servers/<bot>
serverId       route's id if present, else crypto.randomUUID() (canonical v4)
socket         getUnixSocketPath(serverId, dir) from @earendil-works/pi-server/unix
sessions       <bot>/experimental/sessions (the server default with PI_CODING_AGENT_DIR set)
log            ~/.pi/bots/logs/<bot>.log (append)
checkout       $PI_SOURCE_DIR (default ~/dev/pi), pinned at 2b0a123d
```

Spawn (detached, `cwd` = bot dir):

```
node --import <file://…/src/experimental/source-resolver.ts> \
     <checkout>/packages/coding-agent/src/experimental/cli.ts server \
     --server-id <uuid>
env: PI_EXPERIMENTAL=1 PI_CODING_AGENT_DIR=<bot> PI_MEMORY_DIR=<bot>/memory \
     PI_SERVER_DIR=<dir>
stdio -> log fd, detached, unref
```

This is exactly the argv the checkout's `pi-test.sh` builds, minus the shell:
we call `node` directly so the pid in the route **is** the server process and
`stop` can signal it. `pi-test.sh` keeps a shell parent, so its pid would be the
shell's, not the server's. The server runs with `cwd` = the bot's agent dir, so
its sessions belong to the bot (`experimental/sessions/--home-…-Bots-<bot>--/…`);
stock pi tied sessions to the user's project directory instead.

Readiness: connect with `@earendil-works/pi-client` and its `/unix` transport,
which checks the protocol handshake, then dispose. Retry until 10 s; on timeout
SIGKILL the child and print the log tail. No stdout parsing. The published
client version and the source commit must match (handshake rejects mismatches);
that is the pin.

### Route and lock

`routes/<bot>.json` is written before the spawn with the chosen `serverId`, so a
concurrent launcher sees a pending route, and updated with `pid` and `startedAt`
after readiness. The listener unlinks stale sockets, so reusing a server id after
a crash is safe.

`~/.pi/bots/locks/<bot>.lock` is an `open(..., "wx")` lock holding a pid. Stale
(dead pid or older than 30 s) locks are removed and retried. It is held only
across spawn and readiness.

### Attach flow

1. `readRoute`; if the client can connect to the socket, use it.
2. Else take the lock, re-read the route, then generate or reuse the server id,
   write the route, spawn, wait for readiness, release the lock.
3. `sessionId` = the pointer's, or `newSessionId()` when `--new`.
4. `recordAttached` (record-then-attach), then run the checkout's client with
   inherited stdio and exit with its status:

```
<checkout>/pi-test.sh client --connect unix://<socket> --session-id <id>
```

`resolve` prints `<bot>\t<sessionId>\t<socketPath>`, or `{ bot, dir, serverId,
socketPath, sessionId }` as JSON with `--json`.

### Launcher files

```
src/lock.ts      O_EXCL lock with stale takeover
src/launcher.ts  ensure server, readiness probe, attach resolution
src/bin.ts       verb dispatch
```

### message, compact, stop (S2b)

`message <bot> <text...>` runs the client headless with the text as the prompt
(the CLI's own rule: a prompt forces headless, no prompt plus a TTY runs the
TUI). It streams `text_delta` output to stdout and exits with the client's
status; `--new` picks a fresh session first. The text is passed after `--`, so
it may start with `-`.

`compact <bot>` runs the same headless client with `--compact`, which is our
first fork patch (`585a74804` on the fork's `dev` branch): attach, call
`AgentController.compact` with no custom instructions, print
`<serverId>\t<sessionId>\tcompacted`.

`stop <bot>` reads the route, verifies with `/proc/<pid>/environ` that the pid
still belongs to this bot's server (`PI_SERVER_DIR` and `PI_CODING_AGENT_DIR`
match), sends SIGTERM, escalates to SIGKILL after 3 s, then clears the route.
The server rewrites its process title to `pi`, so `cmdline` is useless for the
identity check; the environment is not, which also protects against a recycled
pid.

## TUI fork (S3)

The experimental client TUI gets two commands and a way to restart against a
different server. All of it lives in the fork (`dev` branch); the launcher only
passes two extra environment variables.

### Switch mechanism: in-process restart

`runClientTui` is patched to return an optional switch target. A wrapper
(`runBotsClientTui`) loops:

```
run TUI ──switch target──> dispose runtime ──> open runtime for target ──> run TUI
```

Each iteration stops the TUI, disposes the client runtime and facets, and calls
`runClientTui` again with a rewritten command (`--connect unix://<socket>`,
`--session-id <id>`). The loop also rewrites `PI_BOT_NAME`, `PI_CODING_AGENT_DIR`,
`PI_MEMORY_DIR`, and `PI_SERVER_DIR` for the new bot, so the next TUI reads the
right settings, theme, and agent dir. No process exec, no process chain, and the
teardown path is the one the TUI already uses when the user quits.

A switch target comes from `pi-bot resolve --json [--new] <bot>` — the same
process boundary the launcher uses, so the fork never reads the state files or
reimplements any policy. Subprocess calls block the UI for ~100 ms; the status
line shows "Switching to <bot>…" while it runs.

### Commands

- `/bot` opens the picker over `pi-bot list --json` (`[{ name, dir, hasRoute }]`),
  marking the current bot and whether its server is running. `/bot <name>`
  switches directly. Both attach the target bot's default session (the pointer),
  exactly like `pi-bot attach`.
- `/new` creates a fresh session on the current bot: `pi-bot resolve --json --new
  <current>` records the pointer before attaching, so a crash between the two
  never forks a session.
- Switching while a turn is running is safe: the turn continues on the server;
  the TUI just detaches. Attaching later shows it again.

### Environment contract

The launcher adds two variables to the client env:

```
PI_BOT_NAME  the bot this client was started for (the current bot)
PI_BOT_BIN   absolute path to bin/pi-bot
```

Without `PI_BOT_NAME` (fork client started by hand) `/bot` still works; `/new`
reports that it needs a launcher-started client.

### Fork files touched

```
experimental/client-tui.ts            /bot, /new, switch target, footer bot name
experimental/bots/client-loop.ts      restart loop (new file)
experimental/commands.ts              call the loop instead of runClientTui
```

### pi-bots changes

`pi-bot list --json` prints the registry as JSON for the picker; `runClient`
passes `PI_BOT_NAME` / `PI_BOT_BIN`. No new state, no new policy.

## Web client (S4)

Status: M4.1–M4.4 done (`b02298c`, `ae3fd35`, `dc21fb0`, plus the rendering
pass). This is the first client that shares the backend with the TUI instead
of forking it.

### Shape

```
browser  --WebSocket (binary)-->  bridge (node)  --unix socket-->  pi server
pi-client + WebSocket byte transport   opaque byte relay + static files
```

- The wire format is framed CBOR over an ordered byte stream
  (`ByteTransport` in `pi-client`). The bridge never parses it: one browser
  WebSocket carries one session's byte stream, chunks pass through unchanged.
- One process serves the app and the relay, so the browser gets a single
  origin and no CORS.
- Browser app (`packages/web`): plain TS, one esbuild bundle. It imports the
  coding-agent service facades through `@pi/fork/experimental/services/*`,
  which `build.mjs` maps to the pi checkout; the pi packages map to the built
  copies this repo depends on. One WebSocket per session is wrapped as a
  `ByteTransportFactory` (binary frames, `onData`/`onClose`/`onError`).

### Bridge

`bin/pi-bots-web [--host <host>] [--port <port>] [--web-dir <path>]`
(default `127.0.0.1:8787`, web root `packages/web/dist`).

- `GET /api/bots` → `{bots: [{name, dir, running, serverId, pid, startedAt,
  lastSession}]}`. Reads the state files only; it never starts a server.
- `GET /ws?bot=<name>[&session=<uuid>]` → 101 upgrade, then the bot server's
  byte stream. Resolving the target runs the launcher, so a stopped bot gets
  started. Rejections: 400 invalid bot or session, 502 launcher failure.
- Static files under the web root; path escapes are rejected, and a missing
  build answers 503 with the build command.
- Text frames close the channel; the transport carries bytes only.
- Backpressure: the upstream socket pauses while a ws frame is buffered and
  resumes from the send callback; the ws reader pauses while the unix socket
  write buffer is full.

### App

```
bun install                      # once, from the repo root
bun run build                    # bundle the browser app to packages/web/dist
bun run test                     # connector tests
bin/pi-bots-web                  # serve app, /api/bots, and /ws
```

The app lists bots (blobatar icon per name), opens the last session or a new
one, and renders the replicated transcript through AgentController. Session
actions: stop aborts the open operation, compact summarizes the history while
idle, new starts a fresh session. The prompt and the sidebar busy marker
follow the snapshot's operation, so they are right for every turn.

Rendering, in the order a turn produces it:

- Assistant text is markdown (marked, with raw HTML dropped and links
  rewritten), user text is plain in a gray bubble.
- Thinking is a collapsed step line. A turn with nothing to show yet prints
  an animated `thinking` line from the snapshot, not a placeholder kept in
  the DOM.
- A tool call is one compact `bash: <command>`-style line, with its arguments
  and its result nested in the same `<details>`; a running tool shows a
  spinner from `operation.runningTools`.
- Entries are appended, never rebuilt: opening a `<details>` survives the
  next snapshot, new entries fade in, and the streaming answer's caret keeps
  blinking because only its text node is updated. Compaction and session
  switches rebuild, because the transcript is replaced.
- The reader is followed only while they are at the bottom; scrolling away
  reveals a `↓ latest` button.
- While a turn runs the composer sends a steer, and the pending message shows
  as a `steering` bubble from the snapshot's `queues`; stop hands the queued
  text back to the composer.

The look follows the Grok Bot app (flaviocopes.com/grok-bot): light surfaces,
system sans font, blobatar avatars, gray pills, right-aligned user bubbles,
plain assistant text, tool results as gray panels, centered system notes.
The header blobatar is the live one: it breathes on hover and its eyes follow
the pointer (`blobatar/gaze`); the list icons are the same blobatars without a
gaze driver.

Known gaps: no reconnect (a dropped bridge socket needs a manual reload), no
session picker beyond the last session, no diff rendering in tool results,
and no turn grouping (`Worked for 2m · 5 steps`). Package installs use bun;
the connector and the pi runtime still execute on node.

### Milestones

- M4.1 bridge (done): bot list + WS relay; unit tests with a fake upstream and
  one live prompt through the bridge to a real bot.
- M4.2 app (done): bot picker, session open, prompt, streamed transcript;
  verified in Chromium against a real bot.
- M4.3 verbs (done): stop, compact, new in the session bar, plus the busy
  state in the sidebar and the prompt. Same smoke covers abort during a
  running tool call and compaction.
- M4.4 rendering (done): markdown answers, compact tool steps with nested
  results, a spinner for a running tool, a thinking line, steer-while-busy
  with a queued bubble, abort restoring the queued text, blobatar icons, and
  append-only transcript updates so nothing flickers or closes.

### Out of scope (M5)

Auth, remote access (Radius relay), reconnect/replay, systemd units.

### Open questions

- Browser smoke test: a Chromium smoke script exists outside the repo
  (nixpkgs chromium + playwright-core, `CHROMIUM_PATH`); promote it here if
  M4.3 changes need regression.
- Typed Chord service bindings in the browser vs a JSON convenience API on
  the bridge. Settled: bindings, bundled from the fork source.
- `bots.yaml` descriptions are still unread; the UI may want them here.
