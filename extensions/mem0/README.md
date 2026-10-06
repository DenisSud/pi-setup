# mem0 — automatic semantic memory

Every agent recalls and stores facts in a self-hosted mem0 server. Recall is
automatic per input; capture is automatic but buffered, filtered and batched;
the `mem0_memory` tool and the `/mem0` command give explicit access. The
curated note layer is separate (`base/extensions/memory/`).

Vendored from `@amaster.ai/pi-memory-mem0` v0.1.2-beta.15 (Apache-2.0, see
`LICENSE`), stripped to the self-hosted REST backend, plus the capture
pipeline.

## How it works

```
turn_end → buffer (user/assistant prose, redacted) → flush trigger
         → decision gate: worth remembering? no → drop, yes → one batched add
         → server extraction + embeddings → pgvector

input → background recall search → minScore floor → optional relevance filter
      → injected as [UNTRUSTED MEMORY DATA], never the system prompt
```

Flush triggers: `flushMessages`, `flushIdleMs`, `capMessages`, session end.
The gate is a small decision model; on any gate failure the batch is sent
(fail-open toward remembering). Capture never blocks a turn; a failed add
drops its batch. Decision calls use pi's native System One endpoint
(`/v1/systemone`), sent directly with no client package.

## Configuration

`settings.json` key `pi-memory-mem0`; environment fallbacks fill the gaps for
deployments without per-agent settings (the fleet container).

| setting | env | default | meaning |
|---|---|---|---|
| `baseUrl` | `MEM0_BASE_URL` | — | server URL; required |
| `apiKey` | `MEM0_API_KEY` | — | consumer key; required unless `apiKeyProfile` resolves one |
| `apiKeyProfile` | — | — | `security` extension profile (rbw) providing the key |
| `apiKeyVar` | — | `MEM0_ADMIN_API_KEY` | var read from that profile |
| `memoryMode` | — | `hybrid` | `hybrid` / `active` / `passive` preset |
| `autoCapture` / `autoRecall` / `toolEnabled` | — | preset | independent overrides |
| `userId` | — | `bot:<PI_BOT_NAME>` or `$USER` | namespace |
| `userIdScope` | — | `project` | hash the cwd into the namespace (`exact` keeps it verbatim) |
| `topK` | — | `5` | recall and search result limit |
| `minScore` | — | `0.3` | client-side score floor on recall (`0` disables) |
| `recallFilter.*` | `MEM0_FILTER_BASE_URL`, `MEM0_FILTER_MODEL` | off | one decision call over recall survivors |
| `capture.flushMessages` | — | `12` | flush when the buffer holds this many messages |
| `capture.flushIdleMs` | — | `180000` | flush this long after the last append |
| `capture.capMessages` | — | `64` | hard buffer cap |
| `capture.gate.*` | `MEM0_GATE_BASE_URL`, `MEM0_GATE_MODEL` | on when a URL is set | decision gate before capture |
| `autoCapture` (env form) | `MEM0_AUTO_CAPTURE` | — | `true`/`false` wins over settings (bulk runs) |

## Status (2026-10-02)

Live as an experiment against the self-hosted service (its own repo,
`DenisSud/mem0`; the stack lives in `deploy/` there): capture, recall, tools,
the gate and the relevance filter run. Extraction runs server-side on a local
model, and the service filters on ingest and output itself — which makes the
extension's own gate and recall filter redundant, so they come out in the
rework. Known gaps (top_k, dedup ≥1000, redaction holes, recall-block
accumulation) are a checklist in #34.

## Layout

| file | what |
|---|---|
| `index.ts` | hooks, tool and command wiring, config and key resolution |
| `capture.ts` | buffer → gate → batch pipeline |
| `provider.ts` | self-hosted REST client |
| `prefetch.ts` | two-phase recall (kick off on input, consume with timeout) |
| `privacy.ts` | redaction, untrusted-data wrapping, injection scan |
| `tools.ts` | the `mem0_memory` tool |
| `dedup.ts` | exact-duplicate maintenance for `/mem0 dedup` |

## Tests

`./test/run.sh harness` — fake HTTP servers and a stubbed pi API, no network,
no vault. Requires the installed `pi` store (symlinks set up by the script).
