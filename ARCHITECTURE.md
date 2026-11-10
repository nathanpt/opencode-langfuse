# ARCHITECTURE.md — opencode-langfuse

Status: implemented. Facts are verified against the OpenCode v2 plugin docs (fetched
2026-11-09, against installed opencode v2.0.31) and a read of the sibling `omp-langfuse` v0.4.0
source. Features 001–013 are implemented and live-verified (see PROGRESS.md); ADRs 0001–0005
are accepted (see docs/decisions/). The feature list (docs/feature-list.json) is complete.

## What this system is

An OpenCode v2 plugin, loaded in-process into the OpenCode server, that observes agent sessions
and exports one Langfuse trace per session to an external Langfuse instance (cloud or
self-hosted — the host comes from configuration; default `https://cloud.langfuse.com`). There is
no local storage tier; the only buffering is in-memory between an event and the next flush.

## Host boundary (OpenCode, verified)

- Plugin form: server part, `Plugin.define({ id, setup(ctx) })`; hook/transform registrations are
  disposed automatically at unload, and `setup` may return a cleanup function — the flush/shutdown
  hook point.
- Hook surface this design uses:
  - `ctx.session.hook("prompt" | "context" | "compaction" | "generate" | "title" | "model.request"
    | "http.request" | "http.response" | "retry")` — session/model lifecycle; events carry
    `sessionID`, `agent`, `model {providerID, id, variant}`, and `kind`
    (`"primary" | "compaction" | "title" | "generate"`).
  - `ctx.tool.hook("execute.before" | "execute.after")` — `tool`, `input`, and after: `status`
    (`"completed" | "error"`), `result`, `error`.
  - `ctx.event.subscribe({ types?, signal })` — public event stream (e.g. `session.idle`).
- Context reads this design uses: `ctx.session.get/context/list`, `ctx.model.list` (Model.Info
  carries `cost` tiers — USD per 1M tokens, resolved 2026-11-09 (R2); returns `{location, data}`;
  config-defined providers' models are omitted — known gap per ADR-0002), `ctx.vcs` (repo
  info/status), `ctx.location` (directory, project), `ctx.options`, `ctx.storage` (durable
  plugin-scoped JSON).
- Loading/discovery: `.opencode/plugins/` auto-discovery; `plugins` array in `opencode.json(c)`
  (object form passes `ctx.options`); `opencode plugin add/list/remove`; watched config dirs hot-
  reload. Local plugins may be `.ts` directly.

## Component map (implemented)

```
setup(ctx)
├── config      credentials + options: env vars → 0600 config file    [ADR-0001, accepted]
│               (src/config.ts); resolved once in setup — the active config
├── capture     privacy presets + redaction (src/capture-policy.ts, src/redaction.ts);
│               resolvePrivacyPreset: env-over-file base preset, per-field env overrides
├── observe     hook/event → observation builders (src/generations.ts, src/tools.ts,
│               src/compactions.ts, src/auxiliary.ts): session, generation, tool, compaction
├── pricing     price resolution + cost (src/pricing.ts); layered resolution per ADR-0002,
│               no runtime deps
├── source      source/git metadata (src/source-metadata.ts): native ctx.vcs.get
│               provider/current-branch + bounded read-only Git supplement (work-tree root,
│               HEAD, origin) + repo-root override file, under one 2s deadline combined with
│               unload cancellation; collected lazily once per session admission
│               [ADR-0005, accepted]
├── transport   Langfuse REST ingestion client (src/langfuse.ts) + flush/shutdown;
│               onError notices on final failure (retry exhaustion, rejected 207 events)
├── commands    /langfuse-status + /langfuse-test (src/commands.ts): server-log-only,
│               report/test the active config, standalone test trace [ADR-0005, accepted]
├── status      runtime last-error slot (src/runtime-status.ts): scope + redacted ≤300-char
│               message + timestamp per plugin instance; survives successes until reload
└── state       per-session state + score aggregation (src/tracker.ts, src/scores.ts),
                keyed by sessionID; child sessions are admitted like primaries [ADR-0005]
```

Dependency direction: `observe` and `source` feed `transport` through `state`; `capture` and
`pricing` are pure functions over payloads; `config` is read once in `setup` and passed down.
Nothing outside `transport` talks to the network; `commands` only call `transport.ingest` for
the standalone test trace and never touch `state`.

## Trace model (implemented)

Same shape as omp-langfuse, renamed for this harness: one trace per session; root observation
(user prompt → final assistant response); one generation per primary model request; auxiliary
requests (compaction, title, generate) recorded and tagged by `kind` (sibling precedent: advisor
role tagging); tool observations with `level=ERROR` on failure; a span for compaction; trace-level
scores (`tool_call_count`, `turn_count`, `total_tool_errors`, `tool_success_rate`,
`session_had_errors`) attached when the session ends.

Implemented: the trace/root with **deterministic identity** derived from the session id
(ADR-0003), one generation per primary request acquired from durable `session.step.*` identity,
tagged auxiliary generations acquired from `http.request`/`http.response` via exact
`Request` identity (demand-driven body observer, full-completion timing), token `usageDetails`
on primary generations from the R1 capture point, and self-computed `costDetails` per ADR-0002
(feature-005: usage × one resolved price from config override → catalog first tier → bundled
table; omitted with a once-per-model warning when unresolvable; host `cost` kept only as
diagnostic `metadata.hostCost`). Root-sibling observations and scores per ADR-0004: tool spans
(006 — operator-selected exit-code classification, exact-identity pairing, one observation per
call), compaction spans (007 — one content-free span per native lifecycle, deterministic
identity from the start sequence), and the five cumulative trace scores (008 — published only
when complete history is provable and every admitted tool has an authoritative terminal;
omitted with a bounded warning after a compacted cold restore; a recovered shell exit seeds as
a failure per the same classification rule).

Source metadata (011, ADR-0005): trace metadata carries `source_type`, `git_branch` (native
`ctx.vcs.get` current branch only), `git_commit` (read-only Git), sanitized
`git_remote_host`/`git_remote_path`, `repo_owner`/`repo_name`/`repo_identity` (or
`repo_root_name` with no origin), and `metadata_source` (`git-detection` | `repo-file`). A
repo-root `.opencode-langfuse.metadata.json` may override exactly eight documented keys; the
engine/trace keys cannot be overridden, and every retained value passes the redactor. Metadata
rides **trace metadata only** (reasserted on updates); the root observation and child
observations never gain it. No trustworthy session directory means no fabricated source.

Child-session traces (013, ADR-0005): children are admitted like primaries with unchanged
identity seeds and export their own trace/root named `opencode-subagent:<agent>` (redacted,
sanitized, `subagent` fallback), grouped under the **direct parent's** Langfuse session id
(`trace.sessionId` = parent id), with trace metadata `role:"subagent"`, `parentSessionID`,
`parent_trace_id` (the parent's deterministic trace id), and `agent` when known. All
step/tool/compaction/score machinery, pricing, and caps operate on the child's own state;
parent counts never include child work; a grandchild links to its direct parent.

Operational commands (012, ADR-0005): `/langfuse-status` and `/langfuse-test` are registered
before the unconfigured early-return, so both exist while tracing is disabled. They are
server-log-only — no model API, no tracker mutation, no host-conversation change. Status
reports the active config (state, source, redacted host, masked key, resolved preset, the five
actual flags) and the retained last runtime error; `/langfuse-test` ingests one standalone
`opencode-langfuse-test` trace/root per invocation through the active transport, gated by the
capture policy, with no session grouping or scores.

## Design decisions (research resolutions R1–R5, all resolved 2026-11-09)

1. **Token-usage capture point** — **resolved 2026-11-09 (R1):** the event stream is the source.
   `session.step.ended` fires once per model request (`assistantMessageID`, `finish`, host `cost`,
   `tokens {input, output, reasoning, cache {read, write}}`); `session.usage.updated` is the
   cumulative per-session total. `http.response` body-teeing works but stays a diagnostic/fallback
   only. Evidence: docs/references/opencode-plugin-api.md → Runtime-verified.
2. **`Model.Info.cost` semantics** — **resolved 2026-11-09 (R2):** `model.list()` returns
   `{location, data}`; `cost` is a tier array of `{input, output, cache {read, write}}` in
   **USD per 1M tokens**. Host `cost` is untrustworthy twice over: 0 for unpriced models and
   missing `cache.read` for priced ones. Cost is always self-computed — decision and precedence in
   ADR-0002 (accepted). Known gap: `model.list()` omits config-defined providers' models.
3. **Subagent/child-session model** — **resolved 2026-11-09 (R3); implemented 2026-11-10
   (feature-013, ADR-0005):** subagents are real child sessions; `session.created` carries
   `parentID`, `agent` (subagent name), and `title`, with the child's own step/usage events.
   Children are admitted like primaries with unchanged identity seeds; child traces are named
   `opencode-subagent:<agent>`, carry `metadata.parentSessionID`/`parent_trace_id`/`agent`,
   and group under the direct parent's Langfuse session id.
4. **Config & credential storage** — **resolved 2026-11-09 (R4):** env vars first
   (`LANGFUSE_PUBLIC_KEY/SECRET_KEY/BASE_URL|HOST` + capture overrides), then a dedicated 0600
   config file (`~/.config/opencode-langfuse/config.json`, sibling-shaped); `ctx.options`
   rejected (committed config = leak vector); `ctx.storage` rejected for credentials (verified
   working and 0600-sqlite-backed, but opaque to inspect/rotate); no interactive first-run
   prompt in v0 — unconfigured loads disabled with a clear status line. ADR-0001 (accepted).
   Operational caveat (probe-verified): env vars must reach the service process — export, then
   `opencode service restart`, or run `--standalone`.
5. **Flush/shutdown timing** — **resolved 2026-11-09 (R5, design):** the plugin runs in the
   long-lived server process; sessions end without unloading it (one `setup` across seven runs),
   and the cleanup function fires on unload/reload only (four observed). Flush is per session:
   on `session.execution.succeeded` (parent and each child session), hold a bounded grace window
   (~1.5 s) for trailing title/usage/child traffic, then flush that session's batch; the cleanup
   function performs the final timeout-bounded shutdown. The transport is REST-only
   (`POST /api/public/ingestion`, one retry, per-event 207 acceptance replaces the sibling's
   OTel queue + REST fallback). `session.created` can race the event subscription on a cold
   plugin load, so a prompt for an unknown session reconciles via `ctx.session.get` (records
   created with no invented content or linkage; lookup failure fails open). Since feature-013,
   children are admitted through the same reconciliation and a later birth enriches the same
   deterministic trace.

## Where to look next

- docs/exec-plans/active/research-and-design.md — current plan, phases R1–R6, acceptance gate.
- docs/references/opencode-plugin-api.md — verified API notes with sources.
- docs/references/omp-langfuse-reuse-inventory.md — what to port vs rewrite.
- docs/decisions/README.md — ADR index and template.

## Verification levels

- **Unit** — pricing resolution, redaction, capture policy, observation builders (pure logic).
- **Integration** — plugin loads in a real OpenCode; hooks fire; built observations are shaped
  correctly. A scratch probe plugin that dumps event payloads is acceptable scaffolding during
  research but must not ship.
- **End-to-end (required for any trace-path change)** — `opencode run` a multi-turn, multi-tool
  session with an intentional tool failure; fetch the newest trace from the Langfuse API; assert
  usage, costDetails, error level on the failing tool, and all five trace scores. Exact command and
  observed result recorded; skipped verification is reported as unverified, never passing.
