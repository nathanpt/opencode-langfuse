# Changelog

All notable changes to this project are documented in this file. Format based on
[Keep a Changelog](https://keepachangelog.com); versioning: SemVer. No release has shipped yet.

## Unreleased

### Added

- Per-request generation observations (feature-003): one `GENERATION` per primary agent-loop
  model request — acquired from durable `session.step.*` identity, carrying the request's actual
  model reference, finish reason, and the measured response-body terminal boundary — plus
  separately tagged auxiliary generations (`llm-generation:title|compaction|generate`) acquired
  from `http.request`/`http.response` hooks paired by exact `Request` identity and observed
  through a demand-driven pass-through stream (EOF / read error / consumer cancel, full-completion
  timing). Metadata-only capture: no model input/output, tokens, or cost on generations
  (features 004/005 unchanged). Verified live against the self-hosted Langfuse (cold load, tool
  loop, post-flush and concurrent auxiliaries, compaction, provider 400, model switch,
  metadata-only preset).
- Deterministic trace identity (ADR-0003): trace/root/primary-generation ids derived from the
  OpenCode session id (SHA-256 of fixed seed prefixes), so continued sessions, flushes, and
  plugin restarts reuse the same trace; session records survive flushes (LRU-bounded) and
  post-flush updates export under the original root with their own grace timers.
- Operating foundation: README, AGENTS.md (two-part standard rules v1.2), ARCHITECTURE.md,
  PROGRESS.md, feature contract (`docs/feature-list.json`), decision layer (`docs/decisions/`),
  research references (OpenCode v2 plugin API notes, omp-langfuse reuse inventory), and the active
  research/design exec plan.
- Plugin skeleton (`src/index.ts`, `src/config.ts`): loads as an OpenCode v2 server plugin and
  announces tracing state at startup; credential resolution per ADR-0001 (env vars → 0600 config
  file at `~/.config/opencode-langfuse/config.json` → disabled with a stated reason). Verified
  live against OpenCode v2.0.31 (load, banner, env-over-file precedence).
- Per-session tracing (feature-002): one Langfuse trace with a root agent observation per primary
  session — input = user prompt (`session.inbox.enqueued`), output = final assistant response
  (`session.text.ended`), flushed on `session.execution.succeeded` + 1.5 s grace window through
  the REST ingestion transport (redaction + privacy presets ported from omp-langfuse). A missed
  `session.created` (cold-load race with the event bus) reconciles via `ctx.session.get`.
  Verified live against the self-hosted Langfuse from a cold plugin load.

### Changed

- Session records are no longer deleted on flush; `flushNow`/`flushAll` submit detached snapshots
  and later changes export in ordered follow-up batches (`trace-create` upserts, `span-update`,
  `generation-update`).
- `LangfuseTransport.ingest` accepts `IngestOptions.signal`; `Tracker.shutdown()` bounds the
  final drain at 5 s, detaches observers, and marks unfinished observations `interrupted`.
