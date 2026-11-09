# Event architecture: OMP vs OpenCode v2 (the "linked queues" comparison)

Upstream design sources (OpenCode's own words — no blog exists; philosophy lives in repo specs):

- `specs/v2/event-stream-architecture.md` (anomalyco/opencode, branch `dev`): the "Delivery Law"
  — independent finite lag budget per connection, overflow terminates only that connection,
  publication continues in order; shared PubSub explicitly evaluated and rejected; one sequential
  Core observer → identical order for healthy subscribers; volatile stream semantics documented
  ("events before registration may be missed"); no silent gaps on encoding failure.
- `specs/v2/session.md`: events are facts admitted before effects (tool calls durable *before*
  side effects); idempotent admission ("first admission wins"); write-ahead execution claims with
  explicitly bounded, not-exactly-once recovery; durable log replays via
  `sessions.log({sessionID, after?, follow?})` while live-only deltas are "intentionally absent
  from replay"; replay ownership separate from execution ownership.
- Design issues: #31130 (EventV2 replay/live payload consistency), #35015 (deterministic,
  replication-safe replay/tail; aggregate gaps legal, 100-event page cap), #35014 (schema cleanup),
  PR #30632 (Effect-native V2 session runtime, author kitlangton).
- Note: the session-log API is labeled **experimental** upstream.

Why this exists: both harnesses deliver agent lifecycle events to extensions, but with opposite
mechanics. omp-langfuse's acquisition design assumes OMP's mechanics; opencode-langfuse must
accommodate OpenCode's. This note pins both implementations and lists what our code does
differently as a result.

**Pins**

- OMP: `@oh-my-pi/pi-coding-agent` **16.3.0** (exact devDependency pin of omp-langfuse v0.4.0),
  source at `~/dev/projects/omp-langfuse/node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/extensions/runner.ts`
  (package ships full `src/`); consumer side: `~/dev/projects/omp-langfuse/index.ts`.
- OpenCode: **v2.0.31** docs + our runtime probes (`docs/references/opencode-plugin-api.md` →
  Runtime-verified; raw logs in `/tmp/r1-probe/out/`, ephemeral).

## OMP (pi 16.3.0): inline linked handlers — there is no queue

`ExtensionRunner.emit(event)` dispatches by direct function call, **inside the agent pipeline**:

- For each extension (registration order), for each handler: `await #runHandlerWithTimeout(...)`.
  Handlers run **sequentially**; the host blocks until every handler settles before continuing.
  Only `session_shutdown` fans out concurrently (`Promise.all`).
- Every handler races a **30 s budget** (`extensionHandlerTimeoutMs`); `session_shutdown` uses a
  short cap so teardown stays prompt. Timeout → warn + `undefined` (generic events fail **open**);
  `tool_call` timeouts fail **closed** (`{block: true}`) (issue #3948).
- Handler throws are isolated per extension and routed to `onError` listeners — never crash the host.
- Events are **ephemeral**: no persistence, no replay, no delivery ordering beyond handler
  registration. If an extension subscribes late, or the process dies, events are gone.
- Transform events (`input`, `context`, `tool_result`, `before_provider_request`,
  `session_before_*`, `session.compacting`, `session_stop`) let handlers **mutate or cancel** the
  pipeline — dispatch is a control-flow mechanism, not just observation.
- Durability lives outside the event system: session JSONL files. omp-langfuse reconciles from
  files (`readSessionFile`, advisor transcripts at `<sessionFile>.jsonl`-less dir `/__advisor*.jsonl`)
  because some traffic (advisor messages) never reaches `message_end` events.
- One process per agent run (CLI); the extension shares that process and uses
  AsyncLocalStorage (`runWithSession`) to fence per-session state.
- The only real queues in the runner are micro-buffers: a bounded `pendingCredentialDisabled`
  buffer (32, drop-oldest) drained by `queueMicrotask` after initialize.

Consequence omp-langfuse lives with: a slow handler slows the agent (bounded only by the 30 s
cap), so it had to learn fire-and-forget discipline — `void flushRuntimeTracers()` per turn,
deferred `shutdownRuntime` via `setTimeout(…, 0)` — after Langfuse's 4.5 MB ingestion cap dropped
whole batches when long sessions flushed once at shutdown.

## OpenCode v2: a durable event-sourced queue with broadcast delivery

- Session-scoped events are **journal entries**: each carries
  `durable {aggregateID: <sessionID>, seq, version}` — a per-session totally-ordered, persisted
  stream (observed: `session.created` seq 0, inbox/step/tool events incrementing `seq`).
  High-frequency ephemeral events carry **no** `durable` field: `session.text.delta`,
  `session.tool.progress`, `session.usage.updated`, `session.instructions.updated` (the delta).
- Delivery: `ctx.event.subscribe({types?, signal})` — an **async-iterable broadcast** to in-process
  plugins. The server emits regardless of subscriber pace; a live iterator buffers. Abort = the
  plugin's own `AbortController`. No replay of events missed before subscribing or after the
  iterator dies (in-process plugin; reconnect semantics unverified/irrelevant for us).
- The server is **long-lived and multiplexes locations/sessions**: one stream interleaves parent
  and child sessions (subagents), distinguished only by `sessionID` and
  `session.created.parentID`.
- Mutation is a separate channel: domain hooks (`ctx.session.hook`, `ctx.tool.hook`, …) are the
  inline-linked analog of OMP's transform events, with their own ordering and retry-safety rules.
  Observability should sit on the event stream, not the mutation hooks.
- Durable state is queryable: `ctx.session.context({sessionID})` returns the persisted transcript —
  the crash-recovery path reads state, not events.

## Side-by-side

| Dimension | OMP 16.3.0 | OpenCode v2 |
| --- | --- | --- |
| Delivery | inline linked calls at emit point | durable queue + async-iterable broadcast |
| Host blocking | yes — handlers awaited in the pipeline | no — subscribers consume at their own pace |
| Handler ordering | sequential, registration order | single stream, interleaved across sessions |
| Ordering signal | none (call order only) | `durable.seq` per session aggregate |
| Durability | none at event layer (session JSONL files) | journal entries per session aggregate |
| Replay/backfill | re-read JSONL files manually | `ctx.session.context` (transcript), not events |
| Ephemeral events | everything is ephemeral | deltas/progress/usage (no `durable` field) |
| Mutation channel | same bus (transform/cancel results) | separate domain hooks |
| Process model | one process per agent run | long-lived server, many sessions multiplexed |
| Failure isolation | per-handler try/catch + 30 s fail-open/closed | subscriber isolation (stream survives plugin errors) |
| Backpressure risk | extension can stall the agent (30 s cap) | plugin's own buffer growth (must self-bound) |

## What our code does differently (accommodations)

1. **Demux by sessionID.** One interleaved stream, many concurrent sessions: per-session state is
   a `Map<sessionID, state>` router (sibling's `withSession` AsyncLocalStorage fence becomes a
   keyed router; child sessions join via `session.created.parentID`).
2. **Order from `durable.seq`, not arrival.** Scores, turn counts, and observation nesting derive
   from the per-aggregate sequence; never from event arrival order (title/child traffic interleave).
3. **Ephemeral events are hints only.** `session.usage.updated` (cumulative), `text.delta` (TTFT),
   `tool.progress` carry no `durable` field — they may refine live state but the trace truth is
   the durable `step.ended` / `tool.called` / `tool.success|failed` entries.
4. **Self-bounded buffers.** Decoupled delivery means a slow Langfuse cannot stall the agent, but
   can grow our queues: per-session batches are bounded (drop-oldest + one-time warning, the
   OMP `pendingCredentialDisabled` pattern) and flushed per session end with the ~1.5 s grace
   window (R5 design).
5. **At-most-once delivery → crash recovery via state, not events.** Missed events are not
   redelivered; if a session ends while our buffer is incomplete, reconcile from
   `ctx.session.context({sessionID})` — the OpenCode analog of the sibling's JSONL reconciliation.
6. **No backpressure-driven timeouts to fear, but the same fire-and-forget discipline applies**
   (flush never awaited on the event path; 4.5 MB ingestion cap still forces per-session/per-step
   flushing, not one shutdown export).
7. **Observe, don't hook.** OMP fused observation and mutation into one bus; OpenCode separates
   them. We stay on the event stream so we can never alter agent behavior — and can never be
   timed out fail-closed into blocking a tool call.
8. **Commands and config parity break where the harness forces it:** `pi.registerCommand` →
   `ctx.command.transform` (JS handlers survive); OMP's first-run UI prompt has no OpenCode
   equivalent → ADR-0001's env/file/disabled-with-status decision.
