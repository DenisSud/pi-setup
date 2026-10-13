# Development

## The checkout is disposable

This repo is installed as a git package and lives in
`~/.pi/agent/git/github.com/DenisSud/pi-setup`. Pi refuses to run stale or dirty
package code: while refreshing packages (`pi install`, `pi update`, and on
startup when an update marker is present) its package manager runs, in
`dist/core/package-manager.js`:

```sh
git fetch <ref>
# if HEAD != <ref>^{commit}:
git reset --hard <ref>^{commit}
git clean -fdx          # "Clean untracked files (extensions should be pristine)"
npm install             # dependencies of the package itself
```

So the checkout is a cache of `origin/main`, never a workspace:

- **Commit and push.** A local commit is deleted by the next refresh; work must
  be on `origin/main` to survive.
- **Keep nothing untracked.** `git clean -fdx` removes untracked files and
  ignored files (`node_modules/`, harness symlinks). Scratch files belong in
  `/tmp` or outside the checkout.
- **Recovering**: a wiped commit is still in `git reflog` until gc
  (`git reset --hard <sha>`). Untracked files are gone — the one place a copy
  may exist is a session log under `~/.pi/agent/sessions/`, which records tool
  calls verbatim.
- An interrupted update leaves `~/.pi/agent/git/<host>/.<name>.pi-update-incomplete`
  next to the checkout; the next run cleans and re-installs dependencies.

## Testing

Every extension carries a harness. It drives the real modules against a stubbed
pi API and fake servers — no network, no credentials:

```sh
extensions/<name>/test/run.sh harness
```

`run.sh` first symlinks the installed pi store into `extensions/<name>/node_modules`
(so `@earendil-works/*` imports resolve) and then runs the harness with plain
`node`: TypeScript files are imported directly through Node's type stripping —
there is no build step and no bundler in this repo.

| extension | harness | `live` variant | live needs |
|---|---|---|---|
| `env` | temp files, warnings, `/env` | — | — |
| `web-search` | mocked SearXNG | `WEB_SEARCH_LIVE=1` | local SearXNG |
| `mem0` | fake mem0/gate servers | — | — |
| `calendar` | mocked CalDAV | `CALENDAR_LIVE=1`, writes with `CALENDAR_LIVE_WRITE=1` | `RADICALE_AGENT_*` in `env.json` |
| `gmail` | fake IMAP | `GMAIL_LIVE=1`, writes with `GMAIL_LIVE_WRITE=1` | `GMAIL_APP_PASSWORD` in `env.json`, `gmail.json` |

The live variants load `~/.pi/agent/env.json` the same way the `env` extension
does, so they exercise the real credential path. Run the relevant `live` variant
when a change touches credentials or the network path; `harness` alone is enough
for pure logic.

## Adding an extension

1. `extensions/<name>/index.ts` exporting a default factory
   (`export default function (pi: ExtensionAPI) { … }`). `package.json` declares
   `./extensions`, so the directory is picked up with no registration.
2. `extensions/<name>/test/run.sh` + `test/harness.mjs` — copy from the closest
   existing extension. Completion: `./test/run.sh harness` passes.
3. If it needs configuration, give it its own `<name>.json` in the agent dir
   ([configuration.md](configuration.md)); secrets go through `env.json` and
   `process.env`.
4. Update [README.md](../README.md) and, if it changes the credential or
   convention story, [configuration.md](configuration.md).
5. Commit and push.

## House style

- Imports across `extensions/*` are off limits; shared code goes in `lib/`, and
  a shared npm package if it outgrows this repo.
- External packages come from the host as peer dependencies (`@earendil-works/*`,
  `typebox`); runtime dependencies belong in `package.json` when an extension
  needs one.
- An error message names its fix: the variable to set, the file to repair, the
  service to check. `lib/credentials.ts` and the extension configs show the
  wording.
- Tool descriptions and `promptGuidelines` are part of the agent's contract —
  they decide when the agent reaches for a tool and how it phrases the call.
  Keep them in sync with behaviour.
- Comments explain the *why* (the constraint, the gotcha, the trade-off) and go
  stale quietly; the code already says what it does.
