# Changelog

All notable changes to this project are documented in this file. Format based on
[Keep a Changelog](https://keepachangelog.com); versioning: SemVer. No release has shipped yet.

## Unreleased

### Added

- Source/git metadata (feature-011): each trace carries the session's repository identity —
  `source_type`, native `git_branch` (from `ctx.vcs.get` current branch only; the default
  branch is never substituted), `git_commit` from bounded read-only Git (40/64 hex), sanitized
  `git_remote_host`/`git_remote_path` (scheme, userinfo, query, fragment, and `.git` never
  leave the process), and `repo_owner`/`repo_name`/`repo_identity` from the remote path or the
  observed `repo_root_name`. `metadata_source` distinguishes `git-detection` from `repo-file`.
  A repository-root `.opencode-langfuse.metadata.json` (64 KiB bound, no upward search) may
  override exactly eight documented keys; engine/trace keys cannot be overridden, unusable
  files are ignored with one fixed diagnostic, and every retained value passes the redactor.
  Metadata rides trace metadata only (reasserted on updates), under every privacy preset; no
  trustworthy session directory means no fabricated source.
- Tool observations (feature-006): one root-parented span per exact tool call, paired by the
  full `(sessionID, assistantMessageID, toolCallID)` identity with deterministic ids. Failure
  classification follows the operator-selected rule — the `execute.after` error status or a
  finite non-zero structured native shell `exit` — never output text; the actual native status
  and validated exit code are exported (`metadata.nativeStatus`/`exitCode`), and interruption is
  a WARNING, not an invented error. Tool input/output use the existing `toolInput`/`toolOutput`
  privacy slots (captured once, detached, before retention); status text is fixed whenever tool
  I/O capture is off. Capacity refusal (256 pending per session) warns once per episode and
  never blocks provider delivery.
- Compaction spans (feature-007): one content-free span per native compaction lifecycle with
  deterministic identity from the native start sequence (`kind:"compaction"`, reason, boundaries
  only — no input/output/usage/cost, no summary bytes in any preset). A terminal observed
  without its start exports terminal-only with no fabricated start time; a new start while a
  lifecycle is open marks the older one interrupted (`next-compaction.started`); natively
  interrupted compactions are WARNING. One lifecycle stays one span no matter how many HTTP
  generations it drives.
- Trace scores (feature-008): the five cumulative scores (`tool_call_count`, `turn_count`,
  `total_tool_errors`, `tool_success_rate`, `session_had_errors`) publish on native execution
  terminals with stable body ids (`sha256(opencode-langfuse:score:<sessionID>:<name>)`). Counts
  advance once per primary-turn and per tool identity from a bounded in-memory ledger; a warm
  tracker stays cumulative across compactions, continued prompts, flushes, and pruning. Scores
  publish only when complete history is provable and every admitted tool has an authoritative
  terminal — pending/interrupted tools delay the snapshot rather than fabricating a success
  ratio, and after a compacted cold restore (or ledger overflow) all five updates are omitted
  with one bounded warning instead of overwriting stored totals.
- Privacy completion (feature-009): the preset contract now governs every capture path from its
  first implementation. Tool payloads are gated before retention, metadata is whitelisted per
  observation type (never a spread of native events/results/errors), and dynamic emitted
  strings — tool names, model attribution, allowed error messages, lookup/transport/event-stream
  diagnostics — pass the redactor. Generation status messages use the fixed capture-status
  explanation while output capture is off, so provider/output content cannot echo through the
  status-message path; numeric usage/cost and scores remain available under metadata-only.
- Decision record ADR-0004 (tool observation, compaction span, and score lifecycle): the
  exit-code classification rule, stable span/score identities, complete-history-only score
  updates, and the root-sibling observation hierarchy extending ADR-0003.

- Self-computed generation cost (feature-005): primaries carry `costDetails` computed once from
  the request's normalized usage and an independently resolved price — never the host's `cost`,
  which is recorded only as diagnostic `metadata.hostCost`. Price resolution per ADR-0002 in
  strict order (config override → native catalog first tier → bundled table → omitted with a
  once-per-model warning), never mixing sources: positive cache usage against a source missing
  that rate omits the entire cost. Explicit zero prices are honored (true zero cost); an
  all-zero catalog tier is unpriced and falls through. Catalog quotes carry `pricingTier:0`,
  `pricingTierCount`, and honest first-tier approximation flags; DeepSeek-V4 bundled quotes are
  flagged `pricingAssumption:"off-peak"`. A slow catalog is bounded at one 3 s attempt per
  plugin lifetime (cached failure, no repricing). Verified live on the self-hosted Langfuse:
  override totals 0.00011925/0.0002685 (cache-heavy) against the host's cache-dropping
  0.0001185, bundled GLM 0.0000839, true zero for explicit-free, absent `costDetails` (not
  zero) for unpriced and missing-cache-rate models, and unchanged numeric cost under the
  metadata-only preset.
- Token usage on generations (feature-004): primary generations carry `usageDetails`
  (input/output/total plus non-zero reasoning/cacheRead/cacheWrite) taken verbatim from the
  durable `session.step.ended` token totals — OpenCode's R1-decided capture point; partial usage
  from `session.step.failed` is included when reported. Auxiliary generations carry no usage
  (no capture point, never guessed). Verified live: usage equals OpenCode's normalization of the
  provider report (prompt−cached, completion−reasoning) on every primary generation.
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
