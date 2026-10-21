# Configuration

Everything this package reads at runtime lives in the agent directory
(`~/.pi/agent` by default, `PI_CODING_AGENT_DIR` moves it). The package
directory itself holds code only — pi cleans it on update, so a config file next
to the source would be deleted.

## The convention

One file per concern, the same shape pi uses for `settings.json`, `mcp.json`,
`models.json` and `auth.json`:

| file | owner | contents |
|---|---|---|
| `env.json` | `env` extension | environment variables: service keys, passwords, anything the shell needs |
| `mem0.json` | `mem0` extension | server URL and memory behaviour |
| `gmail.json` | `gmail` extension | address and IMAP connection facts |
| `calendar.json` | `calendar` extension | CalDAV URL, collection, credential variable names |
| `settings.json` | pi | model, theme, packages. Extensions do not add keys here. |
| `auth.json` | pi | provider API keys and OAuth tokens — written by `/login` and `pi auth`; extensions never touch it |
| `mcp-auth.json` | pi | MCP OAuth tokens |

Not a file: `PI_TOOL_EXPOSURE` (below) is read from the environment by every
extension through `lib/exposure.ts`.

Extensions never import each other's config module, and they never read each
other's file. What two extensions share — the credential variables — lives in
`env.json`, the one file both the extensions and the shell read.

## Credentials

`env.json` is a flat JSON object injected into the pi process at startup, so
every `bash` command inherits it and every extension can read it with
`process.env`:

```json
{
  "JELLYFIN_API_KEY": "…",
  "RADICALE_USER": "denis",
  "RADICALE_AGENT_USER": "agent",
  "RADICALE_AGENT_PASSWORD": "…",
  "COUCHDB_USER": "${USER}"
}
```

- `${VAR}` and `${VAR:-fallback}` interpolate the ambient environment.
- Numbers and booleans are coerced to strings; objects and arrays are skipped
  with a warning, as are names bash cannot reference and values that resolve to
  empty.
- Keep the file mode 600. A file any other user can read produces a warning at
  session start; everything else about it is silent.
- `PI_ENV_CONFIG` points the `env` extension at another file.
- `/env` lists the loaded variable **names** (never values) — the one safe way
  to check what is available in a session.
- `/reload` re-reads the file: added and changed variables apply, removed ones
  linger in `process.env` until pi restarts.

**Adding a secret** (the whole procedure):

1. Put the value in `env.json` under an `UPPER_SNAKE` name.
2. Reference the name from the consumer: `passwordVar`/`userVar` in
   `calendar.json`, `passwordVar` in `gmail.json`, `apiKeyVar` in
   `mem0.json`, or `$NAME` in a bash command.
3. `/reload` (or restart pi) and check with `/env`, or run the extension's
   harness `live` variant.

The names are a single flat namespace, so two different values cannot share a
name. That is why the calendar's agent credentials are `RADICALE_AGENT_USER` and
`RADICALE_AGENT_PASSWORD` while Denis's own pair stays `RADICALE_USER` /
`RADICALE_PASSWORD` (`docs/design-notes.md` has the history).

Values are per device and are not in git. Bitwarden (folder `pi`) holds the
originals, and `~/.pi/agent/security.json.retired` lists which item each
variable came from.

## Tool exposure

`PI_TOOL_EXPOSURE` decides how much of each tool this package registers the
model sees. `lib/exposure.ts` reads it; unset means `direct`, which is pi's
own default.

| value | effect |
|---|---|
| `direct` | declared in every request: description and guidelines are prompt cost |
| `codemode` | callable as `tools.<name>(…)` in a script, listed in the codemode description |
| `deferred` | callable from a script, not listed anywhere; `searchTools()`/`ALL_TOOLS` find it |
| `hidden` | registered and unreachable |

It is one variable rather than a key in each extension's config file because it
is a property of the whole session: the [minimal profile](minimal.md) runs every
tool the same way, and one value cannot drift across four files. Service
settings stay in `gmail.json`, `calendar.json` and `mem0.json`.

A new tool in this package passes `exposure: toolExposure()`. A tool that
activates itself with `pi.setActiveTools()` must skip that when the exposure is
not `direct`, or it declares itself anyway (`extensions/mem0` does this).

## Extension files in detail

- `mem0.json` — every key is documented in
  [extensions/mem0/README.md](../extensions/mem0/README.md#configuration). The
  file is optional: on the fleet, `MEM0_BASE_URL`, `MEM0_API_KEY` and friends
  come from the environment instead.
- `gmail.json` — `username` (required) plus optional `host`, `port` (default
  `imap.gmail.com:993`), `passwordVar` (default `GMAIL_APP_PASSWORD`),
  `auditLog`, `maxBodyChars`, `attachmentDir`. `GMAIL_CONFIG` overrides the path.
- `calendar.json` — optional throughout: `baseUrl` (default
  `https://cal.sudakov.site`), `collection` (default `/denis/main/`), `userVar` /
  `passwordVar` (default the `RADICALE_AGENT_*` pair), `timezone` (default
  `Europe/Moscow`), `auditLog`. `CALENDAR_CONFIG` overrides the path.

A missing variable is reported by the consumer with the exact name to add to
`env.json` (`lib/credentials.ts`); a malformed file is reported when the
extension initialises.
