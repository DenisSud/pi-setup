# ptc — programmatic tool calling for pi

Reference spec for the `ptc` extension. Pattern source: Anthropic "Programmatic
tool calling" (code execution calling tools as async functions) and OpenAI
"Programmatic Tool Calling" (V8 runtime, `allowed_callers: ["programmatic"]`).
Both docs agree on the core: the model writes one program that calls tools as
plain async functions; loops/conditionals/parallelism are ordinary code; tool
results feed back into the running program, never into context; only the
program's printed output reaches the model.

## Why the local version is simpler

Anthropic/OpenAI need sandboxed containers because they execute untrusted code
at scale. pi on Denis's machine already runs arbitrary bash as the user, so we
use Anthropic's "client-side direct execution" alternative: run the generated
program locally, no sandbox, no container lifecycle, no pause/resume protocol.
Same trust level as the bash tool.

## Design decisions (agreed)

1. **One tool: `ptc`** — parameter `code` (JavaScript, top-level await), or
   `path` to run a previously saved program instead (mutually exclusive; see
   11). Runs in a Node child process. Hard timeout (default 120 s,
   `PTC_TIMEOUT_MS` env override). stdout captured as the result, head+tail
   capped for the LLM, full output written to a file and its path reported.

2. **Registry is opt-in and local to the tool's owner.** `ptc` ships with an
   empty registry. Other extensions add a tool with one line:
   `registerPtcTool(name, run, { signature? })`. No descriptions, no schemas —
   `name` matches the tool's existing registration, `run(args, ctx)` is the
   implementation. Registry is a `Map`; registration is idempotent (last write
   wins) so `/reload` re-running factories cannot break.

3. **No redocumentation.** Single source of truth for tool docs is the
   existing tool list in the system prompt. The `ptc` tool description carries
   zero per-tool prose for registered extension tools — only the calling
   convention. `signature` is an optional one-line binding contract
   (`args → result shape`), not behavioral documentation; use it only for
   shapes the direct docs don't already state.

4. **Available functions are listed, never guessed.** The `ptc` description is
   built at `session_start` (after all extensions load) from the live
   registry. Late registrations re-register/refresh the tool.

5. **Built-ins: script-friendly `read`, `grep`, `find`.** Ptc owns these
   (they are not direct pi tools), so their JSON shapes ARE documented in the
   `ptc` description — that is their only documentation. Structured JSON in/out,
   no prose rendering:
   - `read({ path, offset?, limit? }) → { path, content, truncated, total_bytes, total_lines }`
   - `grep({ pattern, path?, ignore_case?, max_matches? }) → { matches: {path,line,text}[], truncated, total_matches }`
   - `find({ pattern, path?, type? }) → { paths, truncated, total }`
   - `sh({ command, timeout_ms?, max_output?, cwd? }) → { stdout, stderr, code, signal, timed_out, truncated }`
     (boilerplate removal, not a capability addition — a program can already
     `await import("node:child_process")`; never throws on nonzero exit;
     default timeout 30 s so a hang cannot stall the tool)

6. **Default pi tools are NOT auto-registered.** `bash`/`write`/`edit` are
   side-effecting (keep direct for the authorization boundary), `ls` is
   subsumed by `find`. If a default tool ever earns a place, it enters through
   a thin re-implementation registered the same way (`builtin.ts`), never a
   special case.

7. **pi-setup extensions:** `web-search` registers (fan-out search is the
   benchmark-proven fit: filter/rank results in code). `sysinfo` does not
   (already in the system prompt, no fan-out value). `consult` does not
   (expensive, judgment-heavy — adaptive evaluation stays direct per both
   vendors' guidance).

8. **Error handling.** Tool `run` throwing = a rejected promise inside the
   program (model sees it in the error output and can handle/retry in code).
   Unknown tool name, call limit (500), timeout, and program exceptions all
   surface as `isError` results with actionable text.

9. **User code is a separate ES module.** The child runs a wrapper (protocol
   prelude) that dynamically imports the user code written to its own
   `user-program.mjs`. Rationale (session feedback, 2026-08): wrapping user
   code in an async IIFE made static `import` declarations illegal (SyntaxError
   before line 1 of user code ran) and shifted every reported line number by
   the prelude length. With the split: static imports work, error line numbers
   point at the user's file (and Node's SyntaxError message includes the
   failing line), and tool globals stay visible because wrapper and imported
   module share globalThis. `require` does not exist — document `await
   import(...)` as the alternative.

10. **Program file lifecycle: kept, reported, rerunnable.** Every run writes
   the user program to `/tmp/ptc-*/user-program.mjs` and reports its path in
   the result text and `details.programPath` — on success and failure. The
   run dir is never deleted: the path must stay valid for reruns. (An earlier
   version deleted on success and leaked on failure; the leak fix is
   superseded by this decision — dirs are ~2 KB and /tmp tmpfiles cleanup
   reclaims them.)

11. **Rerun by path.** `ptc { path }` runs a previously saved program — pass
   the program file or its directory (results report the file, the rerun
   hint shows the dir; both work). The file is re-read at call time, so edits
   made via bash/edit tools are picked up — that is the iteration loop:
   tweak the file, rerun by path, no code resend. Trust level is unchanged
   (same as bash: any readable file can be executed). The wrapper always
   runs from a fresh mkdtemp dir; the child's cwd is the program's own dir
   in both modes, so cwd-relative behavior matches between first run and
   rerun.

## Deferred (v2 if needed)

- **Generated output-shape block**: optional `output` typebox schema at
  registration, rendered into the `ptc` description as TS-like hints. Add only
  if models actually misread shapes in practice; schema declared once, doc
  block + any validation derive from it.

## Layout

- `index.ts` — `ptc` tool (registers in `session_start`), child-process runner, output capping.
- `registry.ts` — `registerPtcTool` / `listPtcTools` / `getPtcTool`. The only file other extensions import.
- `builtin.ts` — script-friendly `read` / `grep` / `find` / `sh` implementations + signatures.
- `test/harness.mjs`, `test/run.sh` — same harness pattern as consult (stubbed ExtensionAPI, no network).
