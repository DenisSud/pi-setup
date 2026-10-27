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
| `gmail.json` | `gmail` extension | address and IMAP connection facts |
| `calendar.json` | `calendar` extension | CalDAV URL, collection, credential variable names |
| `web-search.json` | `pi-web-access` (npm) | search provider order, fallback kinds, the local SearXNG endpoint |
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
   `calendar.json`, `passwordVar` in `gmail.json`, or `$NAME` in a bash command.
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
model sees. `lib/exposure.ts` reads it; unset means `deferred`, so the tools
stay out of the request unless a session asks otherwise.

| value | effect |
|---|---|
| `direct` | declared in every request: description and guidelines are prompt cost (pi's own default) |
| `codemode` | callable as `tools.<name>(…)` in a script, listed in the codemode description |
| `deferred` | callable from a script, not listed anywhere; `searchTools()`/`ALL_TOOLS` find it — **the default** |
| `hidden` | registered and unreachable |

It is one variable rather than a key in each extension's config file because it
is a property of the whole session: every tool in this package ships
deferred, and one value cannot drift across four files. Service settings stay
in `gmail.json` and `calendar.json`.

A new tool in this package passes `exposure: toolExposure()`. A tool that
activates itself with `pi.setActiveTools()` must skip that when the exposure is
not `direct`, or it declares itself anyway.

`web_search` is not in this package, so it does not read `PI_TOOL_EXPOSURE`.
`pi-web-access` has its own switch, `toolExposure` in `web-search.json`
(`direct` or `deferred`), and it ships as `deferred` to match.

## Search

`web_search` belongs to the npm package `pi-web-access`, not to a directory in
`extensions/`. It ships Exa first and the local SearXNG second, so a dead Exa
becomes a slower answer instead of a failed one. `~/.pi/agent/web-search.json`:

```json
{
  "searxngBaseUrl": "http://127.0.0.1:8888",
  "toolExposure": "deferred",
  "searchRouting": {
    "providers": ["exa", "searxng"],
    "fallbackOn": ["network", "transient", "quota", "invalid-response"]
  }
}
```

- Do not add `provider` or `searchProvider`: a single-provider field takes
  precedence over `searchRouting` and the fallback disappears.
- **Set an Exa key.** `EXA_API_KEY` in `env.json` (or `exaApiKey` here) sends
  search to `api.exa.ai` with the key in a header. Without one it goes through
  Exa's hosted MCP at `mcp.exa.ai`, which needs no credentials but sits behind
  Cloudflare: it answered from this machine, then returned 403 "You are unable
  to access" for the same exit IP a few calls later. A 403 classifies as `auth`,
  and `fallbackOn` cannot list `auth`, so keyless Exa fails the search instead
  of falling back. The key lifts the MCP's per-IP limit and unlocks the date
  filters too.
- `fallbackOn` has no `aborted` kind, so an Exa request that hangs until its 60s
  budget fails the search instead of falling through. Everything else falls
  through: connection failures, 429s, 5xx and unparseable responses.
- A call can override the route: `web_search({ query, provider: "searxng" })`.
- `category: "company"` / `"people"` is the lead lookup; other providers ignore
  it, so force `provider: "exa"` when the category matters.

`PI_CODING_AGENT_DIR` moves the file with the rest of the agent directory.

## Extension files in detail

- `gmail.json` — `username` (required) plus optional `host`, `port` (default
  `imap.gmail.com:993`), `passwordVar` (default `GMAIL_APP_PASSWORD`),
  `auditLog`, `maxBodyChars`, `attachmentDir`. `GMAIL_CONFIG` overrides the path.
- `ocr.json` — optional throughout: `command` (default `indra-ocr`), `timeoutMs`
  (default 300000), `maxChars` (default 20000), `artifactDir` (default
  `~/.pi/agent/tmp/ocr`). `OCR_CONFIG` overrides the path.
- `asr.json` — optional throughout: `command` (default `pi-asr`), `timeoutMs`
  (default 600000), `maxChars` (default 40000), `artifactDir` (default
  `~/.pi/agent/tmp/asr`), `chunkSeconds` (default 30, the longest span decoded
  at once; longer audio is cut at silence). `ASR_CONFIG` overrides the path.
- `calendar.json` — optional throughout: `baseUrl` (default
  `https://cal.sudakov.site`), `collection` (default `/denis/main/`), `userVar` /
  `passwordVar` (default the `RADICALE_AGENT_*` pair), `timezone` (default
  `Europe/Moscow`), `auditLog`. `CALENDAR_CONFIG` overrides the path.
- `web-search.json` — owned by `pi-web-access`, not by this package; see
  [Search](#search). Defaults: the provider `auto` chain, Exa through its
  hosted MCP, SearXNG at `http://127.0.0.1:8888`, tools deferred.

A missing variable is reported by the consumer with the exact name to add to
`env.json` (`lib/credentials.ts`); a malformed file is reported when the
extension initialises.
