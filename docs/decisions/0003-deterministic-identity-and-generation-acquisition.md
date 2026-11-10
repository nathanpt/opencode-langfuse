# 0003. Deterministic trace identity & generation acquisition

- Status: accepted
- Date: 2026-11-09

## Context

Feature-002 created one trace + root observation per session with random UUIDs and deleted the
session record on flush. Feature-003 needs one GENERATION per primary agent-loop model request
plus separately tagged auxiliary generations (`title`, `compaction`, `generate`) that can start
before, during, or after the root's first export, and can finish long after it. That requires
trace/root/generation ids to survive flushes, continuation prompts, tracker restarts, and
late-arriving terminals — and an acquisition path for model requests that never produce durable
step events (auxiliaries).

## Decision drivers

- A late auxiliary terminal must export under the original root without a new session event.
- A second prompt, a tracker restart, or a flushed record must reuse the same trace identity.
- The native event stream is the only durable truth for primaries; HTTP hooks carry no request id.
- No persistent storage, no new dependencies, credentials never enter id seeds.
- Record deletion on flush (feature-002) is incompatible with late updates and must go.

## Considered options

1. Keep random UUIDs + delete-on-flush — rejected: late auxiliary updates cannot attach to a
   deleted, re-randomized trace; restarts duplicate traces.
2. Local persistence of id maps — rejected: new storage tier for derivable data.
3. Deterministic ids derived from the OpenCode session id (SHA-256 of fixed seed prefixes,
   truncated) + state retained in memory independent of export snapshots — chosen: ids are
   stable across processes without storage; eviction is safe because reconstruction is possible.
4. Auxiliary acquisition via `retry`/title hooks or FIFO matching — rejected: no request identity;
   observed `http.request`/`http.response` carry the same `Request` object (preflight-proven on
   2.0.31), and a `WeakMap<Request, descriptor>` pairs exchanges exactly.

## Decision

- Trace/root/generation ids are `SHA-256` of `opencode-langfuse:trace:<sessionID>` (32 hex),
  `opencode-langfuse:root:<sessionID>` (16), `opencode-langfuse:generation:<sessionID>:
  <assistantMessageID>` (16). Auxiliary observation ids and ingestion-envelope ids stay fresh UUIDs.
- Primaries are acquired from durable `session.step.*` / `session.execution.*` identity keyed by
  `(sessionID, assistantMessageID)`; `step.streamed` is the response-body terminal boundary.
- Auxiliaries are acquired only through awaited `http.request`/`http.response` hooks, paired by
  exact `Request` identity, observed through a demand-driven pass-through stream that classifies
  EOF / read error / consumer cancel without parsing bytes.
- Timing is full completion: `endTime` is the observed terminal, never header arrival or export
  time; unknown duration is labelled (`cancelled`/`interrupted`/`unavailable`), never success.
- Session records survive flushes (LRU-bounded at 256, clean-inactive eviction; generation
  capacity 256 per session with warn-once telemetry refusal); `Tracker.shutdown()` bounds the
  final drain at 5 s and aborts remaining ingestion via `IngestOptions.signal`.

## Consequences

- Continued/reconstructed sessions upsert the same trace (repeated `trace-create` + `span-update`
  patches); root input stays the first prompt, output tracks the latest primary response.
- Trace ids of old development traces (random) are not migrated; stable ids apply to new traces.
- Auxiliary capture status is consumer-behaviour truth: the native parser often ends successful
  consumption by cancellation, so `cancelled` + HTTP 200 is not a provider error (WARNING level).
- Capacity overflow refuses telemetry only; model delivery is never delayed.

## Confirmation

- Preflight probe (2026-11-09, opencode 2.0.31): cross-hook `Request` identity held for every
  admitted exchange including two concurrent same-kind `generate` calls interleaved with
  compaction; `session.get`/`context` return direct shapes with finite ms timestamps.
- Deterministic scenarios: `test/tracker.test.ts` + `test/auxiliary.test.ts` (48 passing).
- Live acceptance (2026-11-09, `ingest.nathanpeet.com`): deterministic ids matched the SHA-256
  seeds on a cold load; two primaries matched durable steps; title terminal followed the
  deliberate 100 ms post-header interval; post-flush `generate` terminal landed ~3008 ms after
  dispatch under the original root; reverse-order concurrent pairing held; HTTP 400 exchange
  exported as `ERROR`; server restart reused the same trace/root and preserved the original
  input; `metadata-only` exported no content while the client received the normal answer.
